# 392 严格配对与 GPU 背景局部液化：实机实验包

网页用户认可的参数为 392、严格同帧、偏移 0.85、羽化 96 个每眼 1920 源图像素、拉伸 0.65。开发配置 `liquid` 已完成设备实测：392 QNN 深度和 GPU 液化能持续产出有效 SBS，约 20 分钟结构化播放保持 `depthState=ready`。完整证据和阻塞项见 [2026-09-14 实机报告](../2026-09-14-native-liquid-device/README.md)。

## 实现

- NPU 使用现有 392×224 QNN 量化模型；GPU 精确 P2/P98 逐帧归一化，不融合旧深度或旧范围。它与网页 float 模型存在模型精度差异，不能称逐像素相同深度。
- GLES 3.1 compute 生成双眼背景修正，连续深度门控 0.025–0.12、羽化 96，随后八轮深度引导二维扩散，最终合并 0.85 / 0.65 得到签名横向位移。三张 RGBA32F 纹理有界复用，无 CPU 像素循环/液化图读回；渲染手动双线性采样避免浮点线性扩展依赖。
- 绘制保留连续投影区间反求、近景优先，缺失覆盖沿用原 gather fallback。不新增 RGB 历史，不能保证无洞、无变形或模型不抖。
- 每个捕获 lease 同时拥有模型小图和 1920×1080 原视频快照。两槽覆盖采集/NPU/GPU 后处理，直到接受或拒绝深度才释放；不提前复用其 RGB。接受后交换显示纹理所有权并复制小幅深度至独立提交纹理，再计算液化；后续推理不会覆盖正在显示的深度。
- GL 顺序保证配套颜色、深度与液化一起用于绘制。SBS 未得到首对有效结果时显示黑色；慢时重复上一对，seek/源变化/失效代际不显示旧对。普通 2D 仍直取 Media3 OES；旧 daily quality/motion 和默认发布配置保留。
- 捕获前移至昂贵双眼绘制之前，保留 GPU CHW、固定主机输出、异步 fence 观察。交换全尺寸纹理省掉额外一次 1080p 复制；三张全尺寸 RGBA8 加三张低分辨率 RGBA32F 和一张提交深度约增加 28 MiB 纹理存储，不含驱动及现有资源。

24 Hz 是采样目标，不是每个解码帧都经过深度推理。资源忙时跳过采样，显示帧只来自有效成对结果，因而可能降低运动流畅度。没有添加无界未来帧队列，也没有自动切平面/切分辨率。

## 端到端证据边界

`depthPts` 在此配置统计实际显示对的媒体 PTS 差；未知映射仍计 unknown。`pairedVideoLagUs` 独立记录最新解码帧与成对显示帧的 PTS 差，不能用前者为零宣称零延迟。`pairedFrames` 是提交对数量，不是物理显示刷新计数；`gpuLiquidMeanMs/P95Ms/Disjoint` 会进入脱敏报告。

**音频和字幕仍跟随原有播放器时钟，本轮没有增加音频延迟补偿。** 保持图像/深度对应并不自动保证音画同步；配对等待造成的视频落后必须在实机测量，包括口型、字幕时点及快进后的恢复。现有 ORT 主机输入读回、raw 输出复制仍在，完整 QNN 共享 I/O 尚未接入此实验包，不宣称零拷贝。

## 已完成检查

- 原始 ESSL 3.1 compute 与 ESSL 3.0 渲染 shader 经 glslang 编译检查；旧/新深度分位配置分别编译。
- 原生 compute 的相同运算主体转为桌面 WebGL 浮点 pass，比较网页 CPU 算法：常量、阶跃、缺失边缘行、噪声和真实高动态 579 帧均通过，最大位移误差低于 0.00001 px。见 [数值结果](desktop-parity.json)，复现 `node StereoLab/verify-native-liquid.mjs`。这不是 Android 驱动执行验证，也不是 GPU 性能实测。
- Android app/native-video JVM 测试、lint、APK 装配及 `scripts/verify-android.sh` 通过；GlassesUI TypeScript 检查与两端构建通过。诊断测试覆盖配对/液化字段导出，已有 lease 测试覆盖两槽上限、seek 和迟到释放。

## 实机检查顺序和结果

1. 已完成安装、392 模型 ready、深度预览、SBS 方向和参数检查；证据见实机报告的 `depth-preview.png` 和 `sbs-playing.png`。
2. 已确认有效配对 PTS 的 unknown/future/missing 为零；暂停、恢复、seek 和 2D/SBS 已覆盖。配对不等于端到端零延迟，`pairedVideoLagUs` 均值约 83 ms、P95 125 ms。
3. 已记录 QNN、GPU 仪表、捕获、队列、解码和 SurfaceFlinger 时间戳；GPU 专用 liquid timer 覆盖不完整，不能拿它估算液化阶段耗时。
4. 高动态 347 / 579 帧、口型、字幕 cue 和独立音画同步仍未完成；播放器退出后的外接显示恢复需要手动镜像，是当前阻塞项。

构建：`scripts/build-sbs-experiment.sh liquid`。输出 `AndroidApp/app/build/distributions/tachi-sbs-liquid-392.apk`，开发签名/应用标识沿用既有日常实验规则，未发布 GitHub Release。
