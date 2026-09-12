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

## 操作与边界

先在手机选择 SBS 虚拟银幕并确认系统允许外接输出，再播放视频，在眼镜控制栏开启
「实时 3D」。首次准备模型后开始更新，目标约 12 Hz；字幕无需关闭。
「视频信息」同时打开两眼的实际深度小窗，白色表示较近。
正常深度延迟保持最后有效图；关闭后重新开启可手动重试，错误不启动 CPU 回退。
seek、换源和 Surface 重建清除旧代图，避免使用另一时间或媒体的深度。
深度稳定器对颜色变化采用连续历史权重，大幅深度变化仍拒绝旧历史；该开发改动只完成
[离线伪影量化](performance/2026-09-12-artifact-evaluation/README.md)，部分低对比快移边缘有退化，
仍需实机 A/B。当前没有运动重投影或视频/深度的精确时间配对。

复现异常后使用手机设置的「分享诊断日志」。本轮覆盖与未测清单见
[产品接入验收](performance/2026-09-12-native-product/README.md)。此前 lab 的
[全链路性能数据](performance/2026-09-12-native-qnn-sbs/README.md) 不应直接等同于产品性能。
