#!/usr/bin/env python3
"""Validate the Direct QNN U8 Relu quantization reference on the host.

QNN's scale-offset encoding is:

    real_value = (quantized_value + offset) * scale

For an unsigned 8-bit tensor with zero point 128, the QNN offset is therefore
-128.  This script keeps the exact input and expected output vectors used by
the Android Direct probe and checks dequantize -> Relu -> requantize on the
host before any device run.
"""

from __future__ import annotations

import argparse
import json
import math
from typing import Any


SCALE = 0.05
OFFSET = -128
INPUT = [0, 64, 96, 127, 128, 129, 160, 200, 255, 1, 32, 80, 140, 180, 220, 250]
EXPECTED = [128, 128, 128, 128, 128, 129, 160, 200, 255, 128, 128, 128, 140, 180, 220, 250]


def quantize_relu(value: int) -> tuple[float, float, int]:
    dequantized = (value + OFFSET) * SCALE
    relu = max(0.0, dequantized)
    # All values in this fixed vector are away from half-integer ties.  The
    # explicit floor(value + 0.5) documents round-to-nearest for non-negative
    # QNN output values without depending on Python's bankers-rounding rule.
    requantized = math.floor(relu / SCALE - OFFSET + 0.5)
    return dequantized, relu, max(0, min(255, requantized))


def build_report() -> dict[str, Any]:
    stages = [quantize_relu(value) for value in INPUT]
    actual = [stage[2] for stage in stages]
    return {
        "formula": "real=(quantized+offset)*scale",
        "scale": SCALE,
        "offset": OFFSET,
        "input": INPUT,
        "dequantized": [stage[0] for stage in stages],
        "relu": [stage[1] for stage in stages],
        "requantized": actual,
        "expected": EXPECTED,
        "pass": actual == EXPECTED,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="print the full report as JSON")
    args = parser.parse_args()
    report = build_report()
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"formula={report['formula']}")
        print(f"scale={report['scale']} offset={report['offset']}")
        print(f"input={report['input']}")
        print(f"dequantized={report['dequantized']}")
        print(f"relu={report['relu']}")
        print(f"requantized={report['requantized']}")
        print(f"expected={report['expected']}")
        print(f"quantReference={'PASS' if report['pass'] else 'FAIL'}")
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
