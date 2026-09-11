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

## 已新增的源码基础

- `AndroidApp/native-video/`：可复用 Android library，Media3 1.5.1，硬件视频解码器
  筛选，一个 ExoPlayer、一个 SurfaceTexture、一个 GLES3 渲染器。
- OES 纹理直接显示，contain 保持宽高比；可将同一纹理绘制到左右两个视口。
  当前只是相同视频的 SBS 预览，没有深度偏移，也不切换眼镜物理模式。
- GPU 将同一视频纹理缩到 266×154 RGBA8 FBO。最多 12 次/秒发起诊断采样，
  PBO/fence 在后续绘制轮次非阻塞检查完成状态，没有 `glFinish`。
- 完成后映射 PBO，复制到一个复用的直接缓冲，在单线程消费者中处理；一个 lease
  限制最多一张图在途，没有图像任务积压。seek/换源/关闭使旧代结果失效，但必须等
  旧消费者归还缓冲才允许复用，不能靠清空队列覆盖正在使用的内存。
- 纹理采样结果约定为 top-row-first RGBA，使用 SurfaceTexture 的变换矩阵。
  时间字段当前是纹理时间戳，尚不能宣称已经与 Jellyfin 媒体 PTS 精确对齐。
- `AndroidApp/native-player-lab/`：独立应用 ID 的原生调试入口，支持手动 HTTP(S)
  视频/HLS 地址和系统文件选择器。可播放/暂停、seek、SBS 预览，显示样本数量和
  简单校验值，不保存画面或输入地址，不导入 tachi 账号。退后台释放播放器，返回后
  需要重新选择片源，这是调试入口行为，不是产品生命周期实现。

此阶段没有接入 QNN，没有取代正式应用播放器，没有零拷贝承诺。PBO 后仍有一次
GPU→CPU 小图复制；底层 `glReadPixels` 是否存在驱动等待也必须实测。共享物理内存
不保证图像布局、NPU 张量与 GPU 纹理之间无需转换。

## 构建与当前验证

使用项目既有 Android SDK 和 JDK 环境：

```bash
AndroidApp/gradlew -p AndroidApp \
  :native-video:testDebugUnitTest :native-video:lintDebug \
  :native-player-lab:lintDebug :native-player-lab:assembleDebug
```

调试 APK：`AndroidApp/native-player-lab/build/outputs/apk/debug/native-player-lab-debug.apk`。
模块未被 `:app` 依赖，构建/安装原生实验 APK 不会覆盖正式或现有 realtime debug 包。

本轮完成源码编译、JUnit 缓冲所有权/代际失效/视口几何检查、两模块 Lint 与调试 APK
组装。按用户当前设备不可用的条件，没有 ADB 安装或实际解码/GLES/画质验证。
仅支持作为普通非 DRM SDR 视频路径的候选进行测试；HDR 色彩、受保护视频、字幕、
音轨选择、完整播放器错误恢复和外接 Presentation 还没有产品化。

## 后续接入门槛

1. **原生解码验收**：真实 HLS/直放、上下/左右方向、旋转与非方像素、暂停/seek/
   前后台、Surface 重建；确认仅一个硬件视频解码器及音频流。使用编号/色条片验证
   GPU 采样像素与媒体 PTS，不能只以样本计数增长判定画面正确。
2. **先接现有 QNN 模型**：让独立原生帧消费者调用相同模型，测 GPU 缩小、PBO 提交/
   完成/映射、CPU 复制、预处理、NPU 服务和结果纹理更新。保留单请求背压，不恢复
   正常慢帧时自动回退平面。
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

这条路线的预期收益是拥有可控的视频纹理和同步时序，不是已经实现手机实时性能。
