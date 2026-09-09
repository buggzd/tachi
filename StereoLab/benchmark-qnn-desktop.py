#!/usr/bin/env python3
"""Compare the fixed-shape depth model with local QNN quantization candidates.

The script is deliberately independent from the browser implementation. It uses
the same RGB normalization as the depth worker, runs every supplied model on
the CPU, and reports numerical agreement as well as a coarse latency baseline.
Generated JSON belongs under StereoLab/.local and is ignored by Git.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image


MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 1, 3)
STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 1, 3)


def percentile_range(values: np.ndarray) -> tuple[float, float]:
    low, high = np.percentile(values, [5, 95])
    return float(low), float(high)


def rank(values: np.ndarray) -> np.ndarray:
    order = np.argsort(values, kind="mergesort")
    result = np.empty_like(order, dtype=np.float64)
    result[order] = np.arange(len(values), dtype=np.float64)
    return result


def correlation(left: np.ndarray, right: np.ndarray) -> float:
    left = left.astype(np.float64, copy=True)
    right = right.astype(np.float64, copy=True)
    left -= left.mean()
    right -= right.mean()
    denominator = np.sqrt(np.dot(left, left) * np.dot(right, right))
    return float(np.dot(left, right) / denominator) if denominator else 0.0


def load_inputs(directory: Path, width: int, height: int) -> tuple[list[str], list[np.ndarray]]:
    names: list[str] = []
    values: list[np.ndarray] = []
    for path in sorted(directory.glob("*.png")):
        with Image.open(path) as image:
            rgb = np.asarray(
                image.convert("RGB").resize((width, height), Image.Resampling.BILINEAR),
                dtype=np.float32,
            )
        rgb = (rgb / 255.0 - MEAN) / STD
        names.append(path.name)
        values.append(np.transpose(rgb, (2, 0, 1))[None, ...].astype(np.float32))
    if not values:
        raise SystemExit(f"no PNG calibration frames found in {directory}")
    return names, values


def run_model(path: Path, inputs: list[np.ndarray], warmup: int) -> tuple[dict, list[np.ndarray]]:
    session_options = ort.SessionOptions()
    session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(str(path), session_options, providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    for value in inputs[: min(warmup, len(inputs))]:
        session.run(None, {input_name: value})

    timings: list[float] = []
    outputs: list[np.ndarray] = []
    for value in inputs:
        start = time.perf_counter_ns()
        output = session.run(None, {input_name: value})[0][0].astype(np.float32)
        timings.append((time.perf_counter_ns() - start) / 1_000_000.0)
        outputs.append(output)

    return {
        "providers": session.get_providers(),
        "timingMs": {
            "mean": float(np.mean(timings)),
            "p50": float(np.percentile(timings, 50)),
            "p95": float(np.percentile(timings, 95)),
            "min": float(np.min(timings)),
            "max": float(np.max(timings)),
        },
        "input": {
            "name": input_name,
            "shape": session.get_inputs()[0].shape,
            "type": session.get_inputs()[0].type,
        },
        "output": {
            "name": session.get_outputs()[0].name,
            "shape": session.get_outputs()[0].shape,
            "type": session.get_outputs()[0].type,
        },
    }, outputs


def compare(reference: list[np.ndarray], candidate: list[np.ndarray]) -> dict:
    per_frame: list[dict] = []
    for reference_frame, candidate_frame in zip(reference, candidate):
        left = reference_frame.ravel()
        right = candidate_frame.ravel()
        left_low, left_high = percentile_range(left)
        right_low, right_high = percentile_range(right)
        left_normalized = np.clip((left - left_low) / max(left_high - left_low, 1e-8), 0, 1)
        right_normalized = np.clip((right - right_low) / max(right_high - right_low, 1e-8), 0, 1)

        # Agreement over the same deterministic sparse pixels avoids an
        # O(pixels²) metric while preserving the spatial correspondence.
        sample_count = min(512, len(left))
        sample_indices = np.linspace(0, len(left) - 1, sample_count, dtype=np.int64)
        pair_left = left[sample_indices]
        pair_right = right[sample_indices]
        ordering = np.mean(
            (pair_left[:, None] <= pair_left[None, :])
            == (pair_right[:, None] <= pair_right[None, :])
        )
        per_frame.append(
            {
                "rawMae": float(np.mean(np.abs(left - right))),
                "rawRmse": float(np.sqrt(np.mean((left - right) ** 2))),
                "rawPearson": correlation(left, right),
                "rawSpearman": correlation(rank(left), rank(right)),
                "normalizedMae": float(np.mean(np.abs(left_normalized - right_normalized))),
                "normalizedRmse": float(
                    np.sqrt(np.mean((left_normalized - right_normalized) ** 2))
                ),
                "normalizedPearson": correlation(left_normalized, right_normalized),
                "normalizedSpearman": correlation(rank(left_normalized), rank(right_normalized)),
                "orderingAgreement": float(ordering),
                "referenceP5P95": [left_low, left_high],
                "candidateP5P95": [right_low, right_high],
            }
        )

    def mean(key: str) -> float:
        return float(np.mean([frame[key] for frame in per_frame]))

    return {
        "perFrame": per_frame,
        "aggregate": {
            "rawMaeMean": mean("rawMae"),
            "rawRmseMean": mean("rawRmse"),
            "rawPearsonMean": mean("rawPearson"),
            "rawSpearmanMean": mean("rawSpearman"),
            "normalizedMaeMean": mean("normalizedMae"),
            "normalizedRmseMean": mean("normalizedRmse"),
            "normalizedPearsonMean": mean("normalizedPearson"),
            "normalizedSpearmanMean": mean("normalizedSpearman"),
            "orderingAgreementMean": mean("orderingAgreement"),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path, action="append")
    parser.add_argument("--calibration", required=True, type=Path)
    parser.add_argument("--width", type=int, default=266)
    parser.add_argument("--height", type=int, default=154)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    names, inputs = load_inputs(args.calibration, args.width, args.height)
    reference_info, reference_outputs = run_model(args.reference, inputs, args.warmup)
    result = {
        "schema": 1,
        "frameCount": len(inputs),
        "frames": names,
        "shape": [1, 3, args.height, args.width],
        "reference": {"path": str(args.reference), **reference_info},
        "candidates": [],
    }
    for candidate in args.candidate:
        candidate_info, candidate_outputs = run_model(candidate, inputs, args.warmup)
        result["candidates"].append(
            {
                "path": str(candidate),
                **candidate_info,
                **compare(reference_outputs, candidate_outputs),
            }
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
