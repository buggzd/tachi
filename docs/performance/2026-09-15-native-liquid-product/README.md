# 新版 tachi：Jellyfin 同帧液化连续实测

## 结果

本轮使用完整 tachi 的 Jellyfin 播放入口，得到 **1284.576 秒（21 分 24.6 秒）连续有效实时 3D 播放**，1269 个快照、28,949 个新配对帧，平均 **22.54 Hz**。不是独立 fixture，也不是把准备模型、暂停或操作界面的时间拼入长测。窗口内一直为 playing / ready / valid / stereo / alignedLiquid；原始日志在忽略目录保留，见[证据清单](evidence-manifest.json)。

这是该片源与当前充电环境的长测通过，不等于稳定 24 Hz、非充电续航、所有编码/字幕、独立音画同步或全部显示生命周期验收。

## 构建与配置

基于 `8898f56` 的 GPU 共享邻域、媒体 PTS 节拍、受阻同帧补采与取消提前重绘，另补齐正式播放器诊断。构建 `scripts/build-sbs-experiment.sh liquid`，APK 为 `tachi-sbs-liquid-product-diagnostics.apk`，SHA-256：

```text
77e0b46b7090b9ff6c9f5ebd5065b6b6d2ff5f387b745a03d4e4f7de95e60f67
```

沿用开发应用 ID/签名并覆盖安装，保留会话设置；没有改变 GitHub 发布默认配置。app 140 项、native-video 25 项 JVM 测试、lint、APK 构建及资源校验通过。汇总/温度解析另有 6 项 Python 测试。

设备 SM8850/V81，RayNeo Air 3s 外接 3840×1080 SBS，每眼合成目标 1920×1080。实际匿名片源为 Jellyfin 直放 1920×1080 HEVC，实际解码器 `c2.qti.hevc.decoder`；E-AC-3、48 kHz，输出格式报告 6 声道，WebVTT 字幕。没有测试 HLS/ASS/位图字幕或所有音轨。源格式没有提供有效 frameRate 字段，不据此宣称准确的源帧覆盖率。

深度 392×224，目标 24 Hz、两捕获槽、GPU 输入/范围处理/背景液化，严格 RGB/深度同帧；强度 0.85、羽化 96 px、拉伸 65%。取帧/解码/配对与缓存刷新仍分别计数。

## 连续窗口指标

| 指标 | 结果 |
| --- | ---: |
| 配对更新 | 22.54 Hz |
| 补采成功 | 13,418 次 |
| 缓存重复绘制 | 47,836 次，不能计作新视频帧 |
| Media3 解码输出丢帧增量 | 0 |
| GL 消费跨过的解码帧增量 | 31，不等于物理屏幕丢帧 |
| PTS 映射 missing / 深度 unknown / future | 均为 0 |
| 采样软件视频－配对视频 PTS 差 | 均值 93.63 ms，P95 126 ms，最大 209 ms |
| 采样播放器－配对时间差 | 均值 59.64 ms，P95 104 ms |
| 字幕错误快照 | 0，不等于独立同步验收 |
| 缓冲领先量 | 均值约 50.70 秒，窗口未发生 buffering 中断 |

阶段指标采用**逐秒导出的滚动均值的中位数**：NPU 31.98 ms、队列等待 5.98 ms、捕获到 worker 28.24 ms、捕获到上传 86.28 ms、GPU render 14.16 ms。它们存在重叠，不能相加成端到端延迟。补采前等待不在 captureToUpload 内，fence 观察也不是纯 GPU 计算时间。

[完整汇总](playback-summary.json)包含逐分钟窗口和计数；完整分钟配对率约 22.08–23.60 Hz，未观察到随时长单调下降，但不是稳态频率控制实验。不要将本轮 22.54 Hz 与手机 fixture 的 23.48 Hz 当成同条件优化前后对照。

## 系统数据与测量限制

38 次内存快照：PSS 952,043–982,090 KiB（约 930–959 MiB），未呈持续增长；范围包含 QNN、原生播放器与 WebView。采集期间充电，电池温度 33.6–36.2°C，42 次系统 thermal status 均为 0；这不能证明没有频率调节，也不能推算非充电功耗。后段当前 HAL 传感器独立保留在[系统汇总](system-summary.json)。

SurfaceFlinger 选取播放器 BLAST SurfaceView 图层读取三列时间戳。前段 2 秒轮询因 128 帧历史窗口而存在数据缺口，最大缺口约 2.74 秒，不能直接当作播放卡顿。后两段改为 1 秒轮询，采到的 actual-present 间隔 P95 约 16.61 ms、最大约 49.82 ms。它们包含缓存重复绘制，且未与每个深度 pair 建立呈现对应，不代表 60 fps 转换、无物理丢帧或零延迟。

原温度工具混合了 Cached temperatures 与 Current temperatures from HAL；已修正为只读取当前 HAL，单独测试了缓存隔离。前两段混合 CPU/GPU 温度数组不用于温度结论；独立 dumpsys battery 和 thermal status 字段可用。各阶段时间范围与采样缺口在系统汇总中明确区分。

## 诊断与复现

正式分享报告/逐秒日志新增 captureCandidates、captureCadenceSkips、captureFenceSkips、captureSlotSkips、captureSubmitted、captureRetryAttempts、captureRetrySubmitted。提交总数包含补采，不能将所有计数简单相加。保留有限数字白名单，不复制任意字段。

pairedPtsUs 改为支持最长 24 小时媒体时间，避免原通用 10 亿上限丢失超过约 16 分 40 秒的微秒 PTS；本轮有 **440 个**超过该边界的有效快照。playerMinusPairedMs 保留正负，异常边界、敏感字段排除有 JVM 测试。

```bash
python3 StereoLab/experiments/summarize_product_liquid.py /path/to/playback.log --output /path/to/summary.json
python3 StereoLab/experiments/collect_presentation_trial.py --adb /path/to/adb --serial DEVICE --layer 'EXACT_PLAYER_LAYER' --seconds 1250 --interval 1 --output /path/to/presentation.jsonl
```

第一条命令按源变化、暂停/错误/非有效状态、倒退 seek、计数器重置和 >2.5 秒日志间隙分段，取最长有效段。系统和内存采集开始晚于有效播放起点，不能声称与全部 21 分钟逐帧一一对应。原始日志/图像只在忽略目录，提交匿名汇总与哈希。

## 剩余验收

实际入口启动、开启实时 3D 和本片连续观看已验证。本次曾正常确认系统 USB/镜像许可，但未完整覆盖退出/重建/热插拔/硬件 2D-SBS 切换，不能宣布历史黑屏恢复问题根治。仍需非充电长时、其他编码及 HLS、ASS/位图字幕、独立音画/字幕同步与高动态主观画质验收。下一步性能重点是捕获到 worker 的 GPU/读回等待及双槽占用，不以增加缓冲深度换取吞吐。
