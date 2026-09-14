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
        for (const strategy of ['elastic', 'pixel', 'mesh', 'cut', 'edge']) {
            await page.selectOption('#strategy', strategy);
            assert.equal(await page.locator('canvas').getAttribute('data-frame'), frame);
            images.push(await page.evaluate(() => document.querySelector('canvas').toDataURL()));
            assert.equal(await page.evaluate(() => document.querySelector('canvas').getContext('webgl2').getError()), 0);
        }
        assert.notEqual(images[0], images[1]);
        assert.notEqual(images[0], images[4]);
        await page.uncheck('#fill-holes');
        const unfilled = await page.evaluate(() => document.querySelector('canvas').toDataURL());
        await page.check('#fill-holes');
        assert.notEqual(unfilled, await page.evaluate(() => document.querySelector('canvas').toDataURL()));
        await page.uncheck('#align-edges');
        await page.check('#align-edges');
        await page.selectOption('#lanes', '1');
        await page.selectOption('#lanes', '4');
        await page.selectOption('#view', 'sbs');
        assert.equal(await page.locator('canvas').getAttribute('width'), '3840');
        await page.selectOption('#view', 'depth');
        await page.selectOption('#view', 'aligned');
        await page.selectOption('#view', 'source');
        await page.selectOption('#view', 'eye');
        if (clip === 0) {
            const setStrength = async value => page.locator('#strength').evaluate((input, v) => {
                input.value = v; input.dispatchEvent(new Event('input', {bubbles:true}));
            }, String(value));
            await setStrength(0);
            await page.selectOption('#view', 'source');
            await page.evaluate(() => {
                const c=document.querySelector('canvas'),g=c.getContext('webgl2');
                window.zeroReference=new Uint8Array(c.width*c.height*4);
                g.readPixels(0,0,c.width,c.height,g.RGBA,g.UNSIGNED_BYTE,window.zeroReference);
            });
            await page.selectOption('#view', 'eye');
            for (const strategy of ['elastic','pixel','mesh','cut','edge']) {
                await page.selectOption('#strategy',strategy);
                const error = await page.evaluate(() => {
                    const c=document.querySelector('canvas'),g=c.getContext('webgl2'),out=new Uint8Array(window.zeroReference.length);
                    g.readPixels(0,0,c.width,c.height,g.RGBA,g.UNSIGNED_BYTE,out);
                    let max=0;for(let i=0;i<out.length;i++)max=Math.max(max,Math.abs(out[i]-window.zeroReference[i]));
                    return max;
                });
                assert.ok(error<=1, `${strategy} at zero strength must reconstruct source: ${error}`);
            }
            await setStrength(2);
            for (const strategy of ['elastic','pixel','mesh','cut','edge']) {
                await page.selectOption('#strategy', strategy);
                assert.equal(await page.evaluate(() => document.querySelector('canvas').getContext('webgl2').getError()),0);
            }
            await setStrength(1);
        }

    }
    await page.selectOption('#strategy','elastic');
    for(const density of ['97','193','385']){
        await page.selectOption('#mesh-density',density);
        const uncovered=await page.evaluate(()=>{
            const c=document.querySelector('canvas'),g=c.getContext('webgl2'),b=new Uint8Array(c.width*c.height*4);
            g.readPixels(0,0,c.width,c.height,g.RGBA,g.UNSIGNED_BYTE,b);
            let holes=0;for(let i=0;i<b.length;i+=4)if(b[i+3]!==255)holes++;
            return holes;
        });
        assert.equal(uncovered,0,'elastic mesh must cover the screen');
    }
    await page.selectOption('#mesh-density','193');
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
        gl.uniform1f(loc('strength'), 1);
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
    const edgeChecks = await page.evaluate(async () => {
        const {EdgeSplat} = await import('/edge-splat.mjs');
        const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
        const g = c.getContext('webgl2');
        const compile = (vs, fs) => {
            const p = g.createProgram();
            for (const [type, source] of [[g.VERTEX_SHADER, vs], [g.FRAGMENT_SHADER, fs]]) {
                const s = g.createShader(type); g.shaderSource(s, source); g.compileShader(s);
                if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw Error(g.getShaderInfoLog(s));
                g.attachShader(p, s);
            }
            g.linkProgram(p);
            if (!g.getProgramParameter(p, g.LINK_STATUS)) throw Error(g.getProgramInfoLog(p));
            return p;
        };
        // Near red rectangle on a far blue background; horizontal edges are exact.
        const rgb = new Uint8Array(1920 * 1080 * 4), depth = new Uint8Array(1920 * 1080);
        for (let y=0;y<1080;y++) for (let x=0;x<1920;x++) {
            const near=x>=800&&x<1120, i=y*1920+x;
            rgb.set(near?[255,0,0,255]:[0,0,255,255], i*4); depth[i]=near?230:25;
        }
        for (let unit=0;unit<2;unit++) {
            g.activeTexture(g.TEXTURE0+unit);g.bindTexture(g.TEXTURE_2D,g.createTexture());
            g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MIN_FILTER,g.NEAREST);
            g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MAG_FILTER,g.NEAREST);
            g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_S,g.CLAMP_TO_EDGE);
            g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_T,g.CLAMP_TO_EDGE);
            g.texImage2D(g.TEXTURE_2D,0,unit?g.R8:g.RGBA8,1920,1080,0,unit?g.RED:g.RGBA,g.UNSIGNED_BYTE,unit?depth:rgb);
        }
        const renderer=new EdgeSplat(g,compile);renderer.prepare(false);
        const row=()=>{const b=new Uint8Array(1920*4);g.readPixels(0,540,1920,1,g.RGBA,g.UNSIGNED_BYTE,b);return b;};
        renderer.draw(0,0,true,4); const zero=row();
        let zeroError=0;for(let x=0;x<1920*4;x++)zeroError=Math.max(zeroError,Math.abs(zero[x]-rgb[540*1920*4+x]));
        const results=[];
        for(const eye of [1,-1]) {
            renderer.draw(eye,0,false,4);const holes=row();
            renderer.draw(eye,0,true,4);const filled=row();
            let tested=0,redLeak=0;
            for(let x=760;x<1160;x++)if(holes[x*4]>140&&holes[x*4+2]>140){
                tested++;redLeak=Math.max(redLeak,filled[x*4]);
            }
            results.push({tested,redLeak});
        }
        return {zeroError,results,error:g.getError()};
    });
    assert.equal(edgeChecks.zeroError,0,'zero-disparity coverage must exactly reconstruct source');
    assert.equal(edgeChecks.error,0);
    for(const eye of edgeChecks.results){
        assert.ok(eye.tested>5,'fixture must expose an interior disocclusion');
        assert.equal(eye.redLeak,0,'background repair must not drag red foreground into blue background');
    }
    assert.deepEqual(errors, []);
    await page.screenshot({path: '.local/mesh-trials-preview.png'});
    console.log('PASS: three real clips, playback, paused strategy switching, SBS/depth/source, GL errors');
} finally { await browser.close(); }
