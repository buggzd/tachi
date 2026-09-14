# tachi 原生 392 GPU 液化实机验证

## 结论

本实验包为**部分通过**。在 `2509FPN0BC`（Android 16、Qualcomm canoe）上，392×224 QNN 深度、严格同帧配对和 GPU 液化路径实际产出有效 SBS 画面；连续结构化播放约 1198 秒，1182 个采样全部处于 `playing + depthState=ready + valid=true + stereo=true`，播放器报告解码丢帧增量为 0。实测深度更新约 18.9 Hz，低于 24 Hz 采样目标但稳定运行。

阻塞项是外接显示生命周期：退出播放器或发生外接显示重建后曾出现黑屏，系统弹出镜像确认，需要手动点击“镜像到外接显示屏”才能恢复。这个问题独立于 QNN 和液化算法，但在日常观看前必须修复。高动态 `testvideo-4.mp4` 的第 347/579 帧还没有通过 APK 的现有播放入口验证，因此轮廓跳边、鬼影和 l/r 方向暂不能给出完整结论。

## 实验配置和构建

- 提交：`372985b`
- APK：`tachi-sbs-liquid-392.apk`，SHA-256：`a13df790c741c4e4dc0c500f67edbd7290bab4c2be55f2cc1420d7f2c46bca0b`
- 深度：392×224，QNN；目标 24 Hz，实测约 18.906 Hz
- 配对：视频与深度严格同帧；无历史融合、无深度范围 EMA；逐帧 P2/P98
- 液化：偏移强度 0.85，羽化 96 px，拉伸 65%
- GPU：预处理和稳定化开启；两捕获槽；固定深度输出；异步捕获观察
- 显示：SmartGlasses 3840×1080@60 Hz

完整测试矩阵见 [test-matrix.md](test-matrix.md)，设备与安装基线见 [device-summary.json](device-summary.json)。

## 性能读数

长期窗口和测量边界在 [performance-summary.json](performance-summary.json)。关键读数如下：

| 指标 | 统计窗口 | Mean | P95 | 说明 |
| --- | ---: | ---: | ---: | --- |
| QNN 推理（诊断快照的滚动 Mean） | 1182 个快照 | 30.761 ms | 31.125 ms | 不等于端到端延迟 |
| GLES GPU 计时器范围（滚动 Mean） | 1182 个快照 | 17.034 ms | 18.592 ms | 范围包含当前仪表覆盖的 GPU 工作 |
| 捕获到上传（滚动 Mean） | 1182 个快照 | 75.768 ms | 86.115 ms | 含排队和主机/上传路径 |
| 队列等待（滚动 Mean） | 1182 个快照 | 1.838 ms | 2.114 ms | 与其他阶段不可直接相加 |
| 成对视频落后 `pairedVideoLagUs` | 1182 个快照 | 82.86 ms | 125.0 ms | 最新解码 PTS 与接受成对帧的 PTS 差 |
| 诊断画面年龄 `ageMs` | 1182 个快照 | 102.717 ms | 147.0 ms | 播放器诊断字段 |

`gpuLiquidMeanMs` 当前不能作为液化耗时：同一窗口中位数约 0.003 ms、P95 约 0.021 ms，但最大值约 8.391 ms，说明 timer 没覆盖完整 compute/完成路径。具体证据和解释见 [performance-summary.json](performance-summary.json)。

SurfaceFlinger 采样见 [presentation-summary.json](presentation-summary.json)：采集约 579.789 秒，滚动历史去重后 28,700 个有效时间戳，实际呈现间隔中位数 16.610 ms、P95 33.221 ms。记录含无效 sentinel 和采集器空洞；这些 >100 ms 间隔不能单独当作物理丢帧结论。

## 画面和同步证据

截图只用于确认执行路径和生命周期，不替代逐帧质量评分：

- [depth-preview.png](evidence/depth-preview.png)：视频信息中的有效深度预览和 SBS 输出。
- [sbs-playing.png](evidence/sbs-playing.png)：SBS 播放画面。
- [2d-mode.png](evidence/2d-mode.png)：2D 模式左右重复画面。
- [seek-buffering.png](evidence/seek-buffering.png)、[seek-recovered.png](evidence/seek-recovered.png)：seek 的 buffering 与恢复。
- [mirror-prompt.png](evidence/mirror-prompt.png)、[display-recovery-black.png](evidence/display-recovery-black.png)：外接显示恢复阻塞。

图像和深度 PTS 在本仪表中能严格配对（unknown/future/missing 均为 0），但 `pairedVideoLagUs` 仍约 83–125 ms，不能宣称零延迟。音频和字幕继续跟随原播放器时钟，本轮没有独立口型或字幕 cue 测量，音画/字幕同步仍未证实。

## 证据边界

原始结构化日志、SurfaceFlinger 采样和设备快照保留在本机 `.local` 目录，未提交到 Git；脱敏汇总和必要截图在本目录。没有提交账号、令牌、LAN 地址、服务器 URL、APK、视频、SDK 或未脱敏 logcat。证据清单见 [evidence-manifest.json](evidence-manifest.json)。
