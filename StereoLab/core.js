/** Relative-depth research core. Coordinates are top-left, eye-local pixels.
 * No metric distance, optical comfort, or model confidence is inferred here. */
export const GRID_WIDTH = 96;
export const GRID_HEIGHT = 54;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function summarize(values) {
    const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
    return sorted.length ? { count: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] } : null;
}

export function halfToFloat(bits) {
    const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 31, fraction = bits & 1023;
    return exponent === 0 ? sign * fraction * 2 ** -24
        : exponent === 31 ? (fraction ? NaN : sign * Infinity)
            : sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

export function stereoParameters({ width, height, size = 0.9, base = 8, amplitude = 24 }) {
    if (![width, height, size, base, amplitude].every(Number.isFinite)
        || !Number.isInteger(width) || !Number.isInteger(height)
        || width < 64 || width > 1920 || height < 36 || height > 1080
        || size < 0.5 || size > 0.95 || amplitude < 0 || amplitude > 96 || Math.abs(base) > 48) {
        throw new Error('Invalid stereo geometry');
    }
    const scale = width / 1920;
    const d0 = base * scale, a = amplitude * scale;
    const limit = width * (1 - size - 0.02);
    if (Math.abs(d0) + a / 2 > limit) throw new Error('Stereo geometry exceeds eye bounds');
    return { width, height, size, base: d0, amplitude: a,
        min: d0 - a / 2, max: d0 + a / 2 };
}

/** Block matching is deliberately small and bounded. Unreliable blocks discard
 * history rather than averaging moving foreground with stationary background. */
export function motionField(previous, current, width = GRID_WIDTH, height = GRID_HEIGHT) {
    const dx = new Int8Array(width * height), dy = new Int8Array(width * height);
    const confidence = new Float32Array(width * height);
    for (let by = 0; by < height; by += 8) for (let bx = 0; bx < width; bx += 8) {
        let best = Infinity, bestX = 0, bestY = 0;
        for (let sy = -4; sy <= 4; sy++) for (let sx = -4; sx <= 4; sx++) {
            let error = 0, count = 0;
            for (let y = by; y < Math.min(by + 8, height); y += 2)
                for (let x = bx; x < Math.min(bx + 8, width); x += 2) {
                    const px = x + sx, py = y + sy;
                    if (px >= 0 && px < width && py >= 0 && py < height) {
                        error += Math.abs(current[y * width + x] - previous[py * width + px]); count++;
                    }
                }
            const score = count >= 8 ? error / count + 0.15 * (Math.abs(sx) + Math.abs(sy)) : Infinity;
            if (score < best) { best = score; bestX = sx; bestY = sy; }
        }
        for (let y = by; y < Math.min(by + 8, height); y++)
            for (let x = bx; x < Math.min(bx + 8, width); x++) {
                const i = y * width + x, px = x + bestX, py = y + bestY;
                dx[i] = bestX; dy[i] = bestY;
                confidence[i] = px >= 0 && px < width && py >= 0 && py < height
                    ? Math.exp(-best / 18 - Math.abs(current[i] - previous[py * width + px]) / 24) : 0;
            }
    }
    return { dx, dy, confidence };
}

export function warpDepth(depth, flow, width = GRID_WIDTH, height = GRID_HEIGHT) {
    const out = new Float32Array(depth.length);
    for (let i = 0; i < depth.length; i++) {
        const x = i % width + flow.dx[i], y = Math.floor(i / width) + flow.dy[i];
        out[i] = x >= 0 && x < width && y >= 0 && y < height && flow.confidence[i] > 0.15
            ? depth[y * width + x] : 0.5;
    }
    return out;
}

export class DepthTracker {
    constructor() { this.reset(); }
    reset() {
        this.generation = (this.generation ?? 0) + 1;
        this.depth = new Float32Array(GRID_WIDTH * GRID_HEIGHT).fill(0.5);
        this.gray = null; this.history = []; this.range = null;
        this.observedAt = -Infinity; this.time = 0; this.cuts = 0;
        this.temporalError = 0;
        this.observation = null;
        this.motionEnabled = true;
    }
    advance(gray, time, { motion = true } = {}) {
        if (gray.length !== this.depth.length || !Number.isFinite(time)) throw new Error('Invalid frame');
        if (time < this.time || time - this.time > 0.5) this.reset();
        this.motionEnabled = motion;
        let flow = null;
        if (this.gray && motion) {
            let error = 0;
            for (let i = 0; i < gray.length; i++) error += Math.abs(gray[i] - this.gray[i]);
            if (error / gray.length > 45) {
                const cuts = this.cuts + 1; this.reset(); this.cuts = cuts;
                this.motionEnabled = motion;
            } else {
                flow = motionField(this.gray, gray);
                this.depth = warpDepth(this.depth, flow);
            }
        }
        this.gray = gray; this.time = time;
        this.history.push({ time, flow });
        while (this.history.length > 24 || this.history[0].time < time - 0.5) this.history.shift();
    }
    observe(raw, time, generation) {
        if (generation !== this.generation || this.time - time > 0.25 || time > this.time
            || raw.length !== this.depth.length || !raw.every(Number.isFinite)) return false;
        const first = this.history.findIndex(f => Math.abs(f.time - time) < 1e-5);
        if (first < 0) return false;
        const sorted = Float32Array.from(raw).sort();
        const lo = sorted[Math.floor(sorted.length * 0.05)], hi = sorted[Math.floor(sorted.length * 0.95)];
        if (hi - lo < 1e-5) return false;
        // Slowly adapt the shot's robust range. Never stretch each frame independently.
        if (!this.range) this.range = [lo, hi];
        else this.range = this.range.map((v, i) => v * 0.98 + [lo, hi][i] * 0.02);
        let incoming = Float32Array.from(raw, v => clamp((v - this.range[0]) / (this.range[1] - this.range[0]), 0, 1));
        const observed = incoming;
        for (let i = first + 1; i < this.history.length; i++) {
            const f = this.history[i].flow;
            if (!f) {
                if (this.motionEnabled === false) continue;
                return false;
            }
            incoming = warpDepth(incoming, f);
        }
        const alpha = Number.isFinite(this.observedAt) ? 0.65 : 1;
        let error = 0;
        for (let i = 0; i < incoming.length; i++) {
            error += Math.abs(incoming[i] - this.depth[i]);
            this.depth[i] += alpha * (incoming[i] - this.depth[i]);
        }
        this.temporalError = error / incoming.length;
        this.observedAt = time;
        this.observation = { depth: observed, time };
        return true;
    }
    strength(time = this.time) {
        // No unbounded stale depth: progressively return to a flat screen.
        return clamp((0.35 - (time - this.observedAt)) / 0.15, 0, 1);
    }
}
