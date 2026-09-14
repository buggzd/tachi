"""Precompute actual Java depth variants for reproducible, blinded viewing; no phone timing claim."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import time
import cv2
import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'StereoLab/.local'
OUT = LOCAL / 'samples/quality-v1'
SOURCE = ROOT / 'AndroidApp/native-video/src/main/java/com/jellyfinforrayneo/video/TemporalDepth.java'
FRAMES = 96
cv2.setNumThreads(1)


def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def filters(folder, w, h, percentile_low=5, percentile_high=95):
    code = SOURCE.read_text()
    original = 'float nextLow = sorted[pixels / 20], nextHigh = sorted[pixels * 19 / 20];'
    if code.count(original) != 1:
        raise RuntimeError('Review normalization source before generating a variant')
    code = code.replace(original, f'float nextLow = sorted[pixels * {percentile_low} / 100], nextHigh = sorted[pixels * {percentile_high} / 100];')
    gate = 'if (!reset && Math.abs(value - previous[i]) < .12f)'
    if code.count(gate) != 1:
        raise RuntimeError('Production gate changed: review no-history ablation')
    (folder / 'TemporalDepth.java').write_text(code)
    (folder / 'NoHistoryDepth.java').write_text(code.replace('class TemporalDepth', 'class NoHistoryDepth').replace(gate, 'if (false)'))
    (folder / 'NativeVideoView.java').write_text(f'package com.jellyfinforrayneo.video; class NativeVideoView {{ static final int SAMPLE_WIDTH={w}, SAMPLE_HEIGHT={h}; }}')
    shutil.copy(ROOT / 'StereoLab/experiments/DepthFilterRunner.java', folder)
    subprocess.run([str(Path(os.environ['JAVA_HOME']) / 'bin/javac'), '-d', str(folder)] + [str(x) for x in folder.glob('*.java')], check=True)


def run(folder, variant, raw, rgba):
    with (folder / 'input.bin').open('wb') as f:
        f.write(struct.pack('>i', len(raw)))
        for a, b in zip(raw, rgba):
            f.write(a.astype('>f4').tobytes()); f.write(b.tobytes())
    subprocess.run([str(Path(os.environ['JAVA_HOME']) / 'bin/java'), '-cp', str(folder),
                    'com.jellyfinforrayneo.video.DepthFilterRunner', variant,
                    str(folder / 'input.bin'), str(folder / 'output.bin')], check=True)
    h, w = raw.shape[1:]
    return np.fromfile(folder / 'output.bin', dtype=np.dtype([('ms', '>f8'), ('map', 'u1', (h, w))]))['map'].copy()


def main():
    global OUT, FRAMES
    parser = argparse.ArgumentParser()
    parser.add_argument('--percentiles', choices=['5-95', '2-98'], default='5-95')
    parser.add_argument('--extra-source', type=Path, help='Local MP4 in samples; writes a separate mesh-only dataset')
    parser.add_argument('--frames', type=int, default=96)
    args = parser.parse_args()
    FRAMES = args.frames
    if FRAMES < 2 or FRAMES > 1800:
        parser.error('frames must be 2..1800')
    low, high = map(int, args.percentiles.split('-'))
    dataset = 'quality-v1' if args.percentiles == '5-95' else 'quality-p02-p98'
    if args.extra_source:
        if args.percentiles != '2-98':
            parser.error('mesh extra-source requires --percentiles 2-98')
        args.extra_source = args.extra_source.resolve()
        if args.extra_source.parent != (LOCAL / 'samples').resolve():
            parser.error('extra-source must be directly inside local samples')
        dataset = 'quality-motion'
    OUT = LOCAL / 'samples' / dataset
    OUT.mkdir(parents=True, exist_ok=True)
    cache = LOCAL / 'quality-cache'
    cache.mkdir(exist_ok=True)
    report = dict(schema=1, productionSha256=digest(SOURCE), frames=FRAMES,
                  normalization=dict(lowPercentile=low, highPercentile=high, scope='per-update bounds with 0.15 smoothing; reset on photometric cuts'), simulatedDelayFrames=2, clips=[], profiles=[
                      dict(id='p0', label='266×154 · 当前稳定器 · 半帧率 · 延后 2 帧', width=266, height=154, stride=2, delay=2),
                      dict(id='p1', label='266×154 · 无像素历史融合 · 半帧率 · 延后 2 帧', width=266, height=154, stride=2, delay=2),
                      dict(id='p2', label='392×224 · 当前稳定器 · 半帧率 · 延后 2 帧', width=392, height=224, stride=2, delay=2),
                      dict(id='p3', label='266×154 · 逐帧深度与颜色配对 · 离线上界', width=266, height=154, stride=1, delay=0)],
                  limits='CPU float inference cached offline, actual Java filter, desktop WebGL translation of native gather33. Not QNN timing, not native playback, not source-matched eye-view ground truth. p3 changes update rate AND alignment; it also uses the same per-update filter at higher cadence, changing its wall-time response. This is an upper-bound diagnostic, not a single-variable quality gain. Startup assumes the first depth is available; steady-state comparisons are the target.')
    for clip in range(1 if args.extra_source else 3):
        path = args.extra_source or LOCAL / f'samples/clip-{clip}.mp4'
        cap = cv2.VideoCapture(str(path)); fps = cap.get(cv2.CAP_PROP_FPS)
        frames = []
        for _ in range(FRAMES):
            ok, frame = cap.read()
            if not ok:
                break
            frames.append(frame)
        cap.release()
        if len(frames) != FRAMES:
            raise RuntimeError('Clip too short')
        info = dict(id=clip, fps=fps, duration=FRAMES / fps, source=f'/samples/{path.name}', frames=FRAMES, label=f'高动态 · {FRAMES / fps:g} 秒' if args.extra_source else f'片段 {clip+1}',
                    sourceSha256=digest(path), data={}, models={})
        for w, h in [(266,154), (392,224)]:
            model = LOCAL / ('npu/depth-anything-v2-small-fixed-266.onnx' if w == 266 else 'npu/resolution-392/depth-anything-v2-small-fixed-392.onnx')
            model_sha = digest(model)
            cached = cache / f'{info["sourceSha256"][:12]}-{model_sha[:12]}-{FRAMES}.npz'
            rgba = np.array([cv2.cvtColor(cv2.resize(frame, (w,h)), cv2.COLOR_BGR2RGBA) for frame in frames])
            if cached.exists():
                data = np.load(cached); raw = data['raw']; times = data['times']
            else:
                options = ort.SessionOptions(); options.intra_op_num_threads = 4
                session = ort.InferenceSession(str(model), options, providers=['CPUExecutionProvider'])
                raw, times = [], []
                for i, color in enumerate(rgba):
                    a = (color[:,:,:3].astype(np.float32)/255-np.array([.485,.456,.406],np.float32))/np.array([.229,.224,.225],np.float32)
                    start = time.perf_counter()
                    result = session.run(None, {session.get_inputs()[0].name: a.transpose(2,0,1)[None].copy()})[0].squeeze()
                    times.append((time.perf_counter()-start)*1000)
                    if result.shape != (h,w) or not np.isfinite(result).all():
                        raise RuntimeError('Invalid inferred depth')
                    raw.append(result)
                    if i % 24 == 0:
                        print('clip',clip,'resolution',w,'frame',i,flush=True)
                raw, times = np.array(raw), np.array(times)
                np.savez_compressed(cached, raw=raw, times=times)
                del session
            info['models'][str(w)] = dict(sha256=model_sha, desktopCpuMedianMs=float(np.median(times)), shape=[h,w])
            with tempfile.TemporaryDirectory(prefix='tachi-quality-java-') as temp:
                folder = Path(temp); filters(folder,w,h,low,high)
                for profile in report['profiles']:
                    if profile['width'] != w:
                        continue
                    stride = profile['stride']
                    maps = run(folder, 'NoHistoryDepth' if profile['id']=='p1' else 'TemporalDepth', raw[::stride], rgba[::stride])
                    file = OUT / f'clip-{clip}-{profile["id"]}.bin'
                    file.write_bytes(maps.tobytes())
                    info['data'][profile['id']] = dict(url=f'/samples/{dataset}/{file.name}', bytes=file.stat().st_size, sha256=digest(file), count=len(maps))
        report['clips'].append(info)
        print('clip',clip,'complete',flush=True)
    (OUT / 'manifest.json').write_text(json.dumps(report,indent=2)+'\n')


if __name__ == '__main__':
    main()
