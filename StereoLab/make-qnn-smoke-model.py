#!/usr/bin/env python3
"""Create a tiny static QDQ Conv/Relu model for the Android QNN probe.

The model intentionally has no dynamic dimensions or model-specific operators.
It is used to separate QNN runtime/HTP graph support from failures in the
Depth Anything graph.  The ONNX input and output are float tensors; QDQ nodes
make the Conv itself an 8-bit quantized candidate for QNN HTP.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def initializer(name: str, values: np.ndarray) -> onnx.TensorProto:
    return numpy_helper.from_array(values, name=name)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--operation", choices=("conv_relu", "relu"), default="conv_relu")
    parser.add_argument(
        "--io-quantized",
        action="store_true",
        help="Expose uint8 graph input/output and keep Q/DQ inside the graph",
    )
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)

    input_shape = [1, 3, 8, 8]
    output_shape = [1, 2, 8, 8]
    if args.operation == "relu":
        scale = initializer("scale", np.asarray(0.05, dtype=np.float32))
        zero = initializer("zero", np.asarray(128, dtype=np.uint8))
        input_type = TensorProto.UINT8 if args.io_quantized else TensorProto.FLOAT
        output_type = TensorProto.UINT8 if args.io_quantized else TensorProto.FLOAT
        relu_nodes = []
        if not args.io_quantized:
            relu_nodes.append(
                helper.make_node(
                    "QuantizeLinear", ["input", "scale", "zero"], ["input_q"],
                    name="input_quantize",
                )
            )
        relu_nodes.append(
            helper.make_node(
                "DequantizeLinear",
                ["input" if args.io_quantized else "input_q", "scale", "zero"],
                ["input_dq"],
                name="input_dequantize",
            )
        )
        relu_nodes.append(helper.make_node("Relu", ["input_dq"], ["relu"], name="qnn_smoke_relu"))
        relu_nodes.append(
            helper.make_node(
                "QuantizeLinear", ["relu", "scale", "zero"],
                ["output" if args.io_quantized else "output_q"],
                name="output_quantize",
            )
        )
        if not args.io_quantized:
            relu_nodes.append(
                helper.make_node(
                    "DequantizeLinear", ["output_q", "scale", "zero"], ["output"],
                    name="output_dequantize",
                )
            )
        graph = helper.make_graph(
            relu_nodes,
            "qnn_smoke_relu",
            [helper.make_tensor_value_info("input", input_type, input_shape)],
            [helper.make_tensor_value_info("output", output_type, input_shape)],
            initializer=[scale, zero],
        )
        model = helper.make_model(
            graph,
            producer_name="tachi-stereo-lab",
            opset_imports=[helper.make_opsetid("", 13)],
        )
        model.ir_version = 10
        onnx.checker.check_model(model)
        onnx.save(model, args.output)
        print(f"wrote={args.output}")
        return

    input_scale = np.asarray(0.05, dtype=np.float32)
    input_zero = np.asarray(128, dtype=np.uint8)
    weight_scale = np.asarray(0.02, dtype=np.float32)
    weight_zero = np.asarray(0, dtype=np.int8)
    output_scale = np.asarray(0.05, dtype=np.float32)
    output_zero = np.asarray(0, dtype=np.uint8)

    # A deterministic, non-degenerate kernel gives the execution check a
    # repeatable output checksum while remaining tiny enough to inspect.
    weights = np.asarray(
        [
            [[[2, -1, 0], [1, 0, -1], [0, 1, 2]],
             [[-2, 1, 0], [0, 1, 2], [1, 0, -1]],
             [[1, 1, 1], [0, 0, 0], [-1, -1, -1]]],
            [[[-1, 2, 1], [0, 1, 0], [1, -2, -1]],
             [[1, 0, -1], [2, 0, -2], [1, 0, -1]],
             [[0, -1, 0], [-1, 4, -1], [0, -1, 0]]],
        ],
        dtype=np.int8,
    )
    bias = np.asarray([3, -2], dtype=np.int32)

    nodes = []
    if not args.io_quantized:
        nodes.append(helper.make_node(
            "QuantizeLinear",
            ["input", "input_scale", "input_zero"],
            ["input_q"],
            name="input_quantize",
        ))
    nodes.extend([
        helper.make_node(
            "DequantizeLinear",
            ["input" if args.io_quantized else "input_q", "input_scale", "input_zero"],
            ["input_dq"],
            name="input_dequantize",
        ),
        helper.make_node(
            "DequantizeLinear",
            ["weight_q", "weight_scale", "weight_zero"],
            ["weight_dq"],
            name="weight_dequantize",
        ),
        helper.make_node(
            "DequantizeLinear",
            ["bias_q", "bias_scale", "bias_zero"],
            ["bias_dq"],
            name="bias_dequantize",
        ),
        helper.make_node(
            "Conv",
            ["input_dq", "weight_dq", "bias_dq"],
            ["conv"],
            name="qnn_smoke_conv",
            pads=[1, 1, 1, 1],
            strides=[1, 1],
            dilations=[1, 1],
            group=1,
        ),
        helper.make_node("Relu", ["conv"], ["relu"], name="qnn_smoke_relu"),
        helper.make_node(
            "QuantizeLinear",
            ["relu", "output_scale", "output_zero"],
            ["output" if args.io_quantized else "output_q"],
            name="output_quantize",
        ),
    ])
    if not args.io_quantized:
        nodes.append(helper.make_node(
            "DequantizeLinear",
            ["output_q", "output_scale", "output_zero"],
            ["output"],
            name="output_dequantize",
        ))
    input_type = TensorProto.UINT8 if args.io_quantized else TensorProto.FLOAT
    output_type = TensorProto.UINT8 if args.io_quantized else TensorProto.FLOAT
    graph = helper.make_graph(
        nodes,
        "qnn_smoke_qdq_conv_relu",
        [helper.make_tensor_value_info("input", input_type, input_shape)],
        [helper.make_tensor_value_info("output", output_type, output_shape)],
        initializer=[
            initializer("input_scale", input_scale),
            initializer("input_zero", input_zero),
            initializer("weight_q", weights),
            initializer("weight_scale", weight_scale),
            initializer("weight_zero", weight_zero),
            initializer("bias_q", bias),
            initializer("bias_scale", input_scale * weight_scale),
            initializer("bias_zero", np.asarray(0, dtype=np.int32)),
            initializer("output_scale", output_scale),
            initializer("output_zero", output_zero),
        ],
    )
    model = helper.make_model(
        graph,
        producer_name="tachi-stereo-lab",
        opset_imports=[helper.make_opsetid("", 13)],
    )
    # The Android QNN ORT 1.22 build accepts ONNX IR through version 10.
    # Opset 13 is still used for the standard QDQ operators above.
    model.ir_version = 10
    onnx.checker.check_model(model)
    onnx.save(model, args.output)
    print(f"wrote={args.output}")


if __name__ == "__main__":
    main()
