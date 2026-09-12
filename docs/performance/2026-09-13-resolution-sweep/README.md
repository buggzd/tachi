# 2026-09-13 SM8850 深度分辨率扫描

算法基线 `5a906ef`。本轮只扩展实验模型清单、lab 构建控制和测量工具；没有修改产品深度滤波、视差强度、采样节拍或默认 266 模型。原生 lab 与产品共享 `QnnDepthProcessor`、`TemporalDepth`、`NativeVideoView` 和 `NativeVideoEngine`。

## 可用范围

**392×224 是本轮接近原定 12 Hz 的画质升级候选；518×294 可以运行，但目前约 8 Hz。** 最高跑通的已测档位为 644×364，其 NPU 推理自身已超过 83.33 ms，当前后端无法达到 12 Hz。770×434 在会话创建期间发生原生分配失败，没有成功推理。

这是离散档位扫描，不是证明 644 是硬件的绝对最大尺寸；644 与 770 之间、392 与 518 之间尚未逐个 patch 档位搜索，也未测试离线 QNN context 生成。以目前管线，增加空间分辨率会降低深度更新率，画质是否值得交换仍需相同片段主观 A/B。

## 条件和计量

- 同一台 SM8850 / V81 / Android 16，约 15 GiB 可见内存，无线 ADB，充电。成功测试结束的电池传感器温度约 31–33°C；电池温度不代表芯片温度，也不能证明无降频。
- 使用已有 Jellyfin 动画的本地 H.264/AAC 副本，1920×1080、23.976 fps、约 120 秒。经本机 HTTP + ADB reverse 播放，不读取账号或生成新的正式观看上报。
- Media3 硬解 → 原始 OES → 对应尺寸 RGBA/PBO → CPU CHW → QNN → CPU 稳定 → R8 → 每眼 1920×1080 gather33 → 手机缩小预览；深度小窗开启。没有测试外接 Presentation 最终显示、字幕并发和完整设备回归矩阵。
- 每次使用真正重新固定形状、校准的 U16/I8 QDQ 模型，不是上采样已有深度。输入/输出尺寸由同一个 Gradle profile 贯穿；运行时校验模型哈希和输出长度，持续 valid 上传证明输出通过有限值/非退化范围检查。模型检查 JSON 中的 CPU smoke 本身不是 NPU 证据。
- 继续禁用 CPU EP fallback，`offload_graph_io_quantization=0`。沿用 ORT 1.22.0 / QAIRT 2.50.40；APK 校验模型和全部九个厂商库哈希。518 进程 maps 另观察到 HTP、V81 Stub、Prepare。加载库本身不等于推理成功，必须同时有 ready、有效深度及增长的上传计数。
- 更新率以 playing + ready + valid 区间的计数增量/实际时间计算，去掉最初 15 秒。分阶段 ms 是最后一条记录中最近最多 512 次的均值/P95，**不把重叠窗口平均，也不把各项 P95 相加**。不足 512 次时可能包含早期预热。
- 深度年龄是取帧到现在的墙钟时间，不是视频/深度媒体 PTS 差。GPU 计时与 CPU 工作重叠，也不等于视频解码帧率或屏幕呈现帧率。没有取得覆盖全程的解码/呈现帧轨迹，不宣称零掉帧。

## 普通 Debug 安装扫描

| 深度尺寸 | 推理均值 / P95 ms | CPU 稳定均值 ms | 取帧→上传均值 ms | 深度 Hz | 去预热后区间 s |
| --- | ---: | ---: | ---: | ---: | ---: |
| 322×182 | 22.15 / 23.67 | 26.55 | 78.81 | 10.30 | 51.25 |
| 392×224 | 32.79 / 34.48 | 32.73 | 93.36 | 8.34 | 62.50 |
| 518×294 | 57.17 / 58.79 | 46.89 | 133.28 | 6.24 | 26.62 |
| 644×364 | 99.33 / 102.08 | 27.20 | 159.64 | 5.69 | 36.92 |
| 770×434 | 未完成会话创建 | — | — | — | — |

这些短扫描不是随机交叉实验：644 首次 ready 出现较晚，实际取样片段与其他档不同，CPU JIT/调度状态也未固定。因此 CPU 稳定耗时不一定随像素数单调变化，不能用 644 的较低 CPU 数字反推复杂度变小。518 在约 43 秒暂停，统计只使用此前连续播放，不把暂停记为吞吐下降。

原始数值（已删除 RGB 探针及所有非结构化日志）见各 `*-initial.jsonl`；`*-initial-summary.json` 包含实际窗口计数、P95、深度年龄和电池温度。392 初次扫描的 GPU 区间均值约 11.22 ms，518 为 11.44 ms，644 为 10.94 ms；各窗口 disjoint=0。

## 非调试构建与 ART 预编译对照

普通 Debug 的 `cmd package compile -m speed -f` 虽返回 Success，实际 dexopt 只到 `verify`。新增 lab 专用 `-PlabPerformanceBuild=true` 关闭应用调试标志后，重新安装并执行该命令，系统明确报告 `status=speed, reason=cmdline`。

这组联合改变了调试标志和预编译状态，**不能把收益全归因于其中某一项**；不代表任意手机正常安装后都会立即得到同样状态。没有修改主应用构建类型或算法。

| 深度尺寸 | 推理均值 / P95 ms | CPU 稳定均值 ms | 取帧→上传均值 / P95 ms | 深度 Hz | 去预热后区间 s |
| --- | ---: | ---: | ---: | ---: | ---: |
| 266×154 | 18.29 / 19.42 | 6.99 | 49.92 / 56.41 | 11.98 | 92.66 |
| 392×224 | 32.68 / 34.70 | 12.40 | 73.85 / 88.93 | 11.26 | 55.05 |
| 518×294 | 57.08 / 58.65 | 20.80 | 110.94 / 126.40 | 7.82 | 73.31 |

392 的推理几乎不变，CPU 稳定均值下降约 62%，更新率提高约 35%；518 的 CPU 稳定下降约 56%，更新率提高约 25%。这是短时配置对照，尚未隔离片段、运行顺序和热状态的全部影响。392 仍不是稳定满 12 Hz：其取帧到上传 P95 已超过 83.33 ms，单在途采样设计也会损失部分节拍。518 距离完整 12 Hz 更远，但单独推理仍有约 24 ms 的平均预算余量。

数据见 `266-performance*`、`392-performance*`、`518-performance*`。518 的深度小窗及左右眼输出已实际观察；这证明功能，不能替代鬼影/边缘跳动的主观验收。

## 770 的失败边界

CPU ONNX checker、静态形状及一次 CPU QDQ smoke 均通过，但手机创建会话时发生 SIGABRT。崩溃摘要为 `Scudo ERROR: internal map failure (error desc=Out of memory)`，另有 `std::bad_alloc`；栈涉及 `libQnnHtpPrepare.so` 的分配和 ORT `createSession`。

此时还没打开视频，不能归因为解码/SBS 并发。未采集完整编译峰值内存，因此不把失败解释为“16 GB 手机一定只能到 644”或认定某个确定的峰值。它说明当前模型、在线编译器及该次设备资源状态不支持这一档。没有尝试更高尺寸或自动重启，之后已安装较小模型并恢复成功播放。原始崩溃日志仅留本机，清单保留该模型哈希及失败状态用于复现，**不作为产品可选档位**。

## 复现与后续

模型生成仍使用 `StereoLab/prepare-qnn-model.py`，尺寸必须为 14 的倍数。新增 322×182、518×294、644×364、770×434；生成文件留在 `.local/npu/resolution-<width>`。构建前必须与 `AndroidApp/realtime-sbs-runtime.json` 哈希匹配。

```bash
# 普通安装扫描；仅构建独立 lab。
AndroidApp/gradlew -p AndroidApp -PnativeQnn=true -PdepthResolution=518 \
  :native-player-lab:assembleDebug
# 相同模型的非调试构建对照。
AndroidApp/gradlew -p AndroidApp -PnativeQnn=true -PdepthResolution=518 \
  -PlabPerformanceBuild=true :native-player-lab:assembleDebug
# 每个 APK 先另存，避免下一次构建覆盖；先完整 push 再 pm install 可排除流式安装停顿。
adb shell cmd package compile -m speed -f com.jellyfinforrayneo.nativelab
adb shell dumpsys package com.jellyfinforrayneo.nativelab
# 去掉 logcat 前缀和 quadrantsRgb，只保留 NativeVideoLab 的结构化 JSON 行后：
python3 StereoLab/experiments/summarize_resolution_trial.py trial.jsonl
```

脚本拒绝测量区间内的明显暂停、seek、日志缺口或计数重置。每次收集只选择当前进程，保留原始 trace 供复算；不混入前一次安装的日志。常规产品打包脚本和 Lite/Full 默认模型不变。

下一步先验证正式非调试 392 构建在眼镜和字幕并发下的长时表现，再考虑取样/合成调度、CPU 稳定加速与更高档位；预编译解决的是一部分 CPU 开销，不能修复深度轮廓时序或遮挡伪影。本轮未重新进行画质评分，也未发布 GitHub Release。

构建验证：322/392/518/644/770 普通 lab APK 均完成构建，266/392/518 非调试 lab APK 完成构建；原生模块 15 项 JVM 测试通过，lab 与原生模块 lint 通过。新摘要工具已用全部归档 trace 复算更新率，并验证 seek、时间逆行/缺口及样本不足会拒绝。此次无 WebView 源码改动，没有重跑产品前端/鉴权等无关回归；正式产品外接显示、字幕和长时热态未验收。

结束时重新安装并预编译 392 lab，验证暂停后的上传计数保持、lab GPU 2D/SBS 双向切换、恢复后上传继续增长，见 [最终冒烟记录](392-final-smoke.json)。这不是眼镜 USB 硬件模式切换。手机留在有效深度的 SBS 暂停画面；正式 tachi 应用未被替换。七项原有打包校验测试通过，六个另存 lab APK 的模型/厂商库哈希全部匹配，见 [APK 证据](apk-verification.json)。
