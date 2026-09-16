import hashlib
import importlib.util
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("bundle", Path(__file__).resolve().parents[1] / "realtime-sbs-bundle.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class RealtimeBundleTests(unittest.TestCase):
    def test_default_full_requires_392_and_legacy_266_remains_explicit(self):
        manifest = {"modelSha256": hashlib.sha256(b"baseline").hexdigest(), "libraries": {},
                    "experimentalModels": {"392": {"file": "resolution-392/model.onnx",
                                                    "sha256": hashlib.sha256(b"high-res").hexdigest()}}}
        with zipfile.ZipFile(self.archive, "w") as output:
            for notice in bundle.NOTICES:
                output.writestr(f"assets/realtime-sbs/licenses/{notice}", b"license")
            output.writestr("assets/realtime-sbs/depth.onnx", b"high-res")
            output.writestr("lib/arm64-v8a/libonnxruntime.so", b"ort")
            output.writestr("lib/arm64-v8a/libonnxruntime4j_jni.so", b"jni")
        bundle.verify_apk(self.archive, "full", manifest)
        with self.assertRaises(ValueError):
            bundle.verify_apk(self.archive, "full", manifest, 266)
        with self.assertRaises(ValueError):
            bundle.model_entry(manifest, 518)

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.archive = self.root / "bundle.zip"
        self.expected = {"model.onnx": hashlib.sha256(b"model").hexdigest()}

    def test_local_inputs_require_matching_hashes_and_notices(self):
        (self.root / "model.onnx").write_bytes(b"model")
        notices = self.root / "qpm-official/sdk"
        notices.mkdir(parents=True)
        for name in ("LICENSE.pdf", "NOTICE.txt", "QNN_NOTICE.txt"):
            (notices / name).write_bytes(b"license")
        bundle.verify_local(self.root, self.expected)
        (self.root / "model.onnx").write_bytes(b"corrupted")
        with self.assertRaises(ValueError):
            bundle.verify_local(self.root, self.expected)
        (self.root / "model.onnx").write_bytes(b"model")
        (notices / "NOTICE.txt").write_bytes(b"")
        with self.assertRaises(ValueError):
            bundle.verify_local(self.root, self.expected)

    def test_full_requires_notices(self):
        for missing in bundle.NOTICES:
            with self.subTest(missing=missing):
                with zipfile.ZipFile(self.archive, "w") as output:
                    for notice in bundle.NOTICES:
                        if notice != missing:
                            output.writestr(f"assets/realtime-sbs/licenses/{notice}", b"license")
                with self.assertRaises(KeyError):
                    bundle.verify_apk(self.archive, "full", {})

    def test_standalone_bundle_commands_are_not_available(self):
        for operation in ("pack", "install"):
            result = subprocess.run([sys.executable, bundle.__file__, operation, str(self.archive)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertFalse(self.archive.exists())

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
                    for notice in bundle.NOTICES:
                        output.writestr(f"assets/realtime-sbs/licenses/{notice}", b"license")
                    output.writestr("assets/realtime-sbs/depth.onnx", b"model")
                    output.writestr("lib/arm64-v8a/libQnnHtpV81Skel.so", data)
                    if ort:
                        output.writestr("lib/arm64-v8a/libonnxruntime.so", b"ort")
                        output.writestr("lib/arm64-v8a/libonnxruntime4j_jni.so", b"jni")
                if valid:
                    bundle.verify_apk(self.archive, "full", manifest, 266)
                else:
                    with self.assertRaises(ValueError):
                        bundle.verify_apk(self.archive, "full", manifest, 266)
