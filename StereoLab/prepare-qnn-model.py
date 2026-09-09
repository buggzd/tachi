"""Prepare fixed-shape QNN QDQ candidates for the Android NPU experiment.

This script writes only to the caller-provided local output directory. Model
weights, calibration frames, and generated ONNX files stay under .local and
are intentionally not part of the repository.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import onnx
from PIL import Image
from onnxruntime.quantization import CalibrationDataReader, CalibrationMethod, QuantType, quantize
from onnxruntime.quantization.execution_providers.qnn import get_qnn_qdq_config, qnn_preprocess_model


MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 1, 3)
STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 1, 3)


def set_shape(value_info: onnx.ValueInfoProto, shape: tuple[int, ...]) -> None:
    dims = value_info.type.tensor_type.shape.dim
    del dims[:]
    for value in shape:
        dims.add().dim_value = value


class ImageReader(CalibrationDataReader):
    def __init__(self, files: list[Path], width: int, height: int, input_name: str) -> None:
        self.input_name = input_name
        self.values = []
        for path in files:
            with Image.open(path) as image:
                rgb = np.asarray(image.convert("RGB").resize((width, height), Image.Resampling.BILINEAR), dtype=np.float32)
            rgb = rgb / 255.0
            rgb = (rgb - MEAN) / STD
            self.values.append({input_name: np.transpose(rgb, (2, 0, 1))[None, ...].astype(np.float32)})
        self.index = 0

    def get_next(self):
        if self.index >= len(self.values):
            return None
        value = self.values[self.index]
        self.index += 1
        return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--calibration", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--width", type=int, default=266)
    parser.add_argument("--height", type=int, default=154)
    parser.add_argument("--activation", choices=("u8", "u16"), default="u8")
    parser.add_argument("--weight", choices=("u8", "i8"), default="u8")
    args = parser.parse_args()
    if args.width % 14 or args.height % 14 or args.width < 14 or args.height < 14:
        raise SystemExit("width and height must be positive multiples of 14")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    input_name = "pixel_values"
    fixed = args.output_dir / f"depth-anything-v2-small-fixed-{args.width}.onnx"
    qnn_preprocess_model(
        args.source,
        fixed,
        exclude_initializer_from_input=True,
        dynamic_input_shapes=[(input_name, f"1,3,{args.height},{args.width}")],
    )
    model = onnx.load(fixed, load_external_data=False)
    set_shape(model.graph.input[0], (1, 3, args.height, args.width))
    for output in model.graph.output:
        if output.name == "predicted_depth":
            set_shape(output, (1, args.height, args.width))
    onnx.save(model, fixed)

    files = sorted(args.calibration.glob("*.png"))
    if len(files) < 3:
        raise SystemExit("at least three calibration PNGs are required")
    reader = ImageReader(files, args.width, args.height, input_name)
    activation = QuantType.QUInt16 if args.activation == "u16" else QuantType.QUInt8
    weight_type = QuantType.QUInt8 if args.weight == "u8" else QuantType.QInt8
    output = args.output_dir / f"depth-anything-v2-small-qnn-{args.width}-{args.activation}a-{args.weight}w.onnx"
    config = get_qnn_qdq_config(
        fixed,
        reader,
        calibrate_method=CalibrationMethod.MinMax,
        activation_type=activation,
        weight_type=weight_type,
        per_channel=True,
        calibration_providers=["CPUExecutionProvider"],
    )
    quantize(fixed, output, config)
    # The 16-bit quantizer may upgrade the opset and restore symbolic output
    # dimensions. QNN HTP needs the complete graph shape to be static for this
    # single-resolution benchmark, so apply the same contract after QDQ.
    quantized = onnx.load(output, load_external_data=False)
    set_shape(quantized.graph.input[0], (1, 3, args.height, args.width))
    for output_info in quantized.graph.output:
        if output_info.name == "predicted_depth":
            set_shape(output_info, (1, args.height, args.width))
    onnx.save(quantized, output)
    print(f"fixed={fixed}")
    print(f"quantized={output}")


if __name__ == "__main__":
    main()
