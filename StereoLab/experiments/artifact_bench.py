"""Reference-aware artifact metrics for the actual Java depth filter; no Android timing claims."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BASE = '3560807'
SOURCE = 'AndroidApp/native-video/src/main/java/com/jellyfinforrayneo/video/TemporalDepth.java'
W, H, FRAMES, SCALE = 266, 154, 64, 30.72
Y, X = np.mgrid[:H, :W]
ROI = (X >= 30) & (X < W - 30) & (Y >= 10) & (Y < H - 10)


def scenes(seed, speed=2, shallow_depth=.1, foreground_rgb=106):
    rng = np.random.default_rng(seed)
    for name in ('static_noise', 'shallow_motion', 'strong_motion', 'same_color_motion',
                 'appearance_threshold', 'depth_threshold', 'depth_step', 'cut'):
        truths, raws, colors, masks = [], [], [], []
        for t in range(FRAMES):
            moving = name in ('shallow_motion', 'strong_motion', 'same_color_motion')
            left = (55 if speed <= 2 else 25) + t * speed if moving else 95
            mask = (X >= left) & (X < left + 45) & (Y >= 30) & (Y < 125)
            depth = .65 if name == 'strong_motion' else shallow_depth
            gt = np.full((H, W), .3, np.float32)
            gt[mask] += depth
            if name == 'depth_step' and t >= 24:
                gt[mask] += .1
            if name == 'cut' and t >= 24:
                gt = .8 - gt
            gt[:, :20], gt[:, -20:] = 0, 1
            raw = gt + rng.normal(0, .012, gt.shape).astype(np.float32)
            rgb = np.full((H, W, 4), 100, np.uint8)
            rgb[:, :, 3] = 255
            rgb[mask, :3] = foreground_rgb if name != 'strong_motion' else 200
            if name == 'same_color_motion':
                rgb[:, :, :3] = 100
            if name == 'appearance_threshold':
                rgb[:, :, :3] = 100 + (0, 6, 13, 7)[t % 4]
            if name == 'depth_threshold':
                raw[mask] += (.11 if t % 2 else -.11)
            if name == 'cut' and t >= 24:
                rgb[:, :, :3] = 240
            raw[:, :20], raw[:, -20:] = 0, 1
            truths.append(gt); raws.append(raw); colors.append(rgb); masks.append(mask)
        yield name, np.array(truths), np.array(raws), np.array(colors), np.array(masks)


def build(folder, prototypes):
    baseline = subprocess.check_output(['git', 'show', f'{BASE}:{SOURCE}'], cwd=ROOT, text=True)
    sources = {'BaselineDepth': baseline, 'TemporalDepth': (ROOT / SOURCE).read_text()}
    if prototypes:
        clip = '''
            if (!reset)
            {
                int x = i % NativeVideoView.SAMPLE_WIDTH, y = i / NativeVideoView.SAMPLE_WIDTH;
                float minimum = value, maximum = value;
                for (int yy = Math.max(0, y - 1); yy <= Math.min(NativeVideoView.SAMPLE_HEIGHT - 1, y + 1); yy++)
                    for (int xx = Math.max(0, x - 1); xx <= Math.min(NativeVideoView.SAMPLE_WIDTH - 1, x + 1); xx++)
                    {
                        float neighbor = Math.max(0f, Math.min(1f,
                                (raw[yy * NativeVideoView.SAMPLE_WIDTH + xx] - low) / (high - low)));
                        minimum = Math.min(minimum, neighbor);
                        maximum = Math.max(maximum, neighbor);
                    }
                previous[i] = Math.max(minimum - .02f, Math.min(maximum + .02f, previous[i]));
            }
'''
        gate = '''            if (!reset)
            {
                float colorWeight = Math.max(0f, Math.min(1f, (difference(rgba, i) - 6f) / 24f));
                float depthWeight = Math.max(0f, Math.min(1f, (Math.abs(value - previous[i]) - .06f) / .06f));
                float weight = Math.max(colorWeight, depthWeight);
                weight = weight * weight * (3f - 2f * weight);
                value = previous[i] + (.35f + .65f * weight) * (value - previous[i]);
            }'''
        old_gate = '''            if (!reset && difference(rgba, i) <= 18 && Math.abs(value - previous[i]) < .12f)
                value = previous[i] + .35f * (value - previous[i]);'''
        for name, clipping, smooth in [('ClipDepth', True, False), ('SmoothDepth', False, True), ('CombinedDepth', True, True)]:
            code = baseline.replace(old_gate, (clip if clipping else '') + (gate if smooth else old_gate))
            sources[name] = code
        conservative = gate.replace('- 6f) / 24f', '- 12f) / 24f').replace('- .06f) / .06f', '- .08f) / .08f')
        sources['ConservativeDepth'] = baseline.replace(old_gate, conservative)
        # Third ablation: keep the original large-depth rejection boundary. Releasing
        # history later for large depth changes can introduce new trails on fast edges.
        appearance = '''            if (!reset && Math.abs(value - previous[i]) < .12f)
            {
                float weight = Math.max(0f, Math.min(1f, (difference(rgba, i) - 6f) / 36f));
                weight = weight * weight * (3f - 2f * weight);
                value = previous[i] + (.35f + .65f * weight) * (value - previous[i]);
            }'''
        sources['AppearanceDepth'] = baseline.replace(old_gate, appearance)
    (folder / 'NativeVideoView.java').write_text('package com.jellyfinforrayneo.video; final class NativeVideoView { static final int SAMPLE_WIDTH=266, SAMPLE_HEIGHT=154; }')
    shutil.copy(ROOT / 'StereoLab/experiments/DepthFilterRunner.java', folder)
    for name, code in sources.items():
        (folder / f'{name}.java').write_text(code.replace('class TemporalDepth', f'class {name}'))
    java_home = os.environ.get('JAVA_HOME')
    javac = str(Path(java_home) / 'bin/javac') if java_home else 'javac'
    subprocess.run([javac, '-d', str(folder)] + [str(p) for p in folder.glob('*.java')], check=True)
    return list(sources)


def run_java(folder, variant, raw, rgba):
    with (folder / 'input.bin').open('wb') as file:
        file.write(struct.pack('>i', len(raw)))
        for a, b in zip(raw, rgba):
            file.write(a.astype('>f4').tobytes()); file.write(b.tobytes())
    java_home = os.environ.get('JAVA_HOME')
    java = str(Path(java_home) / 'bin/java') if java_home else 'java'
    subprocess.run([java, '-cp', str(folder), 'com.jellyfinforrayneo.video.DepthFilterRunner',
                    variant, str(folder / 'input.bin'), str(folder / 'output.bin')], check=True)
    dtype = np.dtype([('ms', '>f8'), ('map', 'u1', (H, W))])
    output = np.fromfile(folder / 'output.bin', dtype=dtype)
    return output['map'].astype(np.float32) / 255, output['ms']


def metrics(gt, pred, masks, costs):
    error = abs(gt - pred) * SCALE
    edge = np.zeros_like(masks)
    edge[:, :, 1:] |= masks[:, :, 1:] != masks[:, :, :-1]
    edge[:, 1:, :] |= masks[:, 1:, :] != masks[:, :-1, :]
    edge = np.logical_or.reduce([np.roll(edge, k, axis=a) for a in (1, 2) for k in range(-2, 3)])
    reveal = masks[:-1] & ~masks[1:] & ROI
    temporal = abs(np.diff(pred, axis=0) - np.diff(gt, axis=0)) * SCALE
    out = dict(maePx=float(error[8:, ROI].mean()), p95Px=float(np.percentile(error[8:, ROI], 95)),
               edgeMaePx=float(error[8:][edge[8:] & ROI].mean()),
               temporalChangeErrorPx=float(temporal[8:, ROI].mean()),
               revealMaePx=float(error[1:][reveal].mean()) if reveal.any() else None,
               desktopJavaMedianMs=float(np.median(costs[16:])))
    contrast_ratios = []
    for t in range(8, len(gt)):
        fg, bg = masks[t] & ROI, ~masks[t] & ROI
        contrast_ratios.append(float((pred[t, fg].mean() - pred[t, bg].mean()) /
                                    (gt[t, fg].mean() - gt[t, bg].mean())))
    out['foregroundContrastRatio'] = float(np.mean(contrast_ratios))
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--out', required=True)
    p.add_argument('--seeds', default='20260912')
    p.add_argument('--prototypes', action='store_true')
    p.add_argument('--motion-speed', type=int, choices=(1, 2, 3), default=2)
    p.add_argument('--shallow-depth', type=float, default=.1)
    p.add_argument('--foreground-rgb', type=int, choices=range(100, 256), default=106)
    args = p.parse_args()
    rows = []
    with tempfile.TemporaryDirectory(prefix='tachi-depth-eval-') as temp:
        folder = Path(temp)
        variants = build(folder, args.prototypes)
        for seed in map(int, args.seeds.split(',')):
            for name, gt, raw, rgba, masks in scenes(seed, args.motion_speed, args.shallow_depth, args.foreground_rgb):
                for variant in variants:
                    pred, costs = run_java(folder, variant, raw, rgba)
                    row = dict(seed=seed, scene=name, variant=variant, **metrics(gt, pred, masks, costs))
                    if name == 'depth_step':
                        m = masks[24] & ROI
                        target = float(gt[24, m].mean()) - .01
                        reached = np.where(pred[24:, m].mean(axis=1) >= target)[0]
                        row['step90Updates'] = int(reached[0] + 1) if len(reached) else None
                    rows.append(row)
                print(seed, name, flush=True)
    result = dict(baseline=BASE, productionSha256=hashlib.sha256((ROOT / SOURCE).read_bytes()).hexdigest(),
                  width=W, height=H, hz=12, frames=FRAMES, singleEyePxPerDepth=SCALE, results=rows,
                  motionSpeed=args.motion_speed, shallowDepth=args.shallow_depth,
                  foregroundRgb=args.foreground_rgb,
                  limits='Synthetic inverse depth, actual Java filter; not rendered SBS RGB or device performance. Wall time includes JVM warmup effects. No NPU, flow or frame-age simulation.')
    Path(args.out).write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
