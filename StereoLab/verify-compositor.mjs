/** Isolate video upload + stereo reprojection/fill. This does not validate depth inference. */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const cdp = option('--cdp', 'http://127.0.0.1:9223'), url = option('--url', 'http://127.0.0.1:4188');
const seconds = Number(option('--seconds', 20)), syncGpu = args.includes('--sync-gpu');
const widths = option('--widths', '640,1280,1920').split(',').map(Number);
assert.ok(seconds >= 5 && seconds <= 120 && widths.every(w => [640, 1280, 1920].includes(w)));
const out = resolve(import.meta.dirname, '.local', `compositor-${Date.now()}`);
await mkdir(out, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '.local/samples/manifest.json'), 'utf8'));
const browser = await chromium.connectOverCDP(cdp);
const page = await browser.contexts()[0].newPage();
const report = { schema: 1, scope: 'compositor-isolation', startedAt: new Date().toISOString(), browser: await browser.version(),
    npuValidated: false, implementationSha256: {}, samples: [] };
for (const file of ['renderer.js', 'core.js', 'tests/render-throughput.html', 'verify-compositor.mjs'])
    report.implementationSha256[file] = createHash('sha256').update(await readFile(resolve(import.meta.dirname, file))).digest('hex');
try {
    await page.goto(url + '/tests/render-throughput.html');
    await page.bringToFront();
    await page.waitForFunction(() => typeof window.runRenderBenchmark === 'function');
    report.userAgent = await page.evaluate(() => navigator.userAgent);
    assert.match(report.userAgent, /Android/);
    for (const width of widths) for (let index = 0; index < manifest.length; index++) {
        const sample = manifest[index];
        let watchdog;
        const metrics = await Promise.race([
            page.evaluate(options => window.runRenderBenchmark(options), { sample: sample.file, width, seconds, syncGpu }),
            new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Compositor benchmark timed out')), (seconds + 120) * 1000); }),
        ]).finally(() => clearTimeout(watchdog));
        const [n, d] = sample.fps.split('/').map(Number);
        metrics.sample = index + 1; metrics.expectedFps = n / d;
        metrics.passed = metrics.callbackFps >= n / d * 0.9 && metrics.glError === 0 && metrics.hiddenFrames === 0
            && metrics.nonblackSamples > 0 && metrics.sceneDepthPixelEffect > 0
            && metrics.droppedVideoFrames / Math.max(1, metrics.totalVideoFrames) < 0.02;
        report.samples.push(metrics);
        await writeFile(resolve(out, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
        await page.locator('canvas').screenshot({ path: resolve(out, `eye-${width}-sample-${index + 1}.png`) });
        console.log(JSON.stringify(metrics));
    }
    report.passed = report.samples.every(sample => sample.passed);
    await writeFile(resolve(out, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Evidence: ' + out);
    if (!report.passed) process.exitCode = 1;
} catch (error) {
    report.passed = false; report.error = 'Benchmark execution failed; inspect local runner output';
    await writeFile(resolve(out, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
    throw error;
} finally { await page.close(); await browser.close(); }
