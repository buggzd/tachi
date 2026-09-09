# tachi NPU benchmark

This is an intentionally separate Android application for validating the
Qualcomm QNN HTP path. It does not change the Jellyfin playback application or
its WebView bridges. The current validation gate is a single Direct QNN U8
Relu graph; the depth model and its quantization are frozen until that chain
passes.

```bash
python3 -m venv StereoLab/.local/npu/venv311
StereoLab/.local/npu/venv311/bin/pip install onnx onnxruntime pillow
StereoLab/.local/npu/venv311/bin/python StereoLab/prepare-qnn-model.py \
  --source StereoLab/.local/models/depth-anything-v2-small/onnx/model.onnx \
  --calibration StereoLab/.local/npu/calib \
  --output-dir StereoLab/.local/npu --width 266 --height 154 --activation u16
```

Build with the repository's Gradle wrapper and an Android SDK that has platform
35 and build tools 34.0.0:

```bash
ANDROID_HOME=/path/to/android-sdk \
  AndroidApp/gradlew -p StereoLab/npu-benchmark assembleDebug
```

The activity copies only app-readable vendor files and runs the Direct probe
before initializing ONNX Runtime. It records each gate separately:
`backendCreate`, `deviceCreate`, `contextCreate`, `graphCreate`,
`graphFinalize`, `graphExecute`, and `outputCheck`. The probe emits
`directProbeMarker=PASS` only when the graph executes and its U8 Relu output
matches the known reference vector. A provider enumeration or successful
device creation alone is not an NPU inference pass.

The runtime inventory and the current failing gate are recorded in
`docs/performance/2026-09-09-stereo-lab/htp-runtime-compatibility.md`.

```bash
adb install -r StereoLab/npu-benchmark/app/build/outputs/apk/debug/app-debug.apk
adb logcat -c
adb shell am force-stop com.tachi.stereolab.npubenchmark
adb shell monkey -p com.tachi.stereolab.npubenchmark 1
adb logcat -d -s TachiNpuBenchmark:I
```

Wait for `directProbeMarker=PASS` or `directProbeMarker=FAIL`; do not infer a
result from a fixed sleep. The Android app deliberately stops after this
single probe in the current investigation round.

The APK is arm64-only because the target phone is arm64. A failure to create
the session is useful evidence: it indicates a missing/incompatible QNN
backend or an unsupported graph, rather than a CPU fallback being counted as
an NPU result.
