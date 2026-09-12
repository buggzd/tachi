"""Real-clip proxies using cached CPU float inference and actual production Java filter."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import cv2
import numpy as np
import onnxruntime as ort
from artifact_bench import ROOT, W, H, SCALE, build, run_java, SOURCE
from temporal_bench import flow_pair, remap


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--prototypes', action='store_true')
    args = parser.parse_args()
    cv2.setNumThreads(1)
    model = ROOT / 'StereoLab/.local/npu/depth-anything-v2-small-fixed-266.onnx'
    model_sha = digest(model)
    cache = ROOT / 'StereoLab/.local/artifact-cache'
    cache.mkdir(parents=True, exist_ok=True)
    session = None
    results = []
    with tempfile.TemporaryDirectory(prefix='tachi-real-depth-') as temp:
        folder = Path(temp)
        variants = build(folder, args.prototypes)
        for clip in range(3):
            source = ROOT / f'StereoLab/.local/samples/clip-{clip}.mp4'
            clip_sha = digest(source)
            cached = cache / f'{model_sha[:16]}-{clip_sha[:16]}-stride2.npz'
            if cached.exists():
                data = np.load(cached)
                raw, rgba, fps = data['raw'], data['rgba'], float(data['fps'])
            else:
                cap = cv2.VideoCapture(str(source))
                fps = cap.get(cv2.CAP_PROP_FPS)
                frames = []
                for i in range(96):
                    ok, frame = cap.read()
                    if not ok:
                        break
                    if i % 2 == 0:
                        frames.append(cv2.cvtColor(cv2.resize(frame, (W, H)), cv2.COLOR_BGR2RGBA))
                cap.release()
                if len(frames) < 16:
                    raise RuntimeError('Insufficient local clip frames')
                rgba = np.array(frames)
                if session is None:
                    options = ort.SessionOptions()
                    options.intra_op_num_threads = 4
                    session = ort.InferenceSession(str(model), options, providers=['CPUExecutionProvider'])
                raw = []
                for i, color in enumerate(rgba):
                    input_rgb = (color[:, :, :3].astype(np.float32) / 255 - np.array([.485, .456, .406], np.float32)) / np.array([.229, .224, .225], np.float32)
                    tensor = input_rgb.transpose(2, 0, 1)[None].copy()
                    raw.append(session.run(None, {session.get_inputs()[0].name: tensor})[0].squeeze())
                    if i % 12 == 0:
                        print('clip', clip, 'inference', i, flush=True)
                raw = np.array(raw)
                np.savez_compressed(cached, raw=raw, rgba=rgba, fps=fps)
            flows = [flow_pair(cv2.cvtColor(a, cv2.COLOR_RGBA2GRAY), cv2.cvtColor(b, cv2.COLOR_RGBA2GRAY))
                     for a, b in zip(rgba, rgba[1:])]
            for variant in variants:
                maps, costs = run_java(folder, variant, raw, rgba)
                changes, coverage = [], []
                for i, (flow, confidence) in enumerate(flows):
                    if i < 8:
                        continue
                    mask = confidence > .35
                    coverage.append(float(mask.mean()))
                    if mask.any():
                        changes.append((abs(maps[i + 1] - remap(maps[i], flow)) * SCALE)[mask])
                values = np.concatenate(changes)
                results.append(dict(clip=clip, clipSha256=clip_sha, frames=len(raw), observationsHz=fps / 2,
                                    variant=variant, trustedCoverage=float(np.mean(coverage)),
                                    trustedFlowChangeMeanPx=float(values.mean()), trustedFlowChangeP95Px=float(np.percentile(values, 95)),
                                    spatialDepthStd=float(np.std(maps[8:], axis=(1, 2)).mean()),
                                    desktopJavaMedianMs=float(np.median(costs[16:]))))
            print('clip', clip, 'complete', flush=True)
    Path(args.out).write_text(json.dumps(dict(modelSha256=model_sha, productionSha256=digest(ROOT / SOURCE),
        numpy=np.__version__, opencv=cv2.__version__, onnxruntime=ort.__version__, results=results,
        limits='First 96 decoded frames of three local clips, stride 2. Float CPU inference, not quantized QNN. Flow changes include real motion and depth changes; lower is not necessarily better. No reference depth, rendered eye views, NPU timing or measured viewing quality.'), indent=2) + '\n')


if __name__ == '__main__':
    main()
