# 日常 SBS 双档与端到端测量

基线 `f5d3532`，本轮加入非调试日常实验构建、精确 PTS 诊断与完整模型共享缓冲验证。
日期 2026-09-13；SM8850/V81，RayNeo Air 3S，物理 3840×1080 / 60 Hz，每眼 1080p。
QAIRT 2.50.40.260831 / QNN 2.39.0 / ORT 1.22.0；固定模型哈希见
[APK 校验](apk-verification.json)及仓库运行库清单。两档均确认 `debuggable=false`、ART `speed`。

## 可日常试看的双档

运行 `scripts/build-sbs-experiment.sh quality` 或 `motion`。
APK 在 `AndroidApp/app/build/distributions/`，沿用 `.debug` 身份和本机 Debug 签名，
互相覆盖保留开发版设置，不覆盖正式版。GPU 稳定、精确查表 CHW、双捕获槽、固定主机输出、
异步捕获观察均开启；没有自动变平、CPU 回退或根据负载自动换模型。

- quality：518×294，12 Hz 调度目标，优先深度轮廓细节。
- motion：392×224，24 Hz 调度目标，实测产品更新约 21.7 Hz。

两次构建均完成两模块 JVM 测试（137 + 22 = 159）、lint、APK 组装与资源一致性验证。
安装质量档后的设备 APK SHA-256 与交付文件完全一致。交付包各约 95.3 MiB，包含模型。
实际观看偏好仍需用户比较；性能通过不能替代鬼影/边缘稳定性的主观验收。
实机已验证覆盖安装后保留账号、冷启动、HLS/ASS、2D 与 SBS 显示和停止后重播；
未将这些用例扩展宣称为全部账户、插拔、字幕格式和故障注入矩阵已通过。

## 同一媒体时间范围比较

片源为同一集 25 分 24 秒的实际 Jellyfin 动画，原始 1920×1036 / 23.976 fps，
本次走 H.264/AAC HLS，ASS 字幕开启，硬件解码器 `c2.qti.avc.decoder`。
两次均从片头播放，先 quality 后 motion；不存在同时运行另一 NPU benchmark 的干扰。
选择共同媒体区间 60–360 秒，排除会话初始化。
下表耗时为该区间每秒**滚动窗口均值/P95 的中位数**，不是合并全部帧后的总体 P95。
完整汇总：[共同区间](matched-media-window.json)。

| 指标 | 518 / 12 Hz | 392 / 24 Hz 目标 |
| --- | ---: | ---: |
| 实际深度更新 | 12.00 Hz | 21.68 Hz |
| QNN 推理均值 | 56.37 ms | 31.81 ms |
| CPU 输入包装均值 | 0.056 ms | 0.041 ms |
| 队列等待均值 | 0.58 ms | 1.28 ms |
| 捕获到工作线程均值 | 10.97 ms | 12.24 ms |
| 捕获到深度完成观察均值 | 72.14 ms | 49.80 ms |
| SBS GPU 绘制均值 | 7.19 ms | 7.16 ms |
| 视频减深度源帧 PTS 均值 | 84.15 ms | 48.47 ms |
| 视频减深度源帧 PTS 的 P95 | 125.13 ms | 83.42 ms |

motion 的更新率提高约 81%，平均 PTS 差降低约 42%；**这不表示画质提高 42%**。
518 的价值是模型空间分辨率，392 的价值是时间响应；不能只用推理时长选择最终档位。

## 长时间播放与异常

quality 首段连续有效窗口 **1239.341 秒（20 分 39 秒）**，实际视频也前进 1239.344 秒；
深度更新 14872 次，约 11.9999 Hz。29,714 个新增解码视频帧均完成精确 PTS 映射，
Media3 丢帧、GL 序列跨帧、PTS 缺失/未知/负向计数增量均为 0。
前后 5 分钟窗口推理维持约 56 ms，没有持续吞吐下降或队列增长。

随后 HLS 出现缓冲，缓冲位置接近可用数据末端，深度仍 ready，未出现播放器错误码。
短暂恢复后继续缓冲。这些片段保留在原始数据中，但**不计入连续有效成绩**。
同期无线 APK 安装明显变慢；桌面访问服务端健康接口为 HTTP 200 / 约 20 ms。
这些证据不足以定位为 Wi-Fi、转码或服务端媒体读取中的某一种原因，不能称整集无中断。

motion 对照连续有效 **440.923 秒（7 分 21 秒）**，约 21.68 Hz，同样无解码/GL 序列丢帧
或 PTS 映射缺失。这是较短顺序对照，不是另一轮 20 分钟温控验收。

quality 的滚动最大 PTS 差曾达 **542.2 ms**，出现在仍为 playing 的片段。
这属于旧深度持有的长尾；当时近期推理和队列均值没有相应的大幅上升。
当前诊断不足以唯一归因于候选深度拒绝、单次调度停顿或其他交接因素，不能归为 NPU 慢帧。
该现象说明“解码丢帧 0”不能排除边缘错位与跳动。

本轮外部供电、电量 100%，系统热状态采样为 0，电池约 quality 28.5–30.2°C、
motion 29.4–30.3°C。OEM 上报的 CPU/GPU 温度也保存，但未校准，不把电池温度当作 SoC 温度。
没有做非充电功耗或续航实验。quality 两次 PSS 快照约 1.20 / 1.16 GB，不能据此证明无内存泄漏。

## 呈现统计的边界

分别保存对应视频 SurfaceView 的 SurfaceFlinger 统计：
[quality](quality-surfaceflinger.txt)、[motion](motion-surfaceflinger.txt)。两者系统图层
`droppedFrames=0`，但同时存在大量 `jankyFrames` / `appBufferStuffingJankyFrames`。
该 GLSurfaceView 既在新视频到达时绘制，也在深度更新时绘制；图层缓冲更新约 36 / 46 Hz，
不等于原视频帧率，更不表示生成了中间视频帧。系统 `renderRate=60` 且无明确 frame-rate vote，
因此不能把所有 jank 直接当作源视频丢帧，也不能忽略这些调度信号。

图层累计统计包含开始/停止边界，quality 还包含末段缓冲。`--latency` 每两秒读取的环形
时间戳曾受 ADB 间隙影响（约 14 秒），因此未把跨采集缺口的间隔当成屏幕冻结。
下一步如果优化呈现节奏，应将 EGL frame ID 与源视频 PTS 对应，再检查单帧的实际呈现。
本报告不是光学端到端延迟测量，也未证明每一个解码源帧都在物理眼镜上呈现。

## 数据与复现

- [quality 原始脱敏快照](quality.jsonl)、[汇总](quality-summary.json)、[热状态](quality-thermal.jsonl)。
- [motion 原始脱敏快照](motion.jsonl)、[汇总](motion-summary.json)、[热状态](motion-thermal.jsonl)。
- 图层环形时间戳采集：[quality](quality-presentation.jsonl.gz)、[motion](motion-presentation.jsonl.gz)，
  gzip 压缩 JSONL，保留相对采集时间以识别缺口；三列为系统 desired / actual present / ready 时间。
- `StereoLab/experiments/summarize_daily_trial.py <log-or-jsonl> --source <number>`：
  根据 playing/ready、视频推进和数据间隔拆分连续片段；按 5 分钟窗口计算计数器差分。
- `StereoLab/experiments/collect_presentation_trial.py --layer '<选定视频层>' --output <本地文件>`：
  采集该图层环形时间戳及有限热字段。具体层名每次启动都需要重新查询。
- 精确 PTS 从解码释放元数据映射到 SurfaceTexture，沿捕获、推理、GPU 应用传递。
  GPU 在 fence 被观察到之前已可能改变深度纹理，因此在完成结果确定后回填这一小段绘制的
  源帧 PTS，避免把观察延迟错误标成深度年龄。最多保留 64 个待确定绘制，超出明确记 unknown。

PTS 指标按 GL 绘制采样（包括同一颜色帧的深度更新），历史融合仍包含更早的深度信息。
它测的是最新采用深度候选的源 PTS，不是历史滤波的有效曝光时间。

## 下一步的依据

保留 quality 作为优先试看档，同时提供 motion 对照。CPU 输入包装只剩约 0.05 ms，
继续微调这部分很难改变体验；完整模型共享缓冲和捕获/呈现调度更值得推进。

已观察到的典型错位相当于 518 约 2–3 个视频帧、392 约 1–2 个视频帧。
可据此研究有置信度的运动重投影，或少量颜色帧缓冲，但不能直接把全部视频固定延迟而
不同时处理音频、字幕和时钟。542 ms 的长尾也不适合用无限增长的视频队列掩盖。
共享缓冲的完整模型结果与尚未接入产品的边界见下节。

## 完整模型共享缓冲

已在独立 benchmark 接入并实测完整 **518×294** 模型，原始记录见 [fullshared.txt](fullshared.txt)。
采用与产品同哈希模型、同 QAIRT 和 ORT QNN EP，禁止 CPU fallback，图 I/O 量化仍留在 QNN。
由 ORT 导出上下文后关闭会话，通过 QNN System 读取真实描述，再原生恢复图：

- 编译上下文 84,460,800 字节，**单个完整 QNN 图**。
- 输入 Float32 `[1,3,294,518]`，输出 Float32 `[1,294,518]`，无需假设内部量化布局。
- 三张不同实际校准图，普通原生 graphExecute 对 ORT 输出逐像素最大绝对误差 **0**。
- 输入/输出分别注册约 1.83 MB / 0.61 MB 页对齐 AHardwareBuffer BLOB，使用
  `QNN_HTP_MEM_SHARED_BUFFER` 自定义描述；公开 AHardwareBuffer 初始化和只读匹配确认数据 fd。
- GPU 在共享输入中轮换三组参考 CHW，HTP 执行完整图，GPU 读取共享输出并逐像素校验。
  5 次预热 + 100 次测量均通过，误差阈值 `1e-6`；每轮图像主机拷贝 0，状态读/写各 4 字节。
  三组图像输入与参考输出只在测量前上传一次，不是每轮从 CPU 提交图像。
- 内存注销、上下文、设备和后端释放通过；旧的 RPC/小图 GPU 共享入口仍回归通过。

最终一次测量：

| 同一个原生图的路径 | 均值 | P95 |
| --- | ---: | ---: |
| 普通主机 I/O 的 graphExecute | 57.08 ms | 57.84 ms |
| 注册共享 I/O 的 graphExecute | 56.28 ms | 57.17 ms |
| GPU 写共享输入 → HTP → GPU 校验完整循环 | 62.13 ms | 63.56 ms |

第一次完整验证也通过，普通/共享执行约 56.62 / 56.54 ms。两次都说明模型计算本身没有
数量级变化；不能用最终一次约 0.8 ms 的差值声称稳定性能收益。
完整循环包含 GPU 校验与同步等待，和产品「捕获到深度完成观察」也不是相同指标。

这一步已经将共享验证从 16 个 ReLU 元素扩展到真实完整模型，但**尚未替换产品的 ORT Java
主机缓冲路径**。验证程序使用预先准备的三组 CHW/参考输出，未包含实时 OES 预处理、
时序稳定、SBS 绘制或音视频时钟；目前仍用 `glFinish` 和同步 graphExecute 建立可见性。
下一步应将真实 GPU 预处理直接写入注册输入，并将共享输出交给稳定器，以有界槽位和明确
的 GPU/HTP 完成同步管理重用，再与本报告的产品端到端基线比较。不能把本次证明写成
“播放器已经零拷贝”，也不能将 glFinish 带进最终播放器作为性能优化结果。

构建/启动说明见 [独立 benchmark](../../../StereoLab/npu-benchmark/README.md#full-depth-model-shared-buffer-stage)。
用于验证的缓存、模型、SDK 和 APK 不进入 Git。
