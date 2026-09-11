# 实时 2D → 3D 开发构建

本分支已接入首版播放链路，默认关闭。它保留一个 glasses WebView、一个 HTML
`video`、一条音频和 Jellyfin 播放上报；新增低分辨率取帧、原生严格 QNN 深度
推理和两眼独立的深度偏移。已完成源码、桌面验证和首轮集成实机调试；链路能够工作，但深度更新约 8 fps，尚未达到完整实时验收要求。

## 构建与使用

普通构建不包含模型或 QNN 运行库，也不显示实时 3D 按钮。开发构建需要已有的
官方 QAIRT 2.50.40 / V81 和 ORT Android QNN 1.22.0 本地依赖：

- `StereoLab/.local/npu/depth-anything-v2-small-qnn-266-u16a-i8w.onnx`
- `StereoLab/.local/npu/onnxruntime-android-qnn-1.22.0.aar`
- `StereoLab/.local/npu/qairt-runtime/arm64-v8a/` 中的配套库。

来源和下载说明见 [NPU benchmark](../StereoLab/npu-benchmark/README.md)。
[依赖清单](../AndroidApp/realtime-sbs-runtime.json) 固定模型、AAR、九个运行库的
SHA-256；构建不接受缺失或不匹配的依赖，仅复制清单中的库。文件不进入 Git。
当前打包目标是 SM8850 / Hexagon V81，显示着色器要求 Android 13/API 33+；
不能把此构建外推到其他芯片。

```bash
npm --prefix GlassesUI ci
npm --prefix CompanionUI ci
# 使用项目标准 Android SDK/JDK 环境，不包含安装或 ADB 操作。
ORG_GRADLE_PROJECT_realtimeSbs=true ./scripts/build-android.sh debug
```

亦可直接向 Gradle 传 `-PrealtimeSbs=true`。输出仍是
`AndroidApp/app/build/outputs/apk/debug/app-debug.apk`，保持原 debug 应用 ID。
普通构建可直接运行 `./scripts/build-android.sh debug`，不会打包本地模型/运行库。

后续设备调试时：在手机选择并确认 3D 显示，开始普通 2D 片源播放，关闭选中的
字幕轨，在眼镜播放控制栏开启「实时 3D」。打开「视频信息」同时显示原生计算
时间、帧往返时间和估算深度图。开关不持久化，新的播放页面默认关闭；退出、
切换片源、seek、暂停、隐藏页面和显示模式变化均清除旧深度。

首版暂不转换带有选中字幕轨的画面，保留原字幕播放；界面提示关闭字幕后使用。
模型不可用、图中存在 CPU fallback、取帧被 CORS 拒绝、不可恢复的原生错误或绘制失败，
均恢复既有平面内容。错误锁定至用户关闭并重新开启，不循环重试模型或硬件模式。
这只是关闭深度转换，不会额外切换 USB 显示模式。

## 数据与绘制路径

1. `requestVideoFrameCallback` 从既有视频采集 266×154 RGBA，记录捕获时间、
   单调序号、播放访问 token、实际 contain 视频矩形和最多八个 UI 保护区域。
2. 专用桥只接受固定尺寸帧，JSON 上限 222000 字符；不接受 URL、文件路径、
   任意张量尺寸、账号或媒体元数据。JS 最多一个未确认请求，原生在解析前获取
   单请求槽；执行器一个线程、队列容量一，不累积待推理帧。
3. 原生工作线程解码 RGBA，执行 ImageNet NCHW 归一化，以 U16 激活/I8 权重
   模型推理。QNN 禁用 CPU fallback，图输入输出量化不卸载到 CPU EP。
   这里的 CPU 图像预处理不是 ORT CPU 节点回退。
4. 输出检查有限值，以 P5/P95 映射成 8 位相对深度；纯色/淡入淡出等没有可用
   深度范围的帧保留上一张有效深度，继续处理后续帧，不锁定整个转换会话。更新两个独立
   RenderNode 的深度纹理。仅开启信息面板时，返回额外灰度数据用于预览。
5. 原有 `StereoMirrorLayout` 继续复用同一张已完成的 WebView 硬件层。两个
   RenderNode 采用不同的 AGSL 视差方向，然后沿用原来的银幕远近、大小变换。
   视频之外和 UI 保护区保持原像素，不复制 DOM、解码器或播放器。

令归一化近景深度为 `n`，单眼方向为 `s=+1/-1`，则目标坐标为
`x_target = x_source + s × (n − 0.5) × A`，其中 `A=min(30,0.016×sourceWidth)`。
着色器在目标像素附近 ±16 个源像素中寻找投影落点，重叠时优先近景；无覆盖时
取重投影误差最小的候选进行填充。左右眼各自处理同一个源画面，不跨眼采样。
现有银幕基准视差独立保留，不靠改变银幕大小产生景深。

这是面向现有 HWUI/WebView 架构的新 gather 实现，并非之前实验页的 WebGL
forward-splat 原样移植。此前 WebGL 合成 7.3–7.9 ms 的结果不能充当本着色器的
性能数据。深度使用双线性采样；深度范围以 0.15 系数跨帧平滑，外观稳定且
深度变化小于 0.12 的像素以 0.35 系数平滑。明显外观变化不混合旧像素，
全图平均 RGB 变化超过 35/255 时重置历史。这是保守启发式，不是运动补偿或
可靠的切镜检测；运动边缘、补洞拉伸和残余闪动仍需实机验证。

正常播放不再按 150 ms 帧龄过期，也不因回复比视频慢 200 ms 而重启。
两眼保持同一张有效深度直到新结果替换；2 秒未回复仅显示延迟状态，保持单个
未完成请求，迟到回复仍能继续工作。没有新深度时宁可降低更新频率，不反复跳回
平面；代价是旧深度与运动画面可能错位。首张有效结果之前仍为原画面。
每次生命周期重置使用
新 token，原生和前端都拒绝旧结果；原生额外拒绝重复/倒序序号。页面切换或账号
catalog generation 变化立即清除深度，WebView 销毁时在工作线程关闭 QNN session。
会话在同一个 WebView 生命周期内缓存以避免每次播放恢复都重新编译图，不保留帧文件。

## 已完成的本地验证

- GlassesUI TypeScript、前端测试、两端生产构建。
- JVM 固定协议、输入通道/归一化、错误数据、深度范围测试。
- 普通与启用 QNN 的 Debug 构建、JVM 测试、Lint、APK 内容检查。
- 桌面 Skia 编译实际着色器并核验左右眼、近远景、零视差、字幕外的 UI 保护、
  视频边界、像素覆盖和前景遮挡；这不替代 Android AGSL/HWUI 验收。
- 桌面 Chrome 使用合成视频和模拟原生回复，核验单视频、深度预览、单请求背压、
  seek 重启、迟到回复、显示模式和字幕保护、错误锁定、回复超时与卸载清理。

```bash
# 使用独立端口，只在桌面运行。
npm --prefix GlassesUI run dev -- --host 127.0.0.1 --port 4190
node StereoLab/verify-realtime-integration.mjs
# Python 环境安装 numpy 和 skia-python 后：
python StereoLab/verify-native-warp.py
```

`nativeMs` 包含原生解码/预处理、推理和深度归一化；不包含取帧、桥传递、UI
纹理更新和最终呈现。`帧往返` 从 JS 取帧前到收到原生回复，仍不含眼镜实际呈现。
它们均不能标为 GPU kernel 时间或完整播放延迟。

实机慢帧注入检查：在帧提交前人为增加 220 ms 延迟，连续 10 个结果的回复帧龄
为 289–337 ms，均保持同一播放会话并返回有效深度，没有超龄回退；仍只有一个
video。见 [脱敏记录](performance/2026-09-10-realtime-sbs/held-depth-delay.json)。
这只验证慢帧处理，不代表光学抖动、运动错位或长期稳定性已经验收。

## 统一实机调试清单

首轮 ADB 结果见 [集成实机报告](performance/2026-09-10-realtime-sbs/README.md)。以下仍为完整验收清单，不能以首次播放成功替代：

1. **基础架构**：普通构建无模型/运行库；开发构建默认关闭；开关、进入/退出播放器、
   直接播放/HLS、切集、音轨、账号切换、暂停/恢复均保持单 WebView/video/audio/report。
2. **NPU 与帧通道**：本应用进程能够加载匹配 SDK、严格 QNN 建图和执行；检查 RGBA
   通道、取帧 CORS、桥复制成本、冷启动耗时、输入输出方向及实际深度预览。
3. **双眼呈现**：物理 Full SBS、两眼方向和共同帧号、远近/大小、letterbox、控制层
   保护；核验 RenderNode 是否正确采样 WebView 中的实际视频纹理，无黑屏/冻结。
4. **实时性能**：三个独立片段各至少 60 秒；记录取帧、原生处理、完整往返、深度帧龄、
   超时比例、视频掉帧和 HWUI/GPU 时间，再进行 10–20 分钟非充电热态测试。
5. **质量与恢复**：快速运动、场景切换、细线/头发/遮挡边缘；seek、隐藏/恢复、断连、
   模式切换、renderer 丢失、字幕保护和错误重试；验证慢回复持续持有深度，
   同时记录持有帧龄，不能将保持上一帧当作推理帧率提高。
6. 完整执行 [设备回归矩阵](ANDROID_ARCHITECTURE.md#device-regression-matrix)。

独立 NPU/合成并发基线见 [QAIRT 实机报告](performance/2026-09-09-stereo-lab/qairt-device.md)。
上述设备清单通过前，此分支只能称为「已接入、待实机验收」，不能称为完整实时播放已通过。

## 桌面优化候选

[2026-09-11 开发环境优化报告](performance/2026-09-11-desktop-optimization/README.md)
记录了按时间平滑、运动传播、保边细化、绘制与异步读回的对照结果，以及 M4 CoreML
后端的分区限制。它们是独立实验候选，尚未替换上述 Android 实现，也未完成手机验收。
