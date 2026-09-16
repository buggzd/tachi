#!/usr/bin/env python3
"""Verify hash-pinned local QNN inputs or APK contents; never distribute SDK bundles."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MODEL = "depth-anything-v2-small-qnn-266-u16a-i8w.onnx"
ORT = "onnxruntime-android-qnn-1.22.0.aar"
NOTICES = ("qairt/LICENSE.pdf", "qairt/NOTICE.txt", "qairt/QNN_NOTICE.txt",
           "Apache-2.0.txt", "THIRD_PARTY_NOTICES.md",
           "onnxruntime-LICENSE.txt", "onnxruntime-ThirdPartyNotices.txt")


def model_entry(manifest, resolution=392):
    if resolution == 266:
        return MODEL, manifest["modelSha256"]
    if resolution != 392:
        raise ValueError("Unsupported depth resolution")
    entry = manifest["experimentalModels"][str(resolution)]
    return entry["file"], entry["sha256"]


def expected_files(manifest, resolution=392):
    model, digest = model_entry(manifest, resolution)
    return {model: digest, ORT: manifest["ortSha256"], **{
        f"qairt-runtime/arm64-v8a/{name}": digest for name, digest in manifest["libraries"].items()
    }}


def checked(data, digest):
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("QNN dependency hash mismatch")
    return data


def verify_local(root, expected):
    for name, digest in expected.items():
        checked((root / name).read_bytes(), digest)
    for name in ("LICENSE.pdf", "NOTICE.txt", "QNN_NOTICE.txt"):
        if not (root / "qpm-official/sdk" / name).read_bytes():
            raise ValueError("Missing QAIRT license or notice")


def verify_apk(apk, variant, manifest, resolution=392):
    with zipfile.ZipFile(apk) as bundle:
        # Signing/alignment needs little space; large gaps indicate an incremental ZIP with stale bytes.
        if apk.stat().st_size - sum(entry.compress_size for entry in bundle.infolist()) > 8 * 1024 * 1024:
            raise ValueError("APK has excessive ZIP overhead; recreate its output before packaging")
        names = bundle.namelist()
        qnn = [name for name in names if name.startswith("assets/realtime-sbs/")
               or Path(name).name.startswith(("libQnn", "libonnxruntime", "libCalculator"))]
        if variant == "lite":
            if qnn:
                raise ValueError("Lite APK unexpectedly contains the model or QNN/ORT runtime")
        else:
            for notice in NOTICES:
                if not bundle.read(f"assets/realtime-sbs/licenses/{notice}"):
                    raise ValueError("Full APK missing license or notice")
            checked(bundle.read("assets/realtime-sbs/depth.onnx"), model_entry(manifest, resolution)[1])
            for name, digest in manifest["libraries"].items():
                checked(bundle.read(f"lib/arm64-v8a/{name}"), digest)
            for name in ("libonnxruntime.so", "libonnxruntime4j_jni.so"):
                if f"lib/arm64-v8a/{name}" not in names:
                    raise ValueError("Full APK missing ORT runtime")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("verify-local", "verify-apk"))
    parser.add_argument("archive", type=Path, nargs="?")
    parser.add_argument("--root", type=Path, default=ROOT / "StereoLab/.local/npu")
    parser.add_argument("--variant", choices=("lite", "full"), default="full")
    parser.add_argument("--resolution", choices=(266, 392), type=int, default=392)
    args = parser.parse_args()
    manifest = json.loads((ROOT / "AndroidApp/realtime-sbs-runtime.json").read_text())
    try:
        if args.operation == "verify-apk":
            if args.archive is None:
                parser.error("verify-apk requires an APK path")
            verify_apk(args.archive, args.variant, manifest, args.resolution)
        else:
            verify_local(args.root, expected_files(manifest, args.resolution))
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        # Do not echo paths or input URLs from an untrusted archive / CI secret.
        raise SystemExit(f"QNN {args.operation} failed ({type(error).__name__}); check pinned inputs, notices and APK format") from None
    print(f"QNN {args.operation} verified")


if __name__ == "__main__":
    main()
