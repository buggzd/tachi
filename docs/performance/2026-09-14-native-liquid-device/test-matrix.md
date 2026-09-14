# 实机测试矩阵

测试提交为 `372985b`，安装包为 `0.3.1-sbs-liquid`。安装保留了应用数据；没有卸载、清空账号或改动播放器配置。设备是 Android 16 的 `2509FPN0BC`，外接 SmartGlasses 显示为 3840×1080@60 Hz。

| 项目 | 条件和实际动作 | 结果 | 证据 |
| --- | --- | --- | --- |
| ADB、安装和版本 | 无线 ADB 在线；校验 APK SHA-256；保留数据安装 | 通过 | [device-summary.json](device-summary.json)；[build-verification.json](../2026-09-14-native-liquid/build-verification.json) |
| 392 深度管线 | 播放已有 Jellyfin 片源，等待 `depthState=ready` | 通过；1182 个结构化采样均为 `playing + ready + valid + stereo` | [performance-summary.json](performance-summary.json)；本地原始记录：`StereoLab/.local/native-liquid-device/retest-20260914/long-20m/trial.log` |
| 实际参数 | 检查诊断字段 | 通过：392×224、24 Hz 目标、0.85 / 96 px / 0.65、严格配对、GPU 预处理和稳定化开启 | [device-summary.json](device-summary.json)；[depth-preview.png](evidence/depth-preview.png) |
| 深度预览和 SBS | 打开视频信息，观察深度小图、左右画面和裁切 | 通过基本功能检查；截图证明有有效深度预览和左右画面。截图不是逐像素帧对照，不能单独证明高动态轮廓质量 | [depth-preview.png](evidence/depth-preview.png)、[sbs-playing.png](evidence/sbs-playing.png) |
| L/R 方向 | 检查左右眼整体布局和人物 l/r 是否反向 | 左右眼整体布局未见反向；高动态素材第 347/579 帧未能通过手机播放入口复核，因此 l/r 运动轮廓结论未通过 | [sbs-playing.png](evidence/sbs-playing.png)；高动态素材列于限制项 |
| 2D ↔ SBS | 2D 显示、切入 SBS、重新播放 | 通过；切换会短暂重新初始化/等待首个成对帧，未见自动压平视差 | [2d-mode.png](evidence/2d-mode.png)、[sbs-playing.png](evidence/sbs-playing.png) |
| 暂停/恢复 | SBS 播放中暂停并恢复 | 通过；暂停时更新停止并保持最后有效成对画面，恢复后继续生成 | `StereoLab/.local/native-liquid-device/retest-20260914/lifecycle-paused.png`、`lifecycle-resumed.png` |
| seek | 连续 seek，观察 buffering 和恢复 | 部分通过；seek 进入 buffering，恢复后重新产生配对帧。连续按键造成的多次跳转不作为正常丢帧 | [seek-buffering.png](evidence/seek-buffering.png)、[seek-recovered.png](evidence/seek-recovered.png) |
| 播放器解码 | 约 1198 秒连续播放 | 通过该片源的稳定性检查；解码器丢帧增量为 0，跳过解码帧字段保持为 0 | [performance-summary.json](performance-summary.json) |
| GPU 液化执行 | 检查 `alignedLiquid`、GPU 标志和成对画面 | 路径启用且画面产出；液化专用 GLES timer 覆盖不完整，不能据此给出液化耗时 | [performance-summary.json](performance-summary.json)；本地 `trial.log` |
| 物理呈现 | SurfaceFlinger 外接层滚动历史采样约 580 秒 | 部分通过；去重后 28,700 个有效时间戳，实际呈现中位间隔 16.61 ms、P95 33.22 ms。23 个 >100 ms 间隔不能单凭该采集归因于物理丢帧 | [presentation-summary.json](presentation-summary.json)；本地 `presentation-exact.jsonl` |
| 后台/外接显示恢复 | 播放器退出后再次回到外接显示 | 不通过/阻塞；外接屏曾黑屏并弹出“镜像到外接显示屏？”，需要手动点击镜像才能恢复 | [mirror-prompt.png](evidence/mirror-prompt.png)、[display-recovery-black.png](evidence/display-recovery-black.png) |
| 音画和字幕 | 播放、暂停、seek 后检查独立时间戳 | 未完成；音频和字幕仍跟随 Media3 时钟，本轮没有口型或字幕 cue 的独立采样，不能宣称同步通过 | `device-summary.json` 的限制项 |
| 高动态素材 | `testvideo-4.mp4`，0-based 第 347/579 帧，30 fps 下约 11.567 s / 19.300 s | 未完成；本轮没有通过现有 Jellyfin 播放入口把该本地副本送入 APK，未声称 347/579 帧同帧通过 | `device-summary.json` 的限制项 |

## 画面问题记录

本轮没有建立可量化的轮廓鬼影、断点、直线弯曲或 l/r 形变评分。原因是用于长期记录的片源不是 `testvideo-4.mp4`，而截图也不携带可验证的源帧编号。下一轮应先把高动态素材放入现有匿名播放入口，然后同时保存源帧、深度帧、L/R 帧号和 PTS，再对人物右边缘 `r` 与左边缘 `l` 做局部位移测量。

## 同步结论

成对帧的 `depthPtsUnknown=0`、`depthPtsFuture=0`、`ptsMissing=0`，说明接受的 RGB/深度配对在媒体时间戳上是闭合的。`pairedVideoLagUs` 均值约 82.9 ms、P95 125 ms，说明成对画面相对最新解码帧存在排队落后；这不能与 `depthPtsLag=0` 混为零延迟。音频和字幕没有额外延迟补偿，也没有独立的口型/字幕测量，因此结论是“图深配对通过，音画和字幕同步未证实”。

## 下一步

1. 修复播放器退出、外接显示重建后的自动恢复，确保不需要用户手动镜像。
2. 用 `testvideo-4.mp4` 完成 347/579 帧的同帧证据，重点量化 L/R 的 `l`、`r` 边缘和背景拖色。
3. 修正 GLES timer 的 liquid pass 边界，再决定是否优化液化或配对等待；目前不能拿错误的 0.002 ms 读数做优化依据。
4. 增加音频、字幕 cue 与视频 PTS 的独立采样，再处理 83–125 ms 的图像排队落后。
