import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, halfToFloat, stereoParameters, motionField, warpDepth, DepthTracker, GRID_WIDTH as W, GRID_HEIGHT as H } from '../core.js';

test('latency percentiles use numeric ordering across single and multiple digits', () => {
    assert.deepEqual(summarize([100, 2, 15, 9, 40, NaN]), { count: 5, mean: 33.2, p50: 15, p95: 100 });
    assert.equal(summarize([]), null);
});

test('half precision tensor storage is decoded as numbers rather than integer bit patterns', () => {
    assert.equal(halfToFloat(0x3c00), 1); assert.equal(halfToFloat(0xc000), -2);
    assert.equal(halfToFloat(1), 2 ** -24); assert.equal(halfToFloat(0x7c00), Infinity);
    assert.ok(Number.isNaN(halfToFloat(0x7e00)));
});

test('native eye geometry bounds both positive and negative disparities', () => {
    const p = stereoParameters({ width: 1920, height: 1080 });
    assert.equal(p.min, -4); assert.equal(p.max, 20);
    assert.ok(Math.abs((1920 * (1 - p.size) - Math.max(Math.abs(p.min), Math.abs(p.max))) / 2 - 86) < 1e-9);
    assert.throws(() => stereoParameters({ width: 1920, height: 1080, size: 0.95, base: 48, amplitude: 96 }));
    assert.throws(() => stereoParameters({ width: NaN, height: 1080 }));
});
function texture() {
    let seed = 42;
    return Uint8Array.from({ length: W * H }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; });
}
test('backward block motion follows translated content rather than the old pixel position', () => {
    const previous = texture(), current = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 2; x < W; x++) current[y * W + x] = previous[y * W + x - 2];
    const flow = motionField(previous, current);
    let correct = 0, total = 0;
    for (let y = 8; y < H - 8; y++) for (let x = 8; x < W - 8; x++) {
        const i = y * W + x; total++; if (flow.dx[i] === -2 && flow.dy[i] === 0) correct++;
    }
    assert.ok(correct / total > 0.95);
    const gradient = Float32Array.from({ length: W * H }, (_, i) => i % W / W);
    assert.ok(Math.abs(warpDepth(gradient, flow)[20 * W + 30] - 28 / W) < 1e-6);
});
test('textureless blocks prefer zero movement', () => {
    const gray = new Uint8Array(W * H).fill(100), flow = motionField(gray, gray);
    assert.ok(flow.dx.every(x => x === 0)); assert.ok(flow.dy.every(y => y === 0));
});
test('old inference cannot cross a scene cut, seek, or a bounded history window', () => {
    const t = new DepthTracker(), raw = Float32Array.from({ length: W * H }, (_, i) => i % W);
    const gray = new Uint8Array(W * H).fill(30);
    t.advance(gray, 0); const generation = t.generation;
    assert.equal(t.observe(raw, 0, generation), true);
    assert.ok(t.observation.depth[W - 1] > t.observation.depth[0]);
    assert.equal(t.strength(), 1);
    t.advance(new Uint8Array(W * H).fill(240), 0.04);
    assert.equal(t.observe(raw, 0, generation), false);
    assert.equal(t.strength(), 0);
    assert.equal(t.observation, null);
    t.advance(gray, 0.08); const g = t.generation;
    for (let i = 1; i <= 8; i++) t.advance(gray, 0.08 + i * 0.04);
    assert.equal(t.observe(raw, 0.08, g), false);
    t.advance(gray, 0.01);
    assert.equal(t.observe(raw, 0.4, g), false);
});
test('invalid and constant depth never count as valid stereo observations', () => {
    const t = new DepthTracker(); t.advance(texture(), 0);
    assert.equal(t.observe(new Float32Array(W * H).fill(NaN), 0, t.generation), false);
    assert.equal(t.observe(new Float32Array(W * H).fill(1), 0, t.generation), false);
    assert.equal(t.strength(), 0);
});
