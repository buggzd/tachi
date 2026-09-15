# 实时 SBS：主路线与构建

2026-09-15 起，后续开发采用 **392 严格同帧 + GPU 背景局部液化**。用户已确认当前 3D 观感满意；算法参数和取舍见[主技术路线](SBS_TECHNICAL_ROUTES.md)。这次确定开发方向，不修改 Gradle、APK 或 GitHub 发布默认值；当前仍通过 `liquid` 实验配置启用。

## 主路线构建与使用

```bash
./scripts/build-sbs-experiment.sh liquid
```

必须显式传 `liquid`；脚本省略参数仍选择旧 `quality`。本地需备齐运行库和 `AndroidApp/realtime-sbs-runtime.json` 中 `experimentalModels.392` 对应模型。脚本启用 392×224、24 Hz 调度目标、GPU 预处理/深度处理/液化、两个捕获槽、固定主机输出和异步捕获观察，执行 JVM 测试、lint、组装及资源校验。

输出 `AndroidApp/app/build/distributions/tachi-sbs-liquid-392.apk`，沿用开发应用 ID `com.jellyfinforrayneo.client.debug` 与本机 Debug 签名，关闭 debuggable。可覆盖同签名开发版并保留设置，不覆盖正式版。旧 `quality`（518/12 Hz）和 `motion`（392/24 Hz 非配对）仅供回归对照，不再优先推荐。

先在手机选择 SBS 虚拟银幕，确认系统允许外接输出，再播放并开启「实时 3D」。视频信息显示实际深度预览。固定参数为位移强度 **0.85**、羽化 **96 px（每眼 1920 源宽基准）**、拉伸 **65%**。深度使用逐帧精确 P2/P98，无范围 EMA 和像素历史融合。

处理完成后交换同源 RGB/深度整对；繁忙时重复上一对及其合成缓存，不把旧深度套到最新视频，不自动压平深度或回退 CPU。seek、换源、关闭和 Surface 重建必须清除旧代配对及缓存。字幕优先采用配对位置，音频没有固定延迟补偿；同帧不等于零播放延迟。

液化后续优化采用工作组共享邻域和已知媒体 PTS 采样节拍，参数不变；[手机顺序短测](performance/2026-09-15-liquid-24hz/README.md)已取得收益，但未达 24 Hz。

## 实测与下一步验收

[修订版复测](performance/2026-09-15-native-liquid-retest/README.md)为部分通过：兼容本地素材连续有效 119.604 秒、成对更新 21.38 Hz，缓存路径有使用证据；不能宣布稳定 24 Hz。末次滚动捕获到上传均值 70.569 ms，末次视频落后量 125.125 ms，不能相加为完整端到端延迟。旧版 18.9 Hz 的素材和时长不同，不构成提升比例。

主观观感已获用户认可，剩余工程验收仍需完成：

- 正式 Jellyfin 恢复出现黑色视频与准备提示；从该状态做有界诊断。
- 高动态原片为设备不支持的 10-bit H.264；准备同内容兼容编码并记录 PTS 映射后，再核对 347/579 帧。
- 显示生命周期、ASS/WebVTT 与独立音画同步、跨 seek/代际/几何缓存失效，以及有效连续 20–30 分钟和温控。

分享诊断日志保留 `pairedPtsUs`、`playerMinusPairedMs`、`pairedVideoLagUs`、队列等待、捕获到上传、`pairedFrames`、`cachedPairDraws`、`pairRenderUpdates`。区分新成对帧、重复绘制、解码丢帧和物理呈现；GPU query、提交时间、fence 完成观察不能互相替代，近零 liquid query 不是液化零成本。

## 数据交换边界

GPU 已承担 CHW/归一化、深度范围处理和局部液化；ORT QNN 产品路径仍需主机输入读回和输出交接，不是零拷贝。完整模型注册共享缓冲仅有[独立 benchmark 证据](performance/2026-09-13-daily-sbs/README.md#完整模型共享缓冲)，后续在保持严格配对、有界槽位和失效语义的前提下接入产品。

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


以上通用 Full 命令仍对应旧 266 默认值，不等于 liquid 主路线包。将主路线纳入发布配置是后续独立变更。旧双档、CPU 稳定、实验开关和测量说明已收录于[历史构建快照](archive/2026-09-14-realtime-sbs-builds.md)，原始性能报告继续保留。
