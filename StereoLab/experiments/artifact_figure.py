"""Generate synthetic error maps with a shared 0..3 single-eye-pixel color scale."""
import argparse
from pathlib import Path
import tempfile
import cv2
import numpy as np
from artifact_bench import SCALE, build, run_java, scenes

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True)
args = parser.parse_args()
cv2.setNumThreads(1)
canvas = np.full((568, 980, 3), 245, np.uint8)
cv2.putText(canvas, 'Depth-induced displacement error (synthetic GT, not rendered SBS)',
            (18, 25), cv2.FONT_HERSHEY_SIMPLEX, .65, (30, 30, 30), 1, cv2.LINE_AA)
with tempfile.TemporaryDirectory(prefix='tachi-artifact-figure-') as temp:
    folder = Path(temp)
    build(folder, False)
    row = 0
    for name, gt, raw, rgba, masks in scenes(41957):
        if name not in ('shallow_motion', 'appearance_threshold'):
            continue
        for col, variant in enumerate(('BaselineDepth', 'TemporalDepth')):
            pred, _ = run_java(folder, variant, raw, rgba)
            error = abs(gt - pred) * SCALE
            strip = error[8:, 77, 70:210]
            heat = cv2.applyColorMap(np.round(np.clip(strip / 3, 0, 1) * 255).astype(np.uint8), cv2.COLORMAP_INFERNO)
            heat = cv2.resize(heat, (420, 168), interpolation=cv2.INTER_NEAREST)
            x, y = 18 + col * 484, 90 + row * 220
            canvas[y:y + 168, x:x + 420] = heat
            label = ('Baseline' if col == 0 else 'Updated') + ': ' + name.replace('_', ' ')
            cv2.putText(canvas, label, (x, y - 12), cv2.FONT_HERSHEY_SIMPLEX, .54, (30, 30, 30), 1, cv2.LINE_AA)
        row += 1
cv2.putText(canvas, 'Horizontal: model columns 70-209. Downward: depth updates 8-63 at 12 Hz.',
            (18, 515), cv2.FONT_HERSHEY_SIMPLEX, .54, (30, 30, 30), 1, cv2.LINE_AA)
bar = cv2.applyColorMap(np.arange(256, dtype=np.uint8)[None], cv2.COLORMAP_INFERNO)
canvas[536:550, 18:438] = cv2.resize(bar, (420, 14))
cv2.putText(canvas, '0 px                         1.5 px                         3 px+',
            (18, 565), cv2.FONT_HERSHEY_SIMPLEX, .45, (30, 30, 30), 1, cv2.LINE_AA)
if not cv2.imwrite(str(Path(args.out)), canvas):
    raise RuntimeError('Could not write figure')
