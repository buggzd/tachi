import { GRID_WIDTH, GRID_HEIGHT, DepthTracker, summarize } from './core.js';
import { StereoRenderer } from './renderer.js';
const video = document.querySelector('#source'), canvas = document.querySelector('#output');
const tracker = new DepthTracker(), renderer = new StereoRenderer(canvas);
let worker = new Worker(new URL('./depth-worker.js', import.meta.url), { type: 'module' });
const thumb = new OffscreenCanvas(GRID_WIDTH, GRID_HEIGHT), tc = thumb.getContext('2d', { willReadFrequently: true });
const capture = new OffscreenCanvas(518, 294), cc = capture.getContext('2d', { willReadFrequently: true });
const state = { model: 'not-loaded', device: null, frames: 0, inferred: 0, accepted: 0, rejected: 0,
    activeStereoFrames: 0, processingMs: [], inferenceMs: [], depthAgeMs: [], started: null, busy: false, errors: 0,
    missedVideoCallbacks: 0, lastPresented: null, playedSeconds: 0, lastMedia: null, busySince: 0, lastInferStart: -Infinity, sceneCuts: 0,
    captureMs: [], inferenceCaptureMs: [], motionMs: [], debugMs: [], renderMs: [],
    motionFromModelFrames: 0, motionThumbnailFrames: 0 };
const options = new URLSearchParams(location.search);
const dtype = options.get('dtype') === 'fp32' ? 'fp32' : 'fp16';
const debugEnabled = options.get('debug') !== '0';
const renderEnabled = options.get('render') !== '0';
const motionEnabled = options.get('motion') !== '0';
const syncGpu = options.get('syncGpu') === '1';
const requestedInferInterval = Number(options.get('inferInterval'));
const inferIntervalMs = Number.isFinite(requestedInferInterval) ? Math.max(0, Math.min(1000, requestedInferInterval)) : 0;
if (['266', '378', '518'].includes(options.get('input'))) document.querySelector('#input').value = options.get('input');
if (!debugEnabled) document.querySelector('.debug').hidden = true;
let qualityStart = { totalVideoFrames: 0, droppedVideoFrames: 0 };
const push = (list, v) => { list.push(v); if (list.length > 3600) list.shift(); };
const estimatedContext = document.querySelector('#estimated-depth').getContext('2d');
const stableContext = document.querySelector('#stable-depth').getContext('2d');
let lastObservation = null;
function grayscaleFromRgba(rgba, width, height) {
    const gray = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
    for (let y = 0; y < GRID_HEIGHT; y++) {
        const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / GRID_HEIGHT));
        for (let x = 0; x < GRID_WIDTH; x++) {
            const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / GRID_WIDTH));
            const source = (sourceY * width + sourceX) * 4;
            gray[y * GRID_WIDTH + x] = (rgba[source] * 77 + rgba[source + 1] * 150 + rgba[source + 2] * 29) >> 8;
        }
    }
    return gray;
}
function paintDepth(context, values) {
    const pixels = context.createImageData(GRID_WIDTH, GRID_HEIGHT);
    for (let i = 0; i < GRID_WIDTH * GRID_HEIGHT; i++) {
        const value = values ? Math.round(Math.max(0, Math.min(1, values[i])) * 255) : 0;
        pixels.data[i * 4] = pixels.data[i * 4 + 1] = pixels.data[i * 4 + 2] = value;
        pixels.data[i * 4 + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
}
function drawDepthDebug() {
    if (!debugEnabled) return;
    if (tracker.observation !== lastObservation) {
        paintDepth(estimatedContext, tracker.observation?.depth);
        lastObservation = tracker.observation;
    }
    paintDepth(stableContext, Number.isFinite(tracker.observedAt) ? tracker.depth : null);
    document.querySelector('#estimated-time').textContent = tracker.observation
        ? `视频时间 ${tracker.observation.time.toFixed(3)}s · 白近 / 黑远` : '等待深度估计';
    document.querySelector('#stable-time').textContent = Number.isFinite(tracker.observedAt)
        ? `视频时间 ${tracker.time.toFixed(3)}s · 深度年龄 ${Math.round((tracker.time - tracker.observedAt) * 1000)}ms · 强度 ${Math.round(tracker.strength() * 100)}%`
        : '暂无有效深度 · 平面回退';
}
function report() {
    const quality = video.getVideoPlaybackQuality();
    return { scope: /Android/.test(navigator.userAgent) ? 'android-browser-experiment' : 'desktop-browser-experiment', model: state.model, backend: state.device, dtype,
        modelInputWidth: capture.width, modelInputHeight: capture.height,
        depthTensorType: state.depthTensorType ?? null,
        eyeWidth: renderer.params.width, eyeHeight: renderer.params.height,
        sourceWidth: video.videoWidth, sourceHeight: video.videoHeight,
        frames: state.frames, inferenceCount: state.inferred, acceptedDepthCount: state.accepted,
        rejectedDepthCount: state.rejected, activeStereoFrames: state.activeStereoFrames,
        missedVideoCallbacks: state.missedVideoCallbacks,
        wallSeconds: state.started ? (performance.now() - state.started) / 1000 : 0,
        totalVideoFrames: quality.totalVideoFrames - qualityStart.totalVideoFrames,
        droppedVideoFrames: quality.droppedVideoFrames - qualityStart.droppedVideoFrames,
        videoTimeSeconds: state.playedSeconds,
        processingMs: summarize(state.processingMs), captureMs: summarize(state.captureMs), inferenceCaptureMs: summarize(state.inferenceCaptureMs), motionMs: summarize(state.motionMs),
        debugMs: summarize(state.debugMs), renderMs: summarize(state.renderMs), inferenceMs: summarize(state.inferenceMs),
        motionFromModelFrames: state.motionFromModelFrames, motionThumbnailFrames: state.motionThumbnailFrames,
        gpuMs: summarize(renderer.gpuMs), gpuTimerSupported: Boolean(renderer.timer), syncGpu, renderEnabled, motionEnabled, debugEnabled,
        inferIntervalMs,
        depthAgeMs: summarize(state.depthAgeMs), temporalDepthInnovation: tracker.temporalError,
        sceneCuts: state.sceneCuts, errors: state.errors, videoCount: document.querySelectorAll('video').length };
}
function configure() {
    const width = Number(document.querySelector('#resolution').value);
    renderer.configure({ width, height: width * 9 / 16, amplitude: Number(document.querySelector('#amplitude').value) });
    draw();
}
function draw(measure = false) {
    const debugStart = measure ? performance.now() : 0;
    drawDepthDebug();
    if (measure) push(state.debugMs, performance.now() - debugStart);
    const renderStart = measure ? performance.now() : 0;
    if (renderEnabled && video.readyState >= 2) renderer.render(video, tracker.depth, GRID_WIDTH, GRID_HEIGHT,
        { strength: tracker.strength(), showDepth: document.querySelector('#depth').checked, syncGpu });
    if (measure) push(state.renderMs, performance.now() - renderStart);
}
function resetMetrics() {
    state.frames = state.inferred = state.accepted = state.rejected = state.activeStereoFrames = 0;
    state.processingMs = []; state.captureMs = []; state.inferenceCaptureMs = []; state.motionMs = []; state.debugMs = []; state.renderMs = [];
    state.inferenceMs = []; state.depthAgeMs = []; renderer.gpuMs = [];
    state.motionFromModelFrames = 0; state.motionThumbnailFrames = 0;
    state.started = performance.now();
    state.missedVideoCallbacks = 0; state.lastPresented = null; state.lastInferStart = -Infinity;
    state.playedSeconds = 0; state.lastMedia = null; state.sceneCuts = 0;
    qualityStart = video.getVideoPlaybackQuality();
}
function frame(now, metadata) {
    const start = performance.now();
    if (!state.started) state.started = start;
    if (state.lastPresented !== null) state.missedVideoCallbacks += Math.max(0, metadata.presentedFrames - state.lastPresented - 1);
    state.lastPresented = metadata.presentedFrames;
    if (state.lastMedia !== null && metadata.mediaTime >= state.lastMedia)
        state.playedSeconds += Math.min(0.5, metadata.mediaTime - state.lastMedia);
    state.lastMedia = metadata.mediaTime;
    const shouldInfer = state.model === 'ready' && !state.busy && performance.now() - state.lastInferStart >= inferIntervalMs;
    let gray, inferencePixels, inferenceWidth, inferenceHeight;
    const captureStart = performance.now();
    if (shouldInfer) {
        capture.width = Number(document.querySelector('#input').value);
        capture.height = Math.max(14, Math.round(capture.width * video.videoHeight / video.videoWidth / 14) * 14);
        cc.drawImage(video, 0, 0, capture.width, capture.height);
        inferencePixels = cc.getImageData(0, 0, capture.width, capture.height).data;
        inferenceWidth = capture.width; inferenceHeight = capture.height;
        gray = grayscaleFromRgba(inferencePixels, inferenceWidth, inferenceHeight);
        state.motionFromModelFrames++;
    } else {
        tc.drawImage(video, 0, 0, GRID_WIDTH, GRID_HEIGHT);
        const rgba = tc.getImageData(0, 0, GRID_WIDTH, GRID_HEIGHT).data;
        gray = grayscaleFromRgba(rgba, GRID_WIDTH, GRID_HEIGHT);
        state.motionThumbnailFrames++;
    }
    push(state.captureMs, performance.now() - captureStart);
    const previousCuts = tracker.cuts;
    const motionStart = performance.now();
    tracker.advance(gray, metadata.mediaTime, { motion: motionEnabled });
    push(state.motionMs, performance.now() - motionStart);
    state.sceneCuts += Math.max(0, tracker.cuts - previousCuts);
    if (shouldInfer) {
        const rgb = new Uint8ClampedArray(inferenceWidth * inferenceHeight * 3);
        for (let i = 0; i < rgb.length / 3; i++) {
            rgb[i * 3] = inferencePixels[i * 4]; rgb[i * 3 + 1] = inferencePixels[i * 4 + 1]; rgb[i * 3 + 2] = inferencePixels[i * 4 + 2];
        }
        push(state.inferenceCaptureMs, performance.now() - captureStart);
        state.busy = true; state.busySince = performance.now(); state.lastInferStart = state.busySince;
        worker.postMessage({ type: 'infer', pixels: rgb.buffer, width: inferenceWidth, height: inferenceHeight,
            time: metadata.mediaTime, generation: tracker.generation }, [rgb.buffer]);
    }
    draw(true); state.frames++;
    if (tracker.strength() > 0.01) state.activeStereoFrames++;
    if (Number.isFinite(tracker.observedAt)) push(state.depthAgeMs, (tracker.time - tracker.observedAt) * 1000);
    push(state.processingMs, performance.now() - start);
    video.requestVideoFrameCallback(frame);
}
function failModel() {
    state.model = 'error'; state.busy = false; state.errors++; worker.terminate(); tracker.reset(); draw();
}
function attachWorker() {
worker.onmessage = ({ data }) => {
    if (data.type === 'ready') { state.model = 'ready'; state.device = data.device; }
    if (data.type === 'depth') {
        state.depthTensorType = data.outputType;
        state.busy = false; state.inferred++; push(state.inferenceMs, data.inferenceMs);
        if (tracker.observe(data.depth, data.time, data.generation)) state.accepted++; else state.rejected++;
        if (video.paused) draw();
    }
    if (data.type === 'error') failModel();
};
worker.onerror = failModel;
}
attachWorker();
document.querySelector('#load').onclick = () => {
    if (!['not-loaded', 'error'].includes(state.model)) return;
    if (state.model === 'error') { worker = new Worker(new URL('./depth-worker.js', import.meta.url), { type: 'module' }); attachWorker(); }
    state.model = 'loading'; worker.postMessage({ type: 'load', device: 'webgpu', dtype });
};
document.querySelector('#play').onclick = () => video.paused ? video.play() : video.pause();
document.querySelector('#resolution').onchange = configure;
document.querySelector('#amplitude').oninput = configure;
document.querySelector('#depth').onchange = draw;
video.addEventListener('seeking', () => { tracker.reset(); state.lastMedia = null; drawDepthDebug(); });
video.addEventListener('loadeddata', draw);
document.querySelector('#export').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report(), null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'stereo-metrics.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
try {
    const response = await fetch('/samples/manifest.json');
    if (!response.ok) throw new Error();
    const samples = await response.json(), select = document.querySelector('#sample');
    for (const sample of samples) {
        if (!/^clip-[0-4]\.mp4$/.test(sample.file)) continue;
        const option = document.createElement('option'); option.value = sample.file;
        option.textContent = `${sample.label} · ${sample.width}×${sample.height}`; select.append(option);
    }
    select.onchange = () => { video.pause(); tracker.reset(); video.src = '/samples/' + select.value; resetMetrics(); };
    if (select.options.length) select.onchange();
} catch { document.querySelector('#status').textContent = '尚无本地测试片段。请运行 npm run samples。'; }
video.requestVideoFrameCallback(frame);
setInterval(() => {
    if (state.busy && performance.now() - state.busySince > 5000) failModel();
    document.querySelector('#status').textContent = JSON.stringify(report(), null, 2);
}, 1000);
window.stereoLab = { report, resetMetrics, tracker, renderer, state, video };
window.addEventListener('pagehide', () => { worker.terminate(); renderer.dispose(); video.pause(); });
