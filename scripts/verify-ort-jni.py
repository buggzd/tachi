#!/usr/bin/env python3
"""Fail Full release builds if R8 removes or renames JNI-visible ORT symbols."""
import re
import sys
from pathlib import Path


def verify(mapping, usage):
    classes = re.findall(r"^(ai\.onnxruntime\.[^ ]+) -> ([^:]+):$", mapping, re.M)
    classes = [(original, renamed) for original, renamed in classes
               if "$$ExternalSynthetic" not in original]
    if not classes or any(original != renamed for original, renamed in classes):
        raise ValueError("ORT JNI classes missing or renamed")
    if re.search(r"^ai\.onnxruntime\.", usage, re.M):
        raise ValueError("R8 removed ORT JNI symbols")
    required = "void <init>(java.lang.String,ai.onnxruntime.ValueInfo)"
    node = re.search(r"^ai\.onnxruntime\.NodeInfo -> ai\.onnxruntime\.NodeInfo:\n((?:[ #].*\n)*)", mapping, re.M)
    if node is None or required not in node.group(1):
        raise ValueError("ORT NodeInfo JNI constructor missing")


if __name__ == "__main__":
    root = Path(sys.argv[1])
    verify((root / "mapping.txt").read_text(), (root / "usage.txt").read_text())
    print("Release ORT JNI retention verified")
