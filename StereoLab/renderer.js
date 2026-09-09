import { stereoParameters } from './core.js';

const vertex = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform sampler2D uDepth;
uniform vec2 uContent;
uniform vec2 uEye;
uniform vec2 uInset;
uniform float uSign;
uniform float uBase;
uniform float uAmplitude;
uniform bool uShowDepth;
out vec3 vColor;
void main() {
    vec2 p = vec2(float(gl_VertexID % int(uContent.x)), float(gl_VertexID / int(uContent.x))) + 0.5;
    vec2 uv = p / uContent;
    vec3 color = texture(uImage, uv).rgb;
    // Joint bilateral upsampling: source-image edges guide the four depth taps.
    vec2 grid = vec2(textureSize(uDepth, 0));
    vec2 q = uv * grid - 0.5;
    vec2 fraction = fract(q), origin = floor(q);
    float n = 0.0, total = 0.0;
    for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
        vec2 offset = vec2(x, y);
        vec2 tap = (clamp(origin + offset, vec2(0), grid - 1.0) + 0.5) / grid;
        vec2 bw = mix(1.0 - fraction, fraction, offset);
        vec3 diff = texture(uImage, tap).rgb - color;
        float weight = bw.x * bw.y * exp(-dot(diff, diff) * 24.0) + 0.00001;
        n += texture(uDepth, tap).r * weight; total += weight;
    }
    n = clamp(n / total, 0.0, 1.0);
    float disparity = uBase + uAmplitude * (n - 0.5);
    vec2 target = uInset + p + vec2(uSign * disparity * 0.5, 0);
    gl_Position = vec4(target.x / uEye.x * 2.0 - 1.0, 1.0 - target.y / uEye.y * 2.0,
        0.98 - 1.96 * n, 1.0);
    gl_PointSize = 1.0;
    vColor = uShowDepth ? vec3(n) : color;
}`;
const fragment = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 result;
void main() { result = vec4(vColor, 1); }`;
const fullVertex = `#version 300 es
void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0, 1);
}`;
const fillFragment = `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uZ;
uniform int uWidth;
uniform int uRadius;
uniform vec2 uInset;
uniform vec2 uContent;
uniform float uBase;
out vec4 result;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 c = texelFetch(uColor, p, 0);
    if (c.a > 0.5) { result = c; return; }
    int eyeStart = p.x < uWidth ? 0 : uWidth;
    float signEye = eyeStart == 0 ? 1.0 : -1.0;
    float local = float(p.x - eyeStart) + 0.5 - signEye * uBase * 0.5;
    // Preserve exterior black and never read across the eye boundary.
    if (local < uInset.x || local >= uInset.x + uContent.x
        || gl_FragCoord.y < uInset.y || gl_FragCoord.y >= uInset.y + uContent.y) {
        result = vec4(0, 0, 0, 1); return;
    }
    ivec2 left = p, right = p;
    bool hasLeft = false, hasRight = false;
    for (int i = 1; i <= 64; i++) {
        if (i > uRadius) break;
        if (!hasLeft && p.x - i >= eyeStart && texelFetch(uColor, p - ivec2(i, 0), 0).a > 0.5) {
            left = p - ivec2(i, 0); hasLeft = true;
        }
        if (!hasRight && p.x + i < eyeStart + uWidth && texelFetch(uColor, p + ivec2(i, 0), 0).a > 0.5) {
            right = p + ivec2(i, 0); hasRight = true;
        }
        if (hasLeft && hasRight) break;
    }
    // Greater z is farther away. Extend background, not the near silhouette.
    if (hasLeft && hasRight)
        c = texelFetch(uColor, texelFetch(uZ, left, 0).r >= texelFetch(uZ, right, 0).r ? left : right, 0);
    else if (hasLeft || hasRight) c = texelFetch(uColor, hasLeft ? left : right, 0);
    result = vec4(c.rgb, 1);
}`;

function program(gl, vs, fs) {
    const shaders = [vs, fs].map((source, i) => {
        const shader = gl.createShader(i ? gl.FRAGMENT_SHADER : gl.VERTEX_SHADER);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        return shader;
    });
    const p = gl.createProgram(); shaders.forEach(s => gl.attachShader(p, s)); gl.linkProgram(p);
    shaders.forEach(s => gl.deleteShader(s));
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
}
export class StereoRenderer {
    constructor(canvas, options = { width: 640, height: 360 }) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
        if (!this.gl) throw new Error('WebGL 2 unavailable');
        const gl = this.gl;
        this.splat = program(gl, vertex, fragment); this.fill = program(gl, fullVertex, fillFragment);
        this.textures = Array.from({ length: 4 }, () => gl.createTexture());
        this.fbo = gl.createFramebuffer(); this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2'); this.queries = []; this.gpuMs = [];
        this.configure(options);
    }
    configure(options) {
        this.params = stereoParameters(options);
        const { gl, canvas, params: p } = this;
        canvas.width = p.width * 2; canvas.height = p.height;
        this.texture(2, gl.RGBA8, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, null);
        this.texture(3, gl.DEPTH_COMPONENT24, canvas.width, canvas.height, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.textures[2], 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.textures[3], 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete stereo framebuffer');
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    texture(unit, internal, width, height, format, type, data) {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, this.textures[unit]);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
    }
    uniform(p, name, method, ...values) { this.gl[method](this.gl.getUniformLocation(p, name), ...values); }
    render(source, depth, depthWidth, depthHeight, { strength = 1, showDepth = false, syncGpu = false } = {}) {
        const { gl, params: p } = this;
        const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
        if (!sw || !sh || depth.length !== depthWidth * depthHeight) throw new Error('Invalid stereo frame');
        let query = null;
        if (this.timer && this.queries.length < 4) {
            query = gl.createQuery(); gl.beginQuery(this.timer.TIME_ELAPSED_EXT, query);
        }
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        this.texture(1, gl.R32F, depthWidth, depthHeight, gl.RED, gl.FLOAT, depth);
        const scale = Math.min(p.width * p.size / sw, p.height * p.size / sh);
        const cw = Math.max(1, Math.floor(sw * scale)), ch = Math.max(1, Math.floor(sh * scale));
        const inset = [(p.width - cw) / 2, (p.height - ch) / 2];
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
        gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.useProgram(this.splat);
        this.uniform(this.splat, 'uImage', 'uniform1i', 0); this.uniform(this.splat, 'uDepth', 'uniform1i', 1);
        this.uniform(this.splat, 'uContent', 'uniform2f', cw, ch);
        this.uniform(this.splat, 'uEye', 'uniform2f', p.width, p.height);
        this.uniform(this.splat, 'uInset', 'uniform2f', ...inset);
        this.uniform(this.splat, 'uBase', 'uniform1f', p.base);
        this.uniform(this.splat, 'uAmplitude', 'uniform1f', p.amplitude * Math.max(0, Math.min(1, strength)));
        this.uniform(this.splat, 'uShowDepth', 'uniform1i', showDepth ? 1 : 0);
        for (let eye = 0; eye < 2; eye++) {
            gl.viewport(eye * p.width, 0, p.width, p.height);
            this.uniform(this.splat, 'uSign', 'uniform1f', eye ? -1 : 1);
            gl.drawArrays(gl.POINTS, 0, cw * ch);
        }
        gl.disable(gl.DEPTH_TEST); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, p.width * 2, p.height); gl.useProgram(this.fill);
        this.uniform(this.fill, 'uColor', 'uniform1i', 2); this.uniform(this.fill, 'uZ', 'uniform1i', 3);
        this.uniform(this.fill, 'uWidth', 'uniform1i', p.width);
        this.uniform(this.fill, 'uRadius', 'uniform1i', Math.min(64, Math.ceil((p.amplitude + Math.abs(p.base)) / 2) + 3));
        this.uniform(this.fill, 'uContent', 'uniform2f', cw, ch); this.uniform(this.fill, 'uInset', 'uniform2f', ...inset);
        this.uniform(this.fill, 'uBase', 'uniform1f', p.base);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (syncGpu) gl.finish();
        if (query) { gl.endQuery(this.timer.TIME_ELAPSED_EXT); this.queries.push(query); }
        while (this.queries.length && gl.getQueryParameter(this.queries[0], gl.QUERY_RESULT_AVAILABLE)) {
            const q = this.queries.shift();
            if (!gl.getParameter(this.timer.GPU_DISJOINT_EXT)) {
                this.gpuMs.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
                if (this.gpuMs.length > 1800) this.gpuMs.shift();
            }
            gl.deleteQuery(q);
        }
    }
    readPixels(raw = false) {
        const gl = this.gl, pixels = new Uint8Array(this.canvas.width * this.canvas.height * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, raw ? this.fbo : null);
        gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); return pixels;
    }
    dispose() {
        const gl = this.gl;
        this.queries.forEach(q => gl.deleteQuery(q)); this.textures.forEach(t => gl.deleteTexture(t));
        gl.deleteProgram(this.splat); gl.deleteProgram(this.fill); gl.deleteFramebuffer(this.fbo); gl.deleteVertexArray(this.vao);
    }
}
