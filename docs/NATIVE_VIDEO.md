# 原生播放迁移

2026-09-11 用户决定以原生播放路线作为实时 SBS 的主线，替代 HTML video 拥有解码、
时钟和帧采集的架构约束。当前发布播放器仍使用旧链路；本文区分已经新增的基础模块
和后续产品接入，不能将独立调试包称为完整迁移完成。

## 目标架构

目录、详情和遥控界面继续由 WebView 提供。原生播放核心统一拥有 Media3 播放器、
唯一的 MediaCodec 视频解码器、音频时钟和 OpenGL 输出。CPU 负责控制和任务提交，
图像降采样、预处理、视差合成逐步移动到 GPU；QNN 负责深度估计。

```text
Jellyfin 播放计划 / 控制界面
             ↓ 有界控制协议
Media3（网络、HLS、轨道、同步）
             ↓
MediaCodec → SurfaceTexture / OES 视频纹理 → GPU 两眼合成 → 外接输出
                         ↓                         ↑
                 GPU 缩小 / 预处理 → QNN → 深度纹理
```

选择 Media3 是复用成熟的传输、解复用、音频时钟和 seek 机制；视频纹理由应用自己
掌控，而不是从 WebView 截图。不会并行创建 HTML video 来维持另一个播放实例。
现有应用 ID、账号仓库、显示 USB 控制和升级数据保留兼容。

## 当前实现

`AndroidApp/native-video/` 提供 Media3 1.5.1 播放器、硬件视频解码器筛选、SurfaceTexture、
GLES3 渲染、单帧背压与可插拔 `NativeDepthProcessor`。`native-player-lab` 是独立应用，
尚未成为 `:app` 的播放器，也不切换眼镜物理模式。

开启 QNN 的实际数据路径：

```text
MediaCodec → OES 原始视频纹理 ───────────────────────────────┐
                  ↓                                      ↓
GPU 266×154 RGBA8 → PBO/fence → CPU CHW → QNN HTP → CPU 时序稳定
                                                         ↓
                           GPU R8 深度纹理 → 33 候选 gather 双眼合成
                                                         ↓
                                  3840×1080 FBO → 手机缩小预览
```

- 模型及 SDK 沿用 `realtime-sbs-runtime.json` 的哈希：Depth Anything V2 Small，
  U16 activations / I8 weights，ORT QNN 1.22.0 + QAIRT 2.50.40，已验证 SM8850/V81。
  显式设置 `session.disable_cpu_ep_fallback=1` 和 `offload_graph_io_quantization=0`。
  初始化或推理失败显示 QNN error，不自动切换到 CPU 推理。
- QNN 初始化、预处理、推理、稳定与关闭均串行运行在采样工作线程；关闭时先分离解码
  Surface，再释放播放器，QNN 关闭排在在途任务之后。应用级 ORT environment 由运行时管理。
- GPU 从原始 OES 图像生成 266×154 小图；输入采样永不经过视差变形或深度调试叠层。
  固定时间点以目标 12 Hz 调度，单个 lease 覆盖 PBO 和消费者；忙碌时跳过采样，
  不排队累积旧图。输出只有一个待上传槽，GL 线程再次校验播放代次。
- CPU 通过批量复制将 RGBA 转成复用 CHW 张量；时序处理保留已有 5%/95% 范围估计、
  范围 EMA、外观门控与小幅深度 EMA。白色表示较近的相对深度。没有光流或遮挡补全模型。
- R8 深度上传后供左右眼共享；左右方向相反，按参考每眼 1920 像素的 ±16 候选 gather
  选择近处遮挡。深度采样行序是 top-row-first，颜色纹理仍通过 SurfaceTexture 矩阵变换。
- 正常慢帧、暂停和低信息量深度结果沿用最后有效图，没有过期自动回退。seek、换源、
  关闭或 Surface 重建使旧代深度失效，工作线程及 GL 上传点均拒绝旧结果。
- 纹理时间戳尚未与媒体 PTS 精确对齐；`captureToUpload` 从小图提交前的单调时钟起算，
  不包含此前解码/纹理等待，也不等于光子级端到端延迟。

这条实现已经贯通 QNN 深度与 GLES SBS，但仍有 GPU→CPU 读回、CPU 张量准备/稳定和
深度纹理上传，不能称为零拷贝。PBO 不保证 `glReadPixels` 无驱动等待；每眼 1080p
实测显示取帧提交的墙钟耗时会受到前序 GPU 工作影响。

## 构建与调试

普通原生播放调试包不需要 QNN 本地依赖。要构建完整深度 SBS 包，在既有 SDK/JDK
环境和 [实时 SBS 本地依赖](REALTIME_SBS.md) 准备完成后运行：

```bash
AndroidApp/gradlew -p AndroidApp -PnativeQnn=true \
  :native-video:testDebugUnitTest :native-video:lintDebug \
  :native-player-lab:lintDebug :native-player-lab:assembleDebug
```

去掉 `-PnativeQnn=true` 可构建不含模型/SDK 的版本。依赖构建时逐项校验哈希，SDK、
模型和产物均不入 Git；厂商/DSP 库禁用 AGP strip，保留经过验证的原始字节。APK 位于
`AndroidApp/native-player-lab/build/outputs/apk/debug/native-player-lab-debug.apk`，
应用 ID 为 `com.jellyfinforrayneo.nativelab`；两种 lab 配置会相互覆盖，不覆盖 tachi。

调试入口支持 HTTP(S) 视频/HLS 与系统文件选择器。QNN 包默认 SBS、显示深度小窗，
并以每眼 1920×1080 实际渲染后缩小到手机；`SBS / 2D` 切换预览，`Depth map` 显隐
深度，`Slow depth` 注入/取消 250 ms 消费者延迟。慢帧注入不计入 NPU 推理时间。
退后台释放播放器，返回后需重新选源；尚未导入 tachi 账号、字幕或播放上报。

`NativeVideoLab` 每秒输出固定数值诊断：状态、进度、采样数、四点 RGB 探针、QNN
分段耗时、深度帧龄、上传数和 GPU timer query。没有地址、凭据或完整画面。
各统计窗口最多 512 次，按渲染器/引擎实例维护，换源不清零。GPU 查询仅在扩展可用时
采样，丢弃 disjoint 数据；`drawSubmit` 是 CPU 耗时，`gpuRender` 才是 GPU 区间耗时。

八项 JVM 测试、两模块 Lint、普通及 QNN APK 构建通过。
[原生基础链路实测](performance/2026-09-12-native-video/README.md) 与
[原生 QNN SBS 全链路实测](performance/2026-09-12-native-qnn-sbs/README.md)
分别记录两阶段的配置和边界，不能混用小窗口与每眼 1080p 的性能数字。

## 后续接入门槛

1. **补齐原生解码验收**：实际 Jellyfin 服务端 HLS/鉴权、其他硬件编码格式、旋转与
   非方像素、Surface 重建、文件选择器及主观音画同步。普通色块方向和基本播放生命周期
   已通过；仍需编号片验证媒体 PTS 与纹理时间戳关联，不能只以样本计数增长判定正确。
2. **优化与质量验收**：QNN 与 GPU SBS 已贯通。下一步减少 CPU 稳定处理、PBO 提交
   等待和冗余重绘，验证时间对齐、深度抖动、运动边缘与遮挡质量；保持单请求背压和
   正常慢帧时沿用有效深度。补齐 4K/60fps、长期热态和非充电功耗。
3. **共享缓冲探针**：核实当前 QAIRT/ORT 对输入输出缓冲导入的支持、内存分配方式、
   fence/cache 同步和张量布局。只有 GPU 写入→NPU 使用→GPU 读取整个链路验证后
   才讨论减少/移除 CPU 复制。必要时使用 JNI/直接 QNN，但不预先宣称支持。
4. **产品控制与会话接入**：SessionRepository 仍为唯一账号源，限定媒体来源和控制
   消息，不让 WebView 注入任意地址/头部。迁移播放进度、暂停、seek、音轨与字幕，
   音画时钟以原生为准；播放上报与清理只保留一个所有者。
5. **外接输出与 UI 合成**：原生视频与透明 WebView 控件共享每眼几何；明确 Surface
   重建和硬件切换时的资源寿命，避免把 SurfaceView 当成可被旧 Canvas 复制的普通
   View。沿用现有 USB 控制，但不假定可以绕过系统禁用外接屏的问题。
6. **迁移开关与退役**：在开发构建中选择互斥的原生或旧播放器，禁止双播放。完整
   回归通过后，再把原生设为产品默认并移除 HTML video 媒体路径。

目前已在 24fps H.264 片源、约 12Hz 深度和每眼 1080p 的配置下跑通原生管线；
完整产品迁移、眼镜实际输出与其他帧率/编码的结论仍需相应验收。
