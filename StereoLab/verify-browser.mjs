/** Hardware-backed browser checks. Actual media and screenshots remain local;
 * the report contains only technical fields. No offline precomputed depth. */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = import.meta.dirname, args = process.argv.slice(2);
const option = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const seconds = Number(option('--seconds', 12)), width = Number(option('--width', 1920));
const input = Number(option('--input', 266)), dtype = option('--dtype', 'fp16');
const debug = option('--debug', '1') !== '0';
const inferInterval = Number(option('--inferInterval', 0));
const syncGpu = option('--syncGpu', '0') === '1';
const render = option('--render', '1') !== '0';
const motion = option('--motion', '1') !== '0';
const cdp = option('--cdp', null), externalUrl = option('--url', null);
if (Boolean(cdp) !== Boolean(externalUrl)) throw new Error('--cdp and --url must be supplied together');
const geometryOnly = args.includes('--geometry-only');
if (!Number.isFinite(seconds) || seconds < 5 || seconds > 300 || !Number.isFinite(inferInterval) || inferInterval < 0 || inferInterval > 1000
    || ![640, 1280, 1920].includes(width)
    || ![266, 378, 518].includes(input) || !['fp16', 'fp32'].includes(dtype)) throw new Error('Invalid verification options');
const out = resolve(root, '.local', `verification-${cdp ? 'android-' : ''}${width}-${input}-${dtype}-${seconds}s`);
let server, browser, attachedPage;
try {
    await mkdir(out, { recursive: true });
    if (!cdp) server = await createServer({ root, configFile: resolve(root, 'vite.config.js'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
    if (server) await server.listen();
    const url = externalUrl || `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = cdp ? await chromium.connectOverCDP(cdp) : await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu',
        ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    const page = cdp ? await browser.contexts()[0].newPage() : await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    if (cdp) attachedPage = page;
    const pageErrors = []; page.on('pageerror', () => pageErrors.push('page-error'));
    await page.goto(url + '/tests/renderer.html');
    await page.waitForFunction(() => typeof window.runGeometryTests === 'function');
    const geometry = await page.evaluate(() => window.runGeometryTests());
    console.log('Geometry:', JSON.stringify(geometry));
    await page.locator('canvas').screenshot({ path: resolve(out, 'synthetic-sbs.png') });
    const report = { schema: 1, browser: await browser.version(), scope: cdp ? 'android-chrome-browser' : 'desktop-browser', userAgent: await page.evaluate(() => navigator.userAgent), geometry, samples: [] };
    if (!geometryOnly) {
        await page.goto(`${url}/?input=${input}&dtype=${dtype}&debug=${debug ? 1 : 0}&inferInterval=${inferInterval}&syncGpu=${syncGpu ? 1 : 0}&render=${render ? 1 : 0}&motion=${motion ? 1 : 0}`);
        await page.selectOption('#resolution', String(width));
        await page.selectOption('#input', String(input));
        await page.click('#load');
        await page.waitForFunction(() => ['ready', 'error'].includes(window.stereoLab?.state.model), {}, { timeout: 180000 });
        assert.equal(await page.evaluate(() => window.stereoLab.state.model), 'ready', 'Real depth model must load');
        const manifest = JSON.parse(await readFile(resolve(root, '.local/samples/manifest.json'), 'utf8'));
        for (let index = 0; index < manifest.length; index++) {
            await page.selectOption('#sample', manifest[index].file);
            await page.waitForFunction(() => window.stereoLab.video.readyState >= 2);
            await page.evaluate(() => { window.stereoLab.video.currentTime = 0; return window.stereoLab.video.play(); });
            // Warm graph compilation and discard initial model/upload latency.
            await page.waitForFunction(() => window.stereoLab.state.accepted >= 5, {}, { timeout: 90000 });
            await page.waitForTimeout(1000);
            await page.evaluate(() => window.stereoLab.resetMetrics());
            // Sample in short intervals so progress is visible during longer runs.
            const end = Date.now() + seconds * 1000;
            while (Date.now() < end) await page.waitForTimeout(Math.min(1000, end - Date.now()));
            const metrics = await page.evaluate(() => { window.stereoLab.video.pause(); return window.stereoLab.report(); });
            metrics.scope = report.scope;
            assert.equal(metrics.modelInputWidth, input, 'Measured model input must match requested tier');
            metrics.sample = index + 1; metrics.expectedFps = manifest[index].fps;
            metrics.callbackFps = metrics.frames / metrics.wallSeconds;
            metrics.activeStereoFraction = metrics.activeStereoFrames / metrics.frames;
            report.samples.push(metrics);
            // Save even a failed benchmark; failure is evidence, not a reason to discard results.
            await writeFile(resolve(out, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
            console.log('Sample:', JSON.stringify(metrics));
            assert.equal(metrics.model, 'ready'); assert.equal(metrics.errors, 0);
            assert.equal(metrics.videoCount, 1);
            assert.ok(metrics.acceptedDepthCount >= 5, 'No live depth updates');

            const [a, b] = metrics.expectedFps.split('/').map(Number);
            metrics.performancePassed = metrics.activeStereoFraction > 0.8
                && metrics.callbackFps >= a / b * 0.90
                && metrics.droppedVideoFrames / Math.max(1, metrics.totalVideoFrames) < 0.02;
            if (render) {
            // Let the sole outstanding inference settle before checking pause behavior.
            await page.waitForFunction(() => !window.stereoLab.state.busy, {}, { timeout: 10000 });
            const snapshot = await page.evaluate(() => {
                const lab = window.stereoLab, a = Array.from(lab.tracker.depth).sort((x, y) => x - y);
                const rgb = lab.renderer.readPixels(); let difference = 0;
                const w = lab.renderer.params.width, h = lab.renderer.params.height;
                for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) for (let c = 0; c < 3; c++)
                    difference += Math.abs(rgb[(y * w * 2 + x) * 4 + c] - rgb[(y * w * 2 + x + w) * 4 + c]);
                // Compare against the same screen-plane disparity without scene
                // depth: non-identical eyes alone could just be a shifted plane.
                lab.renderer.render(lab.video, lab.tracker.depth, 96, 54, { strength: 0 });
                const flat = lab.renderer.readPixels(); let sceneEffect = 0;
                for (let i = 0; i < rgb.length; i += 16) sceneEffect += Math.abs(rgb[i] - flat[i]);
                lab.renderer.render(lab.video, lab.tracker.depth, 96, 54, { strength: lab.tracker.strength() });
                const map = document.querySelector('#estimated-depth').getContext('2d').getImageData(0, 0, 96, 54).data;
                let lo = 255, hi = 0;
                for (let i = 0; i < map.length; i += 4) { lo = Math.min(lo, map[i]); hi = Math.max(hi, map[i]); }
                return { normalizedDepthSpread: a[Math.floor(a.length * 0.95)] - a[Math.floor(a.length * 0.05)],
                    stereoDifference: difference, sceneDepthPixelEffect: sceneEffect, debugDepthRange: hi - lo,
                    frames: lab.state.frames, time: lab.video.currentTime };
            });
            assert.ok(snapshot.normalizedDepthSpread > 0.05, 'Model output must contain scene depth variation');
            assert.ok(snapshot.stereoDifference > 0, 'Eye images must differ');
            assert.ok(snapshot.sceneDepthPixelEffect > 0, 'Scene depth must change pixels beyond a flat-screen shift');
            if (debug) assert.ok(snapshot.debugDepthRange > 10, 'Debug must display the actual nonuniform model depth');
            await page.locator('#output').screenshot({ path: resolve(out, `sample-${index + 1}-sbs.png`) });
            if (debug) await page.locator('.debug').screenshot({ path: resolve(out, `sample-${index + 1}-debug.png`) });
            await page.check('#depth');
            await page.locator('#output').screenshot({ path: resolve(out, `sample-${index + 1}-depth.png`) });
            await page.uncheck('#depth');
            await page.waitForTimeout(500);
            assert.deepEqual(await page.evaluate(() => ({ frames: window.stereoLab.state.frames, time: window.stereoLab.video.currentTime })),
                { frames: snapshot.frames, time: snapshot.time }, 'Pause should stop source and output progression');
            const generation = await page.evaluate(() => window.stereoLab.tracker.generation);
            await page.evaluate(() => { window.stereoLab.video.currentTime = 1; });
            await page.waitForFunction(g => window.stereoLab.tracker.generation > g, generation);
            assert.ok(await page.evaluate(() => {
                const lab = window.stereoLab;
                return !Number.isFinite(lab.tracker.observedAt) || Math.abs(lab.tracker.observedAt - lab.video.currentTime) < 0.1;
            }), 'Seek must invalidate old depth; an already completed observation may only belong to the new time');
            metrics.functional = { ...snapshot, pause: true, seekInvalidatesDepth: true };
            }
        }
    }
    assert.equal(pageErrors.length, 0);
    report.functionalPassed = render;
    report.functionalChecksSkipped = !render;
    report.passed = report.samples.every(sample => sample.performancePassed);
    await writeFile(resolve(out, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
    assert.ok(report.passed, 'Functional checks passed, but realtime performance threshold failed; see metrics.json');
    console.log('PASS: geometry' + (geometryOnly ? '' : ', live model, all media samples, throughput, pause, and seek'));
} finally {
    if (attachedPage) await attachedPage.close();
    if (browser) await browser.close();
    if (server) await server.close();
}
