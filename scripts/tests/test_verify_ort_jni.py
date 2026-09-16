import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("ort", Path(__file__).resolve().parents[1] / "verify-ort-jni.py")
ort = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ort)


class OrtJniTests(unittest.TestCase):
    mapping = "ai.onnxruntime.NodeInfo -> ai.onnxruntime.NodeInfo:\n    1:2:void <init>(java.lang.String,ai.onnxruntime.ValueInfo):1:2 -> <init>\n"

    def test_kept_jni_constructor_passes(self):
        ort.verify(self.mapping, "other.Unused\n")
        ort.verify(self.mapping + "ai.onnxruntime.TensorInfo$$ExternalSyntheticLambda0 -> ai.onnxruntime.a:\n", "")

    def test_removed_constructor_fails(self):
        with self.assertRaises(ValueError):
            ort.verify(self.mapping.split("\n")[0] + "\n", "")
        with self.assertRaises(ValueError):
            ort.verify(self.mapping, "ai.onnxruntime.NodeInfo:\n    void <init>()\n")

    def test_renamed_or_missing_classes_fail(self):
        for mapping in ("", self.mapping + "ai.onnxruntime.ValueInfo -> a.b:\n"):
            with self.assertRaises(ValueError):
                ort.verify(mapping, "")
