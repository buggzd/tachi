# tachi NPU benchmark

This is an intentionally separate Android application for validating the
Qualcomm QNN HTP path. It does not change the Jellyfin playback application or
its WebView bridges. The Direct QNN U8 Relu gate now passes on SM8850 with
official QAIRT 2.50.40. The smoke and depth stages run only after that gate
passes, with CPU fallback disabled.

```bash
python3 -m venv StereoLab/.local/npu/venv311
StereoLab/.local/npu/venv311/bin/pip install onnx onnxruntime pillow
StereoLab/.local/npu/venv311/bin/python StereoLab/prepare-qnn-model.py \
  --source StereoLab/.local/models/depth-anything-v2-small/onnx/model.onnx \
  --calibration StereoLab/.local/npu/calib \
  --output-dir StereoLab/.local/npu --width 266 --height 154 --activation u16 --weight i8
```

Build with the repository's Gradle wrapper and an Android SDK that has platform
35 and build tools 34.0.0:

```bash
ANDROID_HOME=/path/to/android-sdk \
  AndroidApp/gradlew -p StereoLab/npu-benchmark assembleDebug
```

For official SDK deployment, point the ignored `.local/npu/qairt-sdk` at the
extracted SDK root. Copy the matching ARM64 libraries into
`.local/npu/qairt-runtime/arm64-v8a`: `libQnnHtp.so`, `libQnnHtpPrepare.so`,
`libQnnHtpV81Stub.so`, `libQnnHtpV81CalculatorStub.so`,
`libQnnHtpNetRunExtensions.so`, and `libQnnSystem.so`. From that same SDK
`lib/hexagon-v81/unsigned`, include `libQnnHtpV81Skel.so`,
`libQnnHtpV81.so`, and `libCalculator_skel.so`. Keep source hashes locally.
Gradle uses the SDK headers and packages this runtime; the native probe
requests an unsigned PD and searches the application library directory first.
Platform FastRPC remains supplied by Android. Do not mix vendor QNN copies
with this set. The legacy vendor-copy path exists only for earlier diagnostics.

The activity runs the Direct probe before initializing ONNX Runtime. It records each gate separately:
`backendCreate`, `deviceCreate`, `contextCreate`, `graphCreate`,
`graphFinalize`, `graphExecute`, and `outputCheck`. The probe emits
`directProbeMarker=PASS` only when the graph executes and its U8 Relu output
matches the known reference vector. A provider enumeration or successful
device creation alone is not an NPU inference pass. It selects the HTP provider
by backend ID and requires the provider's QNN major/minor API to match the
headers used to compile the probe; a mismatch exits with
`directProbeMarker=FAIL stage=apiCompatibility` before any interface-table call.

The runtime inventory and the current failing gate are recorded in
`docs/performance/2026-09-09-stereo-lab/htp-runtime-compatibility.md`.

Before a device run, validate the fixed U8 Relu vector on the host:

```bash
python3 StereoLab/validate-qnn-relu-reference.py
```

The QNN scale-offset convention is `real = (quantized + offset) * scale`.
For scale `0.05` and U8 zero point `128`, the QNN offset is `-128`; the host
check covers dequantization, ReLU, re-quantization, and the expected output
vector. The native probe repeats this check and emits `quantReference=PASS`
before loading the provider interface table.

```bash
adb install -r StereoLab/npu-benchmark/app/build/outputs/apk/debug/app-debug.apk
adb shell am force-stop com.tachi.stereolab.npubenchmark
adb shell am start -n com.tachi.stereolab.npubenchmark/.MainActivity \
  --es benchmark_stage depth --ei measured_runs 3000
adb logcat -d -s TachiNpuBenchmark:I
```

Wait for `directProbeMarker=PASS` or `directProbeMarker=FAIL`; do not infer a
result from a fixed sleep. Stages are `direct` (default), `smoke`, and `depth`.
Depth uses the U16/I8 model. `measured_runs` is bounded to 30–12000, with
five warmup runs. Wait for `benchmarkMarker` for smoke/depth completion.
A temporary foreground service keeps the local computation active when Chrome
is foreground; it stops when the benchmark completes and is not restarted.
Wait for `QNN_DEPTHSessionInitMs` before switching to Chrome. An Activity-only
background process can be frozen by Android, so merely launching both apps is
not evidence of concurrent work. Correlate profile timestamps with compositor
measurementStartEpochMs/measurementEndEpochMs.

Collect process-scoped logs and app-private ORT profiles; verify that execution
events use QNNExecutionProvider. `TENSOR_AND_RUN` includes tensor creation,
inference and output readback, but excludes video capture and preprocessing.
The last depth input/output are saved as big-endian float32 in app-private files
after timing, for numerical comparison.

The APK is arm64-only because the target phone is arm64. A failure to create
the session is useful evidence: it indicates a missing/incompatible QNN
backend or an unsupported graph, rather than a CPU fallback being counted as
an NPU result.

## Full depth-model shared-buffer stage

After the product playback baseline, use the matching local SDK/runtime and a
manifest-verified model to run the explicit `fullshared` stage:

```bash
AndroidApp/gradlew -p StereoLab/npu-benchmark -PbenchmarkResolution=518 :app:assembleDebug :app:lintDebug
adb install -r StereoLab/npu-benchmark/app/build/outputs/apk/debug/app-debug.apk
adb shell am force-stop com.tachi.stereolab.npubenchmark
adb shell am start -n com.tachi.stereolab.npubenchmark/.MainActivity --es benchmark_stage fullshared --es soc_model 660
```

Run commands from the repository root. `benchmarkResolution` accepts 266 (default),
392 and 518. The default direct/Relu entry remains unchanged. Do not run this
benchmark concurrently with product performance measurements.

The stage exports an ORT QNN context with CPU fallback disabled, saves three
calibration-image tensor/reference pairs in the app's private test directory,
closes ORT, then reads QNN System metadata and restores the single full graph.
It verifies ordinary native output against ORT, registers AHardwareBuffer BLOB
input/output using the HTP custom shared-buffer descriptor, and alternates the
three input tensors using GPU compute. GPU output verification reads only four
status bytes per iteration; a four-byte status reset is written by the host.
Image tensors are uploaded to GPU reference storage once before measurement.
The first CPU buffer initialization identifies the exported data fd safely.

This tests the **full model's shared I/O**, with 5 warmups and 100 measured
iterations. It is not a live-video preprocessing or SBS rendering benchmark;
`glFinish` and synchronous `graphExecute` deliberately establish visibility.
It does not replace the product's ORT Java backend. The exact graph descriptor,
validation tolerance and timings are logged as `fullDepth*`, followed by
`FULL_SHARED_COMPLETE`. Completion alone is not success: require
`fullDepthShared=PASS` and successful context/device/backend cleanup.
See [product baseline and full-model results](../../docs/performance/2026-09-13-daily-sbs/README.md).
