# HTP V81 runtime compatibility inventory

This inventory freezes the depth model and quantization work. It records the
runtime chain used by the Direct QNN probe on the Xiaomi `2509FPN0BC` device
(Android 16, board `canoe`, `soc_model=660`). “Exists”, “app-readable”,
“dynamically loaded”, and “dependency resolved” are separate observations.

## Host and app inputs

| Component | Source and version evidence | Exists | App-readable | Dynamically loaded | Dependency resolved |
| --- | --- | --- | --- | --- | --- |
| ONNX Runtime QNN AAR | `StereoLab/.local/npu/onnxruntime-android-qnn-1.22.0.aar`; SHA-256 `8be5cc2e5a56bf44673582661ca0e3731c12a9d57fae789c92f367e67755275f`; contains ORT 1.22.0 arm64 JNI libraries and no Qualcomm QNN vendor libraries | yes | yes (Gradle file dependency) | ORT provider was enumerable in the earlier ORT run; excluded from this single-probe run | not established against this phone’s HTP set |
| QNN headers | Repository copy `StereoLab/npu-benchmark/app/src/main/cpp/qnn_include/QNN`; `QNN_API_VERSION_MAJOR/MINOR/PATCH = 2.37.0`; deterministic tree SHA-256 `20edfa7cb4c2e853d9d649754f151fa254cb9531c574be87ebbdbfba9d07b358`; Qualcomm copyright, but no SDK archive or manifest records the source release | yes | yes (compiled into probe) | n/a (headers) | ABI match is unproven; provider reports core API 2.25.0 |

The ORT documentation currently says the QNN EP was built and tested with QNN
2.22.x, while the probe headers are 2.37.0 and the phone reports a provider
API of 2.25.0 with an HTP backend build ID beginning `v2.33`. This is a
version-alignment gap, not evidence that the SoC lacks compute capability.
Reference: [ORT QNN EP documentation](https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html),
“QNN Version Requirements” and “Install prerequisites”.

## Phone runtime files

| Component | Phone path and observed size | Exists | App-readable / copied | Direct probe load | Dependency result |
| --- | --- | --- | --- | --- | --- |
| HTP backend | `/vendor/lib64/libQnnHtp.so`, 2,134,976 bytes | yes | yes; copied to app-private `files/qnn-libs` | yes (`load=... ok`) | `backendCreate=0x0`, provider enumeration succeeds; graph dependency chain does not |
| QNN system | `/vendor/lib64/libQnnSystem.so`, 1,750,320 bytes | yes | yes; copied | not loaded by the standalone Direct probe | no graph evidence |
| FastRPC | `/vendor/lib64/libcdsprpc.so`, 612,672 bytes | yes | yes; copied | yes | FastRPC session and DSP handle open |
| HTP V81 host stub | `/vendor/lib64/libQnnHtpV81Stub.so`, 484,016 bytes | yes | yes; copied | yes | V81 DSP handle opens |
| HTP NetRun extensions | `/vendor/lib64/libQnnHtpNetRunExtensions.so`, 703,224 bytes | yes | yes; copied | yes | no failure before graph creation |
| HTP Prepare | `/vendor/lib64/libQnnHtpPrepare.so` | yes (directory listing) | **no**; shell and app copy report `EACCES` | **no**; `dlopen ... not found` | QnnDsp reports `PrepareLibLoader Failed loading ...` and aborts |
| V81 Calculator stub | `/vendor/lib64/libQnnHtpV81CalculatorStub.so` | yes (directory listing) | **no**; shell and app copy report `EACCES` | **no**; `dlopen ... not found` | unresolved; no graph can be treated as complete |
| V81 DSP skel | `/vendor/lib/rfsa/adsp/libQnnHtpV81Skel.so`, 8,756,920 bytes | yes | direct file copy was not used | FastRPC opens `file:///libQnnHtpV81Skel.so` successfully | DSP transport reaches the V81 skel; this does not supply the missing host Prepare library |

The APK copies only the five world-readable files. The two files that the HTP
backend attempts to load during graph creation are present in the vendor
partition but inaccessible to the unprivileged application. `uses-native-library`
declarations do not change those file permissions or provide the missing
linker dependency set.

## Direct-chain result

The final single-probe run waited for `directProbeMarker` rather than stopping
the process after a fixed delay. The observed stages were:

```text
providerBackendId=6 provider=HTP_QTI_AISW api=2.25.0
backendCreate=0x0(code=0)
deviceCreate[soc+signedpd]=0x0(code=0)
contextCreate=0x0(code=0) message=QNN_SUCCESS
graphCreate=0x3f1(code=1009) message=QNN_COMMON_ERROR_LOADING_BINARIES: Attempt to reload library already loaded in this process
directProbeStage=graphCreate
directProbeMarker=FAIL stage=graph
```

The adjacent QnnDsp log gives the missing dependency that precedes the generic
QNN error:

```text
PrepareLibLoader Loading libQnnHtpPrepare.so
PrepareLibLoader Failed loading libQnnHtpPrepare.so with error: dlopen failed: library "libQnnHtpPrepare.so" not found
HTP Prepare backend loading failed. Aborting
```

Therefore the first failed chain stage is `graphCreate`. `graphFinalize`,
`graphExecute`, and output comparison were not reached. Provider enumeration
and device creation are passes only for their own stages; they are not an NPU
inference pass.

## Single-hypothesis experiment record

| Hypothesis | Change for this run | Expected result | Actual result | Decision |
| --- | --- | --- | --- | --- |
| The application-readable QNN set is sufficient to execute a Direct QNN U8 Relu graph on HTP V81. | Froze the depth model, quantization, device configuration, and loader strategy; ran only the standalone Direct probe with a bounded marker wait. | `backendCreate`, `deviceCreate`, `contextCreate`, `graphCreate`, `graphFinalize`, `graphExecute`, and `outputCheck` all pass, with the known Relu vector. | `backendCreate`, `deviceCreate`, and `contextCreate` passed; `graphCreate` returned `0x3f1` while QnnDsp reported missing `libQnnHtpPrepare.so`. Later gates were not reached. | Reject. Stop this line of testing until an official, internally compatible and deployable QAIRT/QNN V81 runtime is available. |

This run rules out “the provider cannot be enumerated” and “device creation alone is
the execution proof.” It does not rule out a valid HTP deployment with the matching
Prepare/Calculator libraries, and it provides no evidence about phone compute
capacity or the frozen depth model.

## Required environment to resume

Obtain one official, internally consistent Qualcomm AI Engine Direct / QAIRT
runtime set for the phone’s HTP V81 firmware, including the matching HTP
backend, `libQnnHtpPrepare.so`, V81 Calculator/Stub components, system and
FastRPC dependencies, and the corresponding V81 DSP skel. Record the SDK/QAIRT
version and checksum. The current workspace does not contain that SDK or a
deployable copy of the protected libraries, so an offline context binary is not
an actionable substitute yet. It must be generated with a matching QNN/QAIRT
toolchain and validated against the same V81 firmware before loading on the
device.
