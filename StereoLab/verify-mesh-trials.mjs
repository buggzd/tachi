import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(process.argv[2] || 'http://127.0.0.1:4190/mesh-trials.html');
    await page.waitForSelector('canvas[data-ready="true"]');
    for (let clip = 0; clip < 3; clip++) {
        if (clip) { await page.selectOption('#clip', String(clip)); await page.waitForSelector('canvas[data-ready="true"]'); }
        await page.click('#play');
        await page.waitForFunction(() => Number(document.querySelector('canvas').dataset.frame) >= 12);
        await page.click('#play');
        await page.waitForTimeout(100);
        const frame = await page.locator('canvas').getAttribute('data-frame');
        const images = [];
        for (const strategy of ['pixel', 'mesh', 'cut']) {
            await page.selectOption('#strategy', strategy);
            assert.equal(await page.locator('canvas').getAttribute('data-frame'), frame);
            images.push(await page.evaluate(() => document.querySelector('canvas').toDataURL()));
            assert.equal(await page.evaluate(() => document.querySelector('canvas').getContext('webgl2').getError()), 0);
        }
        assert.notEqual(images[0], images[1]);
        await page.selectOption('#view', 'sbs');
        assert.equal(await page.locator('canvas').getAttribute('width'), '3840');
        await page.selectOption('#view', 'depth');
        await page.selectOption('#view', 'source');
        await page.selectOption('#view', 'eye');
    }
    const geometry = await page.evaluate(async () => {
        const {meshVertex, meshFragment} = await import('/mesh-shaders.mjs');
        const c = document.createElement('canvas'); c.width = 64; c.height = 32;
        const gl = c.getContext('webgl2'); const p = gl.createProgram();
        for (const [type, source] of [[gl.VERTEX_SHADER, meshVertex], [gl.FRAGMENT_SHADER, meshFragment]]) {
            const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
            gl.attachShader(p, shader);
        }
        gl.linkProgram(p); gl.useProgram(p);
        const colors = new Uint8Array(64 * 32 * 4);
        for (let i = 0; i < 64 * 32; i++) colors.set([i % 64 * 4, Math.floor(i / 64) * 8, 80, 255], i * 4);
        for (let unit = 0; unit < 2; unit++) {
            gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            if (unit === 0) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 32, 0, gl.RGBA, gl.UNSIGNED_BYTE, colors);
            else { gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 2, 2, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0,255,0,255])); }
        }
        const loc = name => gl.getUniformLocation(p, name);
        gl.uniform1i(loc('video'), 0); gl.uniform1i(loc('depthMap'), 1);
        gl.uniform2i(loc('grid'), 2, 2); gl.uniform1f(loc('eye'), 0);
        gl.enable(gl.DEPTH_TEST); gl.viewport(0, 0, 64, 32);
        const render = threshold => {
            gl.uniform1f(loc('threshold'), threshold); gl.clearColor(1,0,1,1);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 6);
            const out = new Uint8Array(colors.length); gl.readPixels(0,0,64,32,gl.RGBA,gl.UNSIGNED_BYTE,out); return out;
        };
        const uncut = render(2), cut = render(.08);
        return {zeroEyeMaxError: Math.max(...uncut.map((v,i) => Math.abs(v-colors[i]))),
            cutAllHoles: cut.every((v,i) => v === [255,0,255,255][i%4]), error: gl.getError()};
    });
    assert.equal(geometry.zeroEyeMaxError, 0, 'projected source texture must reconstruct original at zero eye translation');
    assert.equal(geometry.cutAllHoles, true, 'depth discontinuity triangles must be rejected');
    assert.equal(geometry.error, 0);
    assert.deepEqual(errors, []);
    await page.screenshot({path: '.local/mesh-trials-preview.png'});
    console.log('PASS: three real clips, playback, paused strategy switching, SBS/depth/source, GL errors');
} finally { await browser.close(); }
