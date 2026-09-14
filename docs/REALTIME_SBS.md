# 实时 SBS 开发构建

正式播放已接入原生 Media3 → OES/GLES → QNN 深度 → 双眼输出，见 [原生播放](NATIVE_VIDEO.md)。
本页维护可选本地依赖；旧 HTML 帧桥设计保存在 [历史记录](archive/2026-09-10-webview-realtime-sbs.md)。

## 本地依赖

模型与 SDK 不进入 Git。沿用 `AndroidApp/realtime-sbs-runtime.json` 固定的哈希，放在
`StereoLab/.local/npu/`：

- `depth-anything-v2-small-qnn-266-u16a-i8w.onnx`
- `onnxruntime-android-qnn-1.22.0.aar`
- `qairt-runtime/arm64-v8a/` 中清单指定的九个厂商库。

已实测 SM8850/V81，模型输入 266×154、U16 activations / I8 weights，QAIRT
2.50.40.260831 / QNN API 2.39。当前固定 SoC 配置不表示其他手机已经验证。
构建逐一验证哈希，保留厂商 DSP ELF 原始字节；APK 只包含 ARM64。
官方 SDK 需用户自行完成账号与许可步骤，不能提交 SDK、模型、账号数据或下载凭据。

```bash
AndroidApp/gradlew -p AndroidApp -PrealtimeSbs=true :app:assembleDebug
```

输出为 `AndroidApp/app/build/outputs/apk/debug/app-debug.apk`。不带属性的普通包也使用
原生播放器，但不包含深度模型和 QNN 后端。原生 lab 仍可独立通过 `-PnativeQnn=true`
构建，两个应用 ID 不同。

## 两种发行包

- `lite`：原生 2D 和平面 SBS，移除模型、ORT 与 QNN，不提供实时 2D 转 3D，也没有在线下载模型入口。
- `full`：包含固定模型和运行库，可使用实时深度。当前只验证 SM8850/V81。

两版同应用 ID、同版本号与签名，可覆盖切换并保留设置；不能同时作为两款应用安装。
完整构建与包内容验证：

```bash
./scripts/build-android.sh all lite
./scripts/build-android.sh all full
```

两次构建共用 Gradle 输出位置，保存前一个 APK 后再构建下一版。GitHub 发布工作流会自动分别保存
`tachi-<version>-lite-arm64-v8a.apk` 和 `tachi-<version>-full-arm64-v8a.apk` 与校验文件，
CI 依赖包的准备见 [发布手册](RELEASE.md#实时深度构建输入)。

## 画质盲测与高分辨率试验

[画质对照页与测试说明](performance/2026-09-12-quality-trials/README.md)提供三段实际片源的匿名评分，
可看单眼、SBS 和实际深度，导出评分 JSON。该页面用离线深度隔离算法效果，不表示手机实时性能。

另有可选 392×224 固定形状开发构建：

```bash
./scripts/build-android.sh debug full 392
```

需按 `realtime-sbs-runtime.json` 的 `experimentalModels.392` 准备额外模型，生成方法见测试说明。
取帧、QNN 输入输出、稳定器与上传纹理使用同一尺寸；正常构建和 GitHub Lite/Full 仍默认 266×154。
392 已在 SM8850 的共享原生 lab 跑通 QNN 与 SBS；更高尺寸及构建模式的耗时见
[9 月 13 日实机分辨率扫描](performance/2026-09-13-resolution-sweep/README.md)。
这不等于正式播放器/外接眼镜完整验收，默认发布仍为 266。两种 APK 同 ID，可覆盖安装保留设置。

322、518、644 和失败的 770 模型记录在实验清单中；518 另提供下述日常实验包，其余用于直接 Gradle lab 扫描复现。
常规打包脚本仍只接受 266 / 392。lab 可用 `-PlabPerformanceBuild=true` 关闭 Debug
调试标志，再通过 Android `cmd package compile -m speed -f` 实验 ART 预编译。
该开关只作用于独立 lab，不改变主应用；必须核实系统实际报告 `speed`，
不能把命令返回 Success 或 Debug 包的 `verify` 当作预编译生效。
诊断新增 `realtimeDepthResolution` 与 `depthWidth/depthHeight`，避免混淆模型尺寸。

## 日常试看实验包

完整本地模型/运行库就绪后，可生成两档独立文件：

```bash
./scripts/build-sbs-experiment.sh quality
./scripts/build-sbs-experiment.sh motion
```

- `quality`：518×294、12 Hz 目标，优先轮廓清晰度。
- `motion`：392×224、24 Hz 调度目标，约 20 Hz 是既有 lab 测量，产品更新率以诊断为准。

输出位于 `AndroidApp/app/build/distributions/`，文件名分别为
`tachi-sbs-quality-518.apk`、`tachi-sbs-motion-392.apk`。均包含对应模型，开启 GPU
稳定、精确查表 CHW 输入、两个捕获槽、固定主机输出和异步捕获观察。
脚本运行两模块 JVM 测试、lint、APK 构建及资源校验。

两包沿用开发版 `com.jellyfinforrayneo.client.debug` 和本机 Debug 签名，关闭
`debuggable`（也关闭 WebView 远程调试），可以互相覆盖并保留已有开发版账号设置。
它们不覆盖正式版，也不改变 GitHub Lite/Full 的发布默认配置；不同开发电脑签名可能不兼容。
优先安装 quality，先在手机完成眼镜 3D 显示，再在播放器开启「实时 3D」。
切换档位需要安装另一 APK；深度慢时保持有效图，不自动变平或回退 CPU。

诊断增加以下测量：

- `depthPtsLagMeanMs/P95Ms/MaxMs`：GL 绘制视频 PTS 减去所用深度的源帧 PTS，保留负值。
  使用精确解码元数据匹配，最多容忍释放时间微秒截断；`ptsMissing` 与
  `depthPtsUnknown` 单独报告，不猜测最近帧。历史融合后的深度不代表单一真实曝光时刻。
- `queueWaitMs`：捕获就绪后到串行工作线程开始的等待。
- `droppedFrames`：Media3 解码输出丢帧；`supersededVideoFrames`：已匹配解码序列中
  被 SurfaceTexture 消费跨过的帧。两者均不是物理屏幕呈现丢帧。
- `playbackMinute`：最近 60 个分钟快照；计数器累计、耗时为近期滚动窗口，不是整分钟平均。
  实验包还以 `TachiPlaybackTrial` 输出相同的脱敏快照，便于连续采集而不丢失前半程。

PTS 统计包含持有同一视频帧时的深度更新绘制，不是只按新视频帧加权，也不包含显示器光学延迟。
系统呈现应另用 SurfaceFlinger 图层统计或时间戳验证，不能把 24 fps 视频在 60 Hz
显示器上的重复刷新当作丢帧。离线汇总可用
`StereoLab/experiments/summarize_daily_trial.py`，按源编号拆分并排除中断/seek 后的跨段统计。
[日常包实测](performance/2026-09-13-daily-sbs/README.md)记录 518 的 20 分 39 秒连续窗口、
392 的顺序对照，以及后续 HLS 缓冲、PTS 长尾和呈现统计边界。

## 输入与流水线实验

可组合 `-PgpuPreprocess=true -PcaptureSlots=2 -PpinnedDepthOutput=true
-PasyncCapturePoll=true -PdepthHz=24`（命令中写在同一行）。GPU 输入要求同时开启
QNN 与 GPU 稳定；captureSlots 只支持 1/2，depthHz 只支持 12/24。全部保持原发布默认值。
392 的 24 Hz 是目标而非已保证的更新率；518 的推理耗时仍高于 24 Hz 单帧预算。
产品的 GPU CHW 输入仍需主机读回，固定输出缓冲也不是 QNN 注册内存。
独立 benchmark 新增 `fullshared` 阶段，可导出完整 518 图并验证 AHardwareBuffer / HTP
注册输入输出与 GPU 读写；这条共享路径尚未替换产品 ORT Java 后端，见
[完整模型验证](performance/2026-09-13-daily-sbs/README.md#完整模型共享缓冲)。
诊断包括输入路径、槽数、目标频率，以及 queueWait/captureToWorker/workerService 的均值和 P95。
实测结果、构建命令和共享内存边界见 [GPU 输入与流水线验证](performance/2026-09-13-gpu-input-pipeline/README.md)。

## 操作与边界

GPU 稳定实验：额外传 `-PgpuDepthStabilization=true` 可将精确分位范围、切镜/颜色差、
归一化及历史融合放到 GPU，输出纹理直接用于 SBS。默认关闭，保留 CPU 对照；
要求 GLES 3.1 和至少 256 个工作组线程。QNN 仍通过主机缓冲交换输入/输出。
实机证据及实验构建命令见 [GPU 稳定验证](performance/2026-09-13-gpu-stabilization/README.md)。
诊断的 `gpuStabilization` 为 true 时，CPU `stabilizeMs` 只记录原始深度交接，
实际 GPU 完成观察耗时见 `gpuStabilizeCompletionMeanMs/P95Ms`，不能将两者混为一项。

先在手机选择 SBS 虚拟银幕并确认系统允许外接输出，再播放视频，在眼镜控制栏开启
「实时 3D」。首次准备模型后开始更新，目标约 12 Hz；字幕无需关闭。
「视频信息」同时打开两眼的实际深度小窗，白色表示较近。
正常深度延迟保持最后有效图；关闭后重新开启可手动重试，错误不启动 CPU 回退。
seek、换源和 Surface 重建清除旧代图，避免使用另一时间或媒体的深度。
深度稳定器对颜色变化采用连续历史权重，大幅深度变化仍拒绝旧历史；该开发改动只完成
[离线伪影量化](performance/2026-09-12-artifact-evaluation/README.md)，部分低对比快移边缘有退化，
仍需实机 A/B。当前已能测量视频/深度源帧的 PTS 差，但没有运动重投影或延迟视频以强制时间配对。

复现异常后使用手机设置的「分享诊断日志」。本轮覆盖与未测清单见
[产品接入验收](performance/2026-09-12-native-product/README.md)。此前 lab 的
[全链路性能数据](performance/2026-09-12-native-qnn-sbs/README.md) 不应直接等同于产品性能。

## 392 同帧背景液化实验包

运行 `scripts/build-sbs-experiment.sh liquid` 构建用户网页偏好参数：392、0.85 位移、96 px 羽化、65% 拉伸。深度逐帧 P2/P98 无历史，局部液化在 GPU compute；两捕获槽保存对应全尺寸视频，处理完成后交换整对画面，忙时重复已匹配画面。普通发布默认与原日常双档不变。

本轮完成开发和桌面/构建验证，尚未 ADB 实测。严格配对可能降低显示更新率并增加音画延迟，音频/字幕未额外补偿；检查诊断 `pairedVideoLagUs` 与 `gpuLiquid`，不要只看配对 PTS 为零。实现、检查结果和实机清单见 [原生液化实验](performance/2026-09-14-native-liquid/README.md)。
