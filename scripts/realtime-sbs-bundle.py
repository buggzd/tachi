#!/usr/bin/env python3
"""Pack/install only the hash-pinned local QNN inputs; verify release APK contents."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MODEL = "depth-anything-v2-small-qnn-266-u16a-i8w.onnx"
ORT = "onnxruntime-android-qnn-1.22.0.aar"
MAX_FILE = 256 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024


def expected_files(manifest):
    return {MODEL: manifest["modelSha256"], ORT: manifest["ortSha256"], **{
        f"qairt-runtime/arm64-v8a/{name}": digest for name, digest in manifest["libraries"].items()
    }}


def checked(data, digest):
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("QNN dependency hash mismatch")
    return data


def pack(root, archive, expected):
    # Validate everything before creating an archive; never collect credentials or other SDK files.
    for name, digest in expected.items():
        checked((root / name).read_bytes(), digest)
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name in expected:
            bundle.write(root / name, name)


def install(archive, root, expected):
    with zipfile.ZipFile(archive) as bundle, tempfile.TemporaryDirectory() as temporary:
        entries = bundle.infolist()
        if len(entries) != len(expected) or {entry.filename for entry in entries} != set(expected):
            raise ValueError("QNN bundle must contain exactly the pinned dependency files")
        if any(entry.file_size > MAX_FILE for entry in entries) or sum(e.file_size for e in entries) > MAX_TOTAL:
            raise ValueError("QNN bundle exceeds size limit")
        # Never extract archive paths. Write only manifest-selected names, after all hashes pass.
        staged = Path(temporary)
        for name, digest in expected.items():
            target = staged / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(checked(bundle.read(name), digest))
        for name in expected:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((staged / name).read_bytes())


def verify_apk(apk, variant, manifest):
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
            checked(bundle.read("assets/realtime-sbs/depth.onnx"), manifest["modelSha256"])
            for name, digest in manifest["libraries"].items():
                checked(bundle.read(f"lib/arm64-v8a/{name}"), digest)
            for name in ("libonnxruntime.so", "libonnxruntime4j_jni.so"):
                if f"lib/arm64-v8a/{name}" not in names:
                    raise ValueError("Full APK missing ORT runtime")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("pack", "install", "verify-apk"))
    parser.add_argument("archive", type=Path)
    parser.add_argument("--root", type=Path, default=ROOT / "StereoLab/.local/npu")
    parser.add_argument("--variant", choices=("lite", "full"), default="full")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "AndroidApp/realtime-sbs-runtime.json").read_text())
    try:
        if args.operation == "verify-apk":
            verify_apk(args.archive, args.variant, manifest)
        elif args.operation == "pack":
            pack(args.root, args.archive, expected_files(manifest))
        else:
            install(args.archive, args.root, expected_files(manifest))
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        # Do not echo paths or input URLs from an untrusted archive / CI secret.
        raise SystemExit(f"QNN {args.operation} failed ({type(error).__name__}); check pinned inputs and bundle format") from None
    print(f"QNN {args.operation} verified")


if __name__ == "__main__":
    main()
