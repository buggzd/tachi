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

## 操作与边界

先在手机选择 SBS 虚拟银幕并确认系统允许外接输出，再播放视频，在眼镜控制栏开启
「实时 3D」。首次准备模型后开始更新，目标约 12 Hz；字幕无需关闭。
「视频信息」同时打开两眼的实际深度小窗，白色表示较近。
正常深度延迟保持最后有效图；关闭后重新开启可手动重试，错误不启动 CPU 回退。
seek、换源和 Surface 重建清除旧代图，避免使用另一时间或媒体的深度。

复现异常后使用手机设置的「分享诊断日志」。本轮覆盖与未测清单见
[产品接入验收](performance/2026-09-12-native-product/README.md)。此前 lab 的
[全链路性能数据](performance/2026-09-12-native-qnn-sbs/README.md) 不应直接等同于产品性能。
