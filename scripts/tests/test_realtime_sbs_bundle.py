import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
import warnings
import zipfile

spec = importlib.util.spec_from_file_location("bundle", Path(__file__).resolve().parents[1] / "realtime-sbs-bundle.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class RealtimeBundleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.archive = self.root / "bundle.zip"
        self.destination = self.root / "installed"
        self.expected = {"model.onnx": hashlib.sha256(b"model").hexdigest()}

    def test_round_trip_only_includes_whitelisted_files(self):
        source = self.root / "source"
        source.mkdir()
        (source / "model.onnx").write_bytes(b"model")
        (source / "credential.txt").write_bytes(b"private")
        bundle.pack(source, self.archive, self.expected)
        bundle.install(self.archive, self.destination, self.expected)
        self.assertEqual([p.name for p in self.destination.iterdir()], ["model.onnx"])
        self.assertEqual((self.destination / "model.onnx").read_bytes(), b"model")

    def test_bad_hash_never_overwrites_installed_dependency(self):
        self.destination.mkdir()
        (self.destination / "model.onnx").write_bytes(b"existing")
        with zipfile.ZipFile(self.archive, "w") as output:
            output.writestr("model.onnx", b"corrupted")
        with self.assertRaises(ValueError):
            bundle.install(self.archive, self.destination, self.expected)
        self.assertEqual((self.destination / "model.onnx").read_bytes(), b"existing")

    def test_traversal_unknown_duplicate_and_missing_entries_are_rejected(self):
        for names in (["../model.onnx"], ["model.onnx", "secret"], ["model.onnx", "model.onnx"], []):
            with self.subTest(names=names), warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(self.archive, "w") as output:
                    for name in names:
                        output.writestr(name, b"model")
                with self.assertRaises(ValueError):
                    bundle.install(self.archive, self.destination, self.expected)
                self.assertFalse(self.destination.exists())

    def test_lite_rejects_model_or_runtime_leaking_from_previous_full_build(self):
        for name in ("assets/realtime-sbs/depth.onnx", "lib/arm64-v8a/libQnnHtp.so", "lib/arm64-v8a/libonnxruntime.so"):
            with self.subTest(name=name):
                with zipfile.ZipFile(self.archive, "w") as output:
                    output.writestr(name, b"dependency")
                with self.assertRaises(ValueError):
                    bundle.verify_apk(self.archive, "lite", {})

    def test_unreferenced_incremental_zip_bytes_cannot_ship_as_a_lite_apk(self):
        with zipfile.ZipFile(self.archive, "w") as output:
            output.writestr("classes.dex", b"bytecode")
        # A prefix models unused archive data while keeping the ZIP index perfectly readable.
        self.archive.write_bytes(b"x" * (9 * 1024 * 1024) + self.archive.read_bytes())
        with self.assertRaises(ValueError):
            bundle.verify_apk(self.archive, "lite", {})

    def test_full_checks_exact_dsp_bytes_and_requires_ort(self):
        manifest = {"modelSha256": hashlib.sha256(b"model").hexdigest(), "libraries": {
            "libQnnHtpV81Skel.so": hashlib.sha256(b"dsp").hexdigest()}}
        for data, ort, valid in ((b"dsp", True, True), (b"stripped-dsp", True, False), (b"dsp", False, False)):
            with self.subTest(data=data, ort=ort):
                with zipfile.ZipFile(self.archive, "w") as output:
                    output.writestr("assets/realtime-sbs/depth.onnx", b"model")
                    output.writestr("lib/arm64-v8a/libQnnHtpV81Skel.so", data)
                    if ort:
                        output.writestr("lib/arm64-v8a/libonnxruntime.so", b"ort")
                        output.writestr("lib/arm64-v8a/libonnxruntime4j_jni.so", b"jni")
                if valid:
                    bundle.verify_apk(self.archive, "full", manifest)
                else:
                    with self.assertRaises(ValueError):
                        bundle.verify_apk(self.archive, "full", manifest)
