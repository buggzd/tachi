import { pipeline, env, RawImage } from '@huggingface/transformers';
import { GRID_WIDTH, GRID_HEIGHT, halfToFloat } from './core.js';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.useBrowserCache = false;
let estimator;
self.onmessage = async ({ data }) => {
    try {
        if (data.type === 'load') {
            const started = performance.now();
            estimator = await pipeline('depth-estimation', 'depth-anything-v2-small', {
                device: data.device || 'webgpu', dtype: data.dtype === 'fp32' ? 'fp32' : 'fp16',
            });
            self.postMessage({ type: 'ready', device: data.device || 'webgpu', loadMs: performance.now() - started });
        } else if (data.type === 'infer' && estimator) {
            const started = performance.now();
            const image = new RawImage(new Uint8ClampedArray(data.pixels), data.width, data.height, 3);
            // Keep the bounded capture dimensions, rather than upscaling a small
            // performance-tier input back to the model's 518px default.
            estimator.processor.image_processor.size = { width: data.width, height: data.height };
            const inputs = await estimator.processor(image);
            const result = await estimator.model(inputs);
            const tensor = result.predicted_depth;
            const [height, width] = tensor.dims.slice(-2);
            const depth = new Float32Array(GRID_WIDTH * GRID_HEIGHT);
            for (let y = 0; y < GRID_HEIGHT; y++) for (let x = 0; x < GRID_WIDTH; x++) {
                const value = tensor.data[Math.min(height - 1, Math.floor((y + 0.5) * height / GRID_HEIGHT)) * width
                    + Math.min(width - 1, Math.floor((x + 0.5) * width / GRID_WIDTH))];
                depth[y * GRID_WIDTH + x] = tensor.type === 'float16' && tensor.data instanceof Uint16Array ? halfToFloat(value) : value;
            }
            const outputType = tensor.type;
            tensor.dispose(); inputs.pixel_values.dispose();
            self.postMessage({ type: 'depth', depth, time: data.time, generation: data.generation,
                outputType, inferenceMs: performance.now() - started }, [depth.buffer]);
        }
    } catch (error) {
        console.error('Depth worker:', String(error?.message || 'Unknown model failure').slice(0, 1000));
        self.postMessage({ type: 'error', stage: data.type });
    }
};
