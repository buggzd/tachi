# 原生播放

Android 正式播放器使用 `native-video` 的 Media3/MediaCodec/GLES 核心，普通 2D、
SBS 虚拟银幕和实时深度 SBS 共用一个原生播放器。WebView 保留目录、控制、
字幕与 Jellyfin 播放上报；Android 播放页不创建 HTML video。独立浏览器开发预览仍用 HTML/HLS。
本分支已完成产品接入；本轮实机覆盖与尚待用户回传的项目见 [验收记录](performance/2026-09-12-native-product/README.md)。

## 播放与显示

```text
GlassesUI 播放计划 / 遥控 / 唯一进度上报
                 ↓ 有界、账号代次与播放 token 校验
NativePlaybackController → Media3（网络、解复用、音轨、音画时钟）
                 ↓
MediaCodec → SurfaceTexture/OES → GLES 单眼或双眼输出
                 ↓ 可选 12 Hz 小图采样
GPU RGBA8 → PBO/fence → CPU CHW → QNN HTP → CPU 时序稳定
                                               ↓
                              R8 深度纹理 → GPU 双眼 gather
```

视频 Surface 与透明 WebView 是外接 Presentation 下的兄弟视图。原生视频直接绘制每眼，
`StereoMirrorLayout` 只复制控制层与字幕。两者使用同一组银幕缩放、水平视差及 180 ms
设置动画；控制与字幕不参与深度形变。模式切换不额外创建播放器、音频或上报流。
HyperOS 禁用外接显示的问题仍需系统「屏幕镜像」，原生播放器无法取得系统显示管理权限。

`NativePlaybackRequest` 将消息限制为 16 KiB，URL 限制为 12 KiB，只接受当前账号的
HTTP(S) 同源 Jellyfin `/Videos/` 路径，不接受任意请求头、文件 URI、外部来源或目录遍历。
每个命令校验 catalog generation 与播放 token；seek 带序号确认，晚到的旧时钟不能撤销新 seek。
账号切换、登出、播放器退出或 WebView 销毁释放播放器与深度后端。401/403 走既有账号代次校验。
Activity 退后台释放解码器和 QNN；返回时恢复同一播放位置并暂停，用户继续播放即可。

## 编码、音轨与字幕

- 直放使用 Media3 容器能力与 MediaCodec 视频硬解能力：MP4、WebM、MKV，最高
  3840×2160 / 120 Mbps；H.264/VP8 限 8-bit，HEVC/VP9/AV1 限 10-bit 与兼容色度/规格。
  能力声明不代表每种片源均已实测；实际解码器会显示在「视频信息」。
- 音频按系统解码能力声明 AAC、MP3、AC-3、E-AC-3、Opus、Vorbis、FLAC。直放音轨按
  Jellyfin Audio 流序号映射到 Media3 轨道；服务器 HLS 使用服务端已选择的音轨。
- 不兼容容器/编码/规格/音频或位图字幕使用 Jellyfin 24 Mbps H.264/AAC 双声道 HLS；
  直放运行失败可使用已准备的 HLS 端点，禁止并行双播放。当前 GLES 输出是 SDR RGBA8，
  已知 HDR 内容请求服务端 SDR 转码，不宣称 HDR 透传或客户端 tone mapping。
- ASS/SSA 保留原文与 libass 的样式、定位、动画、卡拉 OK、字体和矢量裁剪。现有字体
  限额、内置思源黑体和错误提示保持。渲染使用原生时钟的 100 ms 状态与短时插值，
  rAF 驱动字幕，不需要隐藏 HTML video；暂停、seek、换源重新同步。尚非精确显示 PTS 锁定。
- 其他文字字幕仍以 WebVTT 显示，沿用四档字号；位图字幕由服务器烧录。
  本地字幕与实时深度可以同时启用；不再要求关字幕才能转换。原片已经烧入的文字也会参与视频形变。

## 深度与构建

普通构建默认使用原生 2D/SBS 播放，不依赖 QNN。实时深度包使用已验证的本地依赖：

```bash
AndroidApp/gradlew -p AndroidApp -PrealtimeSbs=true \
  :app:testDebugUnitTest :app:lintDebug :app:assembleDebug \
  :native-video:testDebugUnitTest :native-video:lintDebug
scripts/verify-android.sh
```

详见 [QNN 依赖与操作](REALTIME_SBS.md)。`QnnDepthProcessor` 为产品和 lab 共享实现，
首次开启实时 3D 才初始化。模型/SDK 校验 `realtime-sbs-runtime.json`，厂商库不 strip；
禁止 CPU EP fallback。正常慢帧、暂停、低信息量结果和推理错误沿用已有有效深度；
seek、换源、Surface 重建和显式关闭清除旧图。关闭后重新开启可显式重试失败后端。

当前仍有 CPU 张量准备、时序稳定与 GPU 读回，不能称为零拷贝。12 Hz 是采样目标，
不是原视频帧率或模型最大吞吐。深度调试小窗由 GPU 从实际 R8 深度纹理绘制到两眼。

## 用户测试与报告

复现问题后，在**手机设置 → 分享诊断日志**导出完整 `.txt` 附件，再将系统分享结果发回。
报告保留当前进程最近 120 个原生技术样本（每秒一次及状态变化），退出播放器仍保留；生成的报告文件限制 512 KiB，私有缓存最多保留三份；
不要在导出前强制结束应用。内容包括解码器、播放/缓冲位置、丢帧、HTTP 数字错误码、
字幕格式与加载失败标志、NPU/CPU/读回/上传耗时、深度帧龄和 GPU 计时。
不包含 URL、Token、账号、片名、字幕原文或图像；这些白名单与样本上限有 JVM 测试。
耗时为最近最多 512 次的滚动统计，GPU query 不含系统最终合成，深度帧龄不是端到端延迟。

用户重点验证：2D/SBS 各播放一段、实时 3D 开关、暂停/快进/续播、切音轨、ASS/普通文字/位图字幕、
退后台后返回，以及直放不兼容时的服务端 HLS。异常发生后立即导出报告，并说明执行的操作。
4K/60、所有硬件编码、长时温控、精确音画/字幕同步与复杂遮挡画质仍需对应片源和实机验收。

独立 lab 的操作与历史基线见 [lab 记录](archive/2026-09-12-native-video-lab.md)，
旧 WebView 实现见 [历史实现](archive/2026-09-10-webview-realtime-sbs.md)。
