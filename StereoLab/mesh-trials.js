import {makeBackgroundLiquid, liquidFragment} from './background-liquid.mjs';
import {makeElasticGrid, elasticVertex} from './elastic-grid.mjs';
import {EdgeSplat} from './edge-splat.mjs';
import {depthIndex} from './quality-trials-core.mjs';
import {fullscreenVertex, pixelFragment, meshVertex, meshFragment} from './mesh-shaders.mjs';
const $ = id => document.getElementById(id);
const canvas = $('screen'), video = $('source');
const gl = canvas.getContext('webgl2', {antialias: false, depth: true, preserveDrawingBuffer: true});
let manifest, maps, ready = false, frame = 0, generation = 0;
const fail = error => { ready = false; video.pause(); $('status').textContent = `加载或渲染失败：${error.message}`; };
function program(vertex, fragment) {
    const p = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
        gl.attachShader(p, shader); gl.deleteShader(shader);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
    return p;
}
let pixel, mesh, edge, elastic, elasticTexture, elasticCacheKey;
let elasticGrid, liquid, liquidTexture, liquidCacheKey;
const frameCount = () => manifest.clips[Number($('clip').value)].frames || manifest.frames;
function draw() {
    if (!ready || video.readyState < 2) return;
    const profile = manifest.profiles.find(p => p.id === $('profile').value);
    const data = maps[profile.id], index = depthIndex(frame, profile, data.count);
    const strength = Math.max(0, Math.min(2, Number($('strength').value)));
    $('strength-value').value = `${strength.toFixed(2)}× · ${$('strategy').value === 'elastic' ? '参考幅度' : '每眼最大'} ${(15.36 * strength).toFixed(1)} px`;
    const view = $('view').value, strategy = $('strategy').value;
    $('edge-controls').hidden = strategy !== 'edge' && view !== 'aligned';
    $('edge-explanation').hidden = strategy !== 'edge' && view !== 'aligned';
    $('threshold').disabled = strategy !== 'cut';
    $('mesh-density').disabled = strategy !== 'elastic';
    const width = view === 'sbs' ? 3840 : 1920;
    if (canvas.width !== width) canvas.width = width;
    gl.activeTexture(gl.TEXTURE1); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const size = profile.width * profile.height;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, profile.width, profile.height, 0, gl.RED, gl.UNSIGNED_BYTE, data.bytes.subarray(index * size, (index + 1) * size));
    gl.activeTexture(gl.TEXTURE0); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    const useEdge = strategy === 'edge' && !['depth', 'source', 'aligned'].includes(view);
    if (useEdge || view === 'aligned') edge.prepare($('align-edges').checked);
    $('liquid-controls').hidden = strategy !== 'liquid';
    const useLiquid = strategy === 'liquid' && !['depth','source','aligned'].includes(view);
    if(useLiquid){
        const feather=Number($('liquid-feather').value),amount=Number($('liquid-amount').value);
        $('liquid-values').textContent=`羽化 ${feather} px · 拉伸 ${Math.round(amount*100)}%`;
        const key=`${generation}:${profile.id}:${index}:${strength}:${feather}:${amount}`;
        if(key!==liquidCacheKey){
            const field=makeBackgroundLiquid(data.bytes.subarray(index*size,(index+1)*size),profile.width,profile.height,strength,feather,amount);
            gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,liquidTexture);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
            gl.texImage2D(gl.TEXTURE_2D,0,gl.RG16F,profile.width,profile.height,0,gl.RG,gl.FLOAT,field);liquidCacheKey=key;
        }
    }
    const useElastic = strategy === 'elastic' && !['depth', 'source', 'aligned'].includes(view);
    if (useElastic) {
        const key = `${generation}:${profile.id}:${index}:${strength}:${$('mesh-density').value}`;
        if (key !== elasticCacheKey) {
            const columns = Number($('mesh-density').value), rows = Math.round((columns-1)*1080/1920)+1;
            elasticGrid = makeElasticGrid(data.bytes.subarray(index*size,(index+1)*size),profile.width,profile.height,strength,columns,rows);
            gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D,elasticTexture); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
            gl.texImage2D(gl.TEXTURE_2D,0,gl.RG32F,columns,rows,0,gl.RG,gl.FLOAT,elasticGrid.targets);
            elasticCacheKey=key;
        }
    }
    const useMesh = ['mesh', 'cut'].includes(strategy) && !['depth', 'source', 'aligned'].includes(view);
    const p = useLiquid ? liquid : useElastic ? elastic : useMesh ? mesh : pixel;
    gl.useProgram(p);
    const loc = name => gl.getUniformLocation(p, name);
    gl.uniform1f(loc('strength'), strength);
    gl.uniform1i(loc('liquidMap'),6);gl.uniform1i(loc('debugLiquid'),$('liquid-debug').checked?1:0);
    gl.uniform1i(loc('video'), 0); gl.uniform1i(loc('depthMap'), 1);
    gl.clearColor(.28, .02, .3, useElastic ? 0 : 1); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (useElastic) {
        gl.disable(gl.DEPTH_TEST);
        gl.uniform1i(loc('elasticMap'),5);
        gl.uniform2i(loc('grid'),elasticGrid.columns,elasticGrid.rows);
    } else if (useMesh) {
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
        gl.uniform2i(loc('grid'), profile.width, profile.height);
        gl.uniform1f(loc('threshold'), strategy === 'cut' ? Number($('threshold').value) : 2);
    } else {
        gl.disable(gl.DEPTH_TEST); gl.uniform1i(loc('depthOnly'), view === 'depth' ? 1 : 0);
    }
    for (let eye = 0; eye < (view === 'sbs' ? 2 : 1); eye++) {
        if (view === 'aligned') { edge.showDepth(); continue; }
        if (useEdge) { edge.draw(eye === 0 ? 1 : -1, eye * 1920, $('fill-holes').checked, Number($('lanes').value), strength); continue; }
        gl.viewport(eye * 1920, 0, 1920, 1080);
        gl.uniform1f(loc('eye'), view === 'source' ? 0 : eye === 0 ? 1 : -1);
        gl.drawArrays(gl.TRIANGLES, 0, useElastic ? (elasticGrid.columns-1)*(elasticGrid.rows-1)*6 : useMesh ? (profile.width - 1) * (profile.height - 1) * 6 : 3);
    }
    canvas.dataset.ready = 'true'; canvas.dataset.frame = frame; canvas.dataset.depthIndex = index;
    $('seek').value = frame;
    $('status').textContent = `视频帧 ${frame} / ${frameCount() - 1} · 深度帧 ${index} · ${profile.width}×${profile.height} · 每眼 1920×1080 · ${useLiquid ? '背景局部液化 · 未覆盖处保留原始填充' : useElastic ? '弹性网格：全覆盖，无补洞' : '紫色为空洞（未补区域）'}`;
}
async function load() {
    const token = ++generation;
    ready = false; canvas.dataset.ready = 'false'; video.pause(); $('status').textContent = '加载并校验片源深度…';
    const clip = manifest.clips[Number($('clip').value)];
    const entries = await Promise.all(manifest.profiles.map(async p => {
        const d = clip.data[p.id], response = await fetch(d.url);
        if (!response.ok) throw Error('深度文件不可用');
        const buffer = await response.arrayBuffer();
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(v => v.toString(16).padStart(2, '0')).join('');
        if (buffer.byteLength !== p.width * p.height * d.count || hash !== d.sha256) throw Error('深度校验失败');
        return [p.id, {count: d.count, bytes: new Uint8Array(buffer)}];
    }));
    if (token !== generation) return;
    maps = Object.fromEntries(entries);
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(Error('视频加载失败')); video.src = clip.source; video.load(); });
    if (token !== generation) return;
    frame = 0; $('seek').max=frameCount()-1; ready = true; draw();
}
function callback(_now, meta) {
    if (ready && !video.paused) {
        const clip = manifest.clips[Number($('clip').value)];
        if (meta.mediaTime >= clip.duration - .5 / clip.fps) video.currentTime = 0;
        else { frame = Math.min(frameCount() - 1, Math.max(0, Math.round(meta.mediaTime * clip.fps))); draw(); }
    }
    video.requestVideoFrameCallback(callback);
}
$('clip').onchange = () => load().catch(fail);
for (const id of ['profile', 'strategy', 'view', 'threshold', 'align-edges', 'fill-holes', 'lanes', 'strength', 'mesh-density', 'liquid-feather', 'liquid-amount', 'liquid-debug']) $(id).oninput = () => {
    $('threshold-value').value = $('threshold').value;
    if ($('view').value === 'sbs') { $('zoom').value = '1'; canvas.style.transform = ''; }
    $('zoom').disabled = $('view').value === 'sbs'; draw();
};
$('play').onclick = () => { if (ready) { if (video.paused) video.play().catch(fail); else video.pause(); } };
$('restart').onclick = () => { if (ready) video.currentTime = 0; };
$('seek').oninput = () => { if (ready) { video.pause(); video.currentTime = Number($('seek').value) / manifest.clips[Number($('clip').value)].fps; } };
video.addEventListener('ended',()=>{if(ready){video.currentTime=0;video.play().catch(fail);}});
video.addEventListener('seeked',()=>{if(ready){frame=Math.min(frameCount()-1,Math.round(video.currentTime*manifest.clips[Number($('clip').value)].fps));draw();}});
$('zoom').onchange = () => { canvas.style.transform = `scale(${$('zoom').value})`; };
canvas.onclick = e => { const r = canvas.parentElement.getBoundingClientRect(); canvas.style.transformOrigin = `${100 * (e.clientX-r.left)/r.width}% ${100 * (e.clientY-r.top)/r.height}%`; };
$('fullscreen').onclick = () => $('viewer').requestFullscreen().catch(fail);
canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); fail(Error('图形上下文丢失，请刷新')); });
try {
    if (!gl || !video.requestVideoFrameCallback) throw Error('需要 WebGL 2 和视频帧回调支持');
    liquid=program(fullscreenVertex,liquidFragment);
    liquidTexture=gl.createTexture();gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,liquidTexture);
    for(const k of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,k,gl.LINEAR);
    for(const k of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,k,gl.CLAMP_TO_EDGE);
    pixel = program(fullscreenVertex, pixelFragment); mesh = program(meshVertex, meshFragment);
    for (let i = 0; i < 2; i++) {
        gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
        for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.LINEAR);
        for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
    }
    edge = new EdgeSplat(gl, program);
    elastic = program(elasticVertex, meshFragment);
    elasticTexture=gl.createTexture();gl.activeTexture(gl.TEXTURE5);gl.bindTexture(gl.TEXTURE_2D,elasticTexture);
    for(const k of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,k,gl.NEAREST);
    for(const k of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,k,gl.CLAMP_TO_EDGE);
    const response = await fetch('/samples/quality-p02-p98/manifest.json');
    if (!response.ok) throw Error('缺少 2%／98% 本地样本');
    manifest = await response.json();
    const extra=await fetch('/samples/quality-motion/manifest.json');
    if(extra.ok){const motion=await extra.json();manifest.clips.push(...motion.clips.map(c=>({...c,frames:motion.frames})));}
    $('clip').replaceChildren(...manifest.clips.map((c, i) => new Option(c.label || `片段 ${i+1}`, i)));
    if(extra.ok)$('clip').value=String(manifest.clips.length-1);
    $('profile').replaceChildren(...manifest.profiles.map(p => new Option(p.label, p.id)));
    $('profile').value = 'p2'; $('seek').max = frameCount() - 1;
    await load(); video.requestVideoFrameCallback(callback);
} catch (error) { fail(error); }
