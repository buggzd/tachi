#!/usr/bin/env python3
"""Compile the actual AGSL source with desktop Skia and verify stereo geometry.

Requires numpy and skia-python. This is a CPU numerical check, not Android
RenderNode, WebView composition, optical output, or mobile GPU performance.
"""
import json
from pathlib import Path
import re
import numpy as np
import skia

source = (Path(__file__).resolve().parent.parent / 'AndroidApp/app/src/main/java/com/jellyfinforrayneo/client/RealtimeEyeEffect.java').read_text()
source = source.split('private static final String PROGRAM =')[1].split('final RenderNode')[0]
program = ''.join(json.loads(value) for value in re.findall(r'"(?:\\.|[^"\\])*"', source))
effect = skia.RuntimeEffect.MakeForShader(program)
width, height = 200, 100
color = np.zeros((height, width, 4), dtype=np.uint8)
color[:, :, 0] = np.arange(width)
color[:, :, 1] = np.arange(height)[:, None]
color[:, :, 3] = 255

def render(sign, depth=255, mask=None, amplitude=16):
    builder = skia.RuntimeShaderBuilder(effect)
    builder.setChild('content', skia.Image.fromarray(color, colorType=skia.ColorType.kRGBA_8888_ColorType).makeShader())
    values = np.zeros((154, 266, 4), dtype=np.uint8)
    values[:, :, :3] = depth
    values[:, :, 3] = 255
    builder.setChild('depthMap', skia.Image.fromarray(values, colorType=skia.ColorType.kRGBA_8888_ColorType).makeShader())
    builder.setUniform('videoRect', [20., 10., 180., 90.])
    builder.setUniform('direction', float(sign))
    builder.setUniform('amplitude', float(amplitude))
    # Skia Python's setUniform lacks uniform-array binding; the declared float4
    # videoRect occupies the first four floats, followed by eight float4 masks.
    np.frombuffer(builder.uniforms(), dtype=np.float32)[4:36] = (mask or [0., 0., 0., 0.]) + [0.] * 28
    surface = skia.Surface(width, height)
    surface.getCanvas().drawPaint(skia.Paint(Shader=builder.makeShader()))
    return surface.makeImageSnapshot().toarray(colorType=skia.ColorType.kRGBA_8888_ColorType)

left, right = render(1), render(-1)
assert left[50, 100, 0] == 92 and right[50, 100, 0] == 108, 'Eye order / half disparity'
assert render(1, depth=0)[50, 100, 0] == 108, 'Far depth reverses the relative shift'
assert np.array_equal(render(1, amplitude=0), color), 'Zero strength must be identity'
assert np.array_equal(left[:10], color[:10]) and np.array_equal(left[:, :20], color[:, :20]), 'Preserve letterbox and UI outside video'
for sign in [1, -1]:
    masked = render(sign, mask=[80., 20., 110., 80.])
    assert np.array_equal(masked[20:80, 80:110], color[20:80, 80:110]), 'Controls must stay flat'
    assert np.all(masked[:, :, 3] == 255), 'No unfilled transparent pixels'
step = np.zeros((154, 266, 3), dtype=np.uint8)
step[:, :133, :] = 255
occluded = render(1, depth=step)
assert occluded[50, 100, 0] == 92, 'Near surface must win overlapping projected samples'
print('PASS: shader compiles; eye order, near/far shift, identity, letterbox, UI masks, coverage, occlusion.')
