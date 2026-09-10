# HTP V81 runtime compatibility inventory

> Historical vendor-copy investigation. Superseded for current deployment by
> [official QAIRT device validation](qairt-device.md): the complete SDK was
> acquired and Direct QNN plus strict ORT execution now pass.


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

## Official distribution and deployment check

| Candidate | Official source and evidence | Support matrix / versions | Checksums and access | Decision |
| --- | --- | --- | --- | --- |
| Qualcomm AI Runtime SDK (QAIRT/QNN) | Qualcomm Package Manager: [Qualcomm_AI_Runtime_SDK](https://qpm.qualcomm.com/#/main/tools/details/Qualcomm_AI_Runtime_SDK). This is also the SDK URL linked by the [ORT QNN documentation](https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html). | On 2026-09-10, Google Chrome opened the real QPM application, accepted its cookie prompt, then redirected to `myaccount.qualcomm.com` and showed the Qualcomm ID login form (`Email*`, `Password*`, `Sign in`). No package manifest, V81 support table, or download URL was exposed before authentication. | Requires a Qualcomm Package Manager account/entitlement. No package bytes or SHA-256 could be obtained, so there is no reproducible official 2.48 artifact in this workspace. | **Acquisition blocked** pending the user completing Qualcomm login and an authenticated QPM download or vendor-provided package and manifest. |
| QAIRT 2.25 public reference tree | [Qualcomm AI Engine Direct mirror, V2.25.0.240728](https://github.com/qdsp6sw/qualcomm-ai-engine-direct-sdk/tree/V2.25.0.240728), commit `e32f4b482c9d0f941eae317e5a5d6dd48d600352`; the files retain Qualcomm copyright and release documentation, but the GitHub account is not the official download endpoint. | `sdk.yaml`: QAIRT `2.25.0`, build `240728104910_97711`, QNN backend API `2.16.0`, Android NDK `r26c`; setup guide verifies Ubuntu 22.04/WSL2 and Windows 11. Its HTP matrix stops at V75/V73/V69/V68, and `lib/aarch64-android` contains no V81 libraries or SM8850 entry. | The full archive was not downloaded, so no archive SHA-256 is claimed. Individual source URLs and the immutable commit are recorded. | **Not deployable for SM8850/V81**; useful only as a negative compatibility reference. |
| QAIRT 2.48 V81 artifact witness | [ZipDepth SM8850 reference](https://github.com/meh301/ZipDepth-FP16-Qualcomm-QNN-SM8850), commit `99c80de923f00af104af87a0fceea67ee3b9effe`, independently reports SM8850/canoe/HTP V81 and QAIRT/QNN `2.48`, build `2.48.0.260626120635`. | This is a third-party application, not Qualcomm's support matrix or download channel. It demonstrates an ordinary Android packaging shape with matched arm64 host libraries and V81 context artifacts, but does not prove that Qualcomm will grant the same package to this project. | Its dependency file records SHA-256 values: `libQnnHtp.so` `4eaa10f59fce051e32012d6b4399c0576f5332c23349b6cc7452f9dcf8f270c7`; `libQnnHtpPrepare.so` `3e408206c9f3f24f60991476efdff388a271ff06411c18d02660a6ceac24cd0a`; V81 Skel `87e6463b4b4441eedb1b2ae889443510249eae4d6533278d3a5c798b8eea25d1`; V81 Stub `29d25ba60553f80210835f778854b6e6b542059e0c2296b99b65d2b0cb24cab6`; `libQnnSystem.so` `7ee62754b67a1f0f3b1defc1c441ff59d5ed4a02bb34f9437def7b7c8651062d`; ORT QNN 1.27.0 `d814a4927c78439da4fe599866c980ea853c2d3ecbb7078f897d559d63ccc872`. These are third-party LFS objects, not downloaded here. | **Corroborating lead only**; obtain the same version through official QPM/vendor access before use. |

The public Qualcomm sample documentation describes loading the application-side
backend and system libraries for an `aarch64-android` target. It does not authorize
copying protected `/vendor` files, replacing system FastRPC, or replacing the
device DSP skeleton. For this project the deployment contract remains: carry only
the exact host-side QAIRT set that the official Android guide names, leave system
FastRPC/DSP components under platform control, and verify every dependency with
the same SDK manifest. The current vendor-copy experiment therefore stops here.

The Direct probe now records the deployment version boundary before any QNN
interface-table call. With the current local headers (`2.37.0`) and phone provider
(`2.25.0`), it must report `apiCompatibility=FAIL` and exit at
`directProbeStage=apiCompatibility`; this is intentional evidence, not a new
loader workaround.

## Host capability and toolchain gap

The current Mac is Apple Silicon macOS 15.5. It can run the host quantization
reference and the Android Gradle build with the installed platform 35, build tools
34.0.0, CMake 3.22.1, and NDK 27.0.12077973. It has JDK 21 and Python 3.14; `adb`
and `cmake` are not on `PATH` (the SDK contains CMake, and an external platform-tools
copy is available elsewhere on disk).

The public QAIRT 2.25 setup guide verifies Ubuntu 22.04/WSL2 or Windows, Python
3.10, clang-14, and Android NDK r26c; it does not list macOS. HTP/DSP custom-op
tooling additionally requires the Hexagon SDK. Therefore this Mac can prepare and
validate the fixed host vector and compile the Android probe, but it cannot yet be
treated as a supported host for QAIRT conversion or V81 offline context compilation.
The missing host environment is an authenticated QAIRT release plus a Linux
Ubuntu 22.04 x86_64 (or vendor-supported equivalent) tool host, with the matching
NDK/Hexagon tools. Running those x86_64 tools on Apple Silicon would require a
supported VM/container/emulation setup; no such QAIRT toolchain is installed here.

## Phase-one verification record

| Check | Expected | Actual | Status |
| --- | --- | --- | --- |
| Host U8 Relu quantization reference | QNN formula `(q + offset) * scale`, `scale=0.05`, `offset=-128`, followed by ReLU and re-quantization must reproduce the probe vector. | `python3 StereoLab/validate-qnn-relu-reference.py` produced `quantReference=PASS` and the exact 16-byte expected array. | PASS |
| Probe source/build | The corrected offset and provider/API gate compile for arm64 Android. | `assembleDebug` completed successfully with the local SDK; no device rerun was performed in this phase. | PASS |
| Official SM8850/V81 package acquisition | Obtain an official versioned package, support matrix, manifest, and hashes. | QPM endpoint is known, but authenticated package access and the V81 matrix are unavailable in this session. | BLOCKED |

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

## 2026-09-10 current APK device recheck

Installed the existing debug APK and launched the isolated benchmark on the
connected phone. Captured only this process's probe logs and waited for its
terminal marker; no global logcat clearing or production app changes were made.
[Sanitized result and APK checksum](htp-device-recheck-2026-09-10.json).

Host and device quantization references passed. HTP provider selection passed
with backend ID 6, but the current probe correctly stopped at
`apiCompatibility=FAIL required=2.37 actual=2.25`, followed by
`directProbeMarker=FAIL stage=apiCompatibility` and completion.
This run did not reach backend/device/context creation or graph execution.
It supersedes the earlier graphCreate failure as the current probe's first
failing gate; the loader still reports missing Prepare and V81 Calculator
libraries. No NPU inference latency or depth-model success is claimed.

Resume with a complete, versioned V81-compatible QAIRT/QNN package and matching
headers. The local NPU directory and Downloads search found no new SDK package
for this recheck. Do not remove the API guard to treat mismatched interface
tables as compatible.

## Authenticated QPM acquisition progress (2026-09-10)

The user completed the QPM web login. The official QAIRT product page now
exposes Linux/Windows release `2.50.40.260831` (2026-09-07, installer 2.42 GB),
with installation through QPM3 desktop/CLI rather than a browser SDK download.
This supersedes the earlier inability to view the authenticated product page;
it does not yet establish V81 runtime compatibility or SDK acquisition.

Downloaded the official Linux Debian QPM3 `3.0.133.0` package through the web
Download action. Its local provenance records the package SHA-256. Created an
isolated Ubuntu 22.04 amd64 container on the existing Docker Desktop instance;
QPM CLI `--help` runs successfully under x86 emulation. This is an operational
CLI check, not a vendor certification of the emulated host for conversion.

`--download-only Qualcomm_AI_Runtime_SDK` reports that the CLI requires its own
Qualcomm login; the browser session is not reused. The interactive CLI accepts
username/password prompts without putting the password in command arguments.
CLI login and any explicit SDK license activation remain required before
acquiring the matching headers and runtime set. No authenticated cookies or
passwords were extracted from Chrome or copied into repository files.

The dormant ORT session configuration had `offload_graph_io_quantization=1`
while disabling CPU EP fallback. The official
[QNN EP options](https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html)
define 1 as offloading graph I/O quantization to CPU, and 0 as retaining it on
QNN. The benchmark now uses 0. This corrects a later-stage configuration
contradiction; it does not change the current Direct probe gate or demonstrate
model support.
