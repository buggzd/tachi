# 2026-09-12 新日志、画质盲测与 392 深度试验

基线 `290d36e`。本轮提供可直接评分的本地浏览器盲测，以及两个可覆盖安装的 Full Debug APK。没有操作 ADB；392 模型在 Android QNN/HTP 上的实际运行、速度与稳定性仍待用户实机回传。浏览器使用预计算 float 深度，不能把其播放帧率当成手机 NPU 性能。

后续：[9 月 13 日首轮用户评分](user-ratings.md)。D 在前两段是 392、第三段是 266 基准；完整评分的第三段基准更好，但所有方案仍有明显画质问题，尚不足以替换默认模型。

## 新日志说明什么

保留窗口有 120 条采样、64 条事件、0 条失败记录；不据此推断未保留的历史或某个具名视频已经修复。100 条为 playing + depth ready。下表是这些记录中**重叠滚动均值的中位数**，不是重新聚合全部原始单帧耗时：

| 阶段 | ms |
| --- | ---: |
| CPU 预处理 | 0.87 |
| QNN 路径推理（含 ORT 调用与取输出） | 18.25 |
| CPU 深度稳定处理 | 21.05 |
| 取帧到深度上传 | 61.11 |
| GPU 绘制 | 7.64 |

GPU 绘制与管线其他阶段存在重叠，不把表中所有数直接相加。约 20 ms 不是整张灰度图生成并用于当前画面的完整开销。

过滤暂停、跳转、换源等非连续区间后，89 段相邻采样覆盖 90.372 秒，推理更新约 11.82 Hz、解码约 23.93 fps、解码掉帧增量 0。深度墙钟年龄中位数 104 ms、P95 145 ms、最大 155 ms。包含恢复边界的 playing/ready 样本最大年龄 5758 ms 单独保留；暂停时媒体不前进，不能把该墙钟年龄解释成画面落后 5.8 秒。

日志没有图像或模型/视频精确 PTS 对，能确认时序风险，不能单独归因鬼影、计算视觉分数。原文件不入 Git；摘要、输入哈希、过滤规则见 [diagnostics-summary.json](diagnostics-summary.json)。

## 直观评分怎么做

本地页：`http://127.0.0.1:4190/quality-trials.html`。同机 Chrome 验证通过，服务只绑定 loopback；这个地址供电脑使用，不是手机可访问的局域网地址。

- 三段既有片源，各取前 96 个解码帧（约 4 秒），循环观察；每段的 A–D 独立随机排列。
- 可切换单眼画面、SBS 双眼、实际深度、原片参照。单眼适合观察轮廓；局部 2 倍可点击选观察位置。SBS 模式禁用局部放大，保留双眼几何。
- 鬼影控制、稳定性、边缘细节分别评 1–5，越高越好。没有默认分数；需播放观察后才能保存。可以先评一段，部分完成也能导出。
- 评分在本机保存；点击「导出评分」得到 `tachi-sbs-ratings.json`。包含方案映射、片段/数据哈希、观看模式、倍率、浏览器跳帧提示、备注及是否已揭盲，不包含服务器地址、账号或视频标题。
- 揭盲会记录到该片段的后续评分，即使切换分组也不冒称盲测。新一轮前先导出，重置会明确确认。

这是一位用户的主观对照，不宣称正式 ITU 主观实验或人群 MOS。浏览器自动测试中的两条模拟评分只存在于隔离测试上下文，未混入用户评分。

## 四组分别回答什么问题

| 内部标识（不是固定 A–D） | 深度 | 历史处理 | 更新/配对 | 用途 |
| --- | --- | --- | --- | --- |
| p0 | 266×154 | 当前真实 Java 稳定器 | 视频半帧率，模拟延后 2 个视频帧 | 当前算法参考 |
| p1 | 266×154 | 去掉像素历史融合，仍保留分位范围平滑/切镜行为 | 同 p0 | 历史残留与模型自身抖动的取舍 |
| p2 | **392×224 实际模型推理** | 同 p0 | 同 p0 | 提高模型采样密度是否改善轮廓 |
| p3 | 266×154 | 同一每次更新权重 | 每个视频帧推理，零外部配对延迟 | 更新率/时序对齐的离线诊断 |

p2 是重新固定形状并实际推理得到的结果，不是把 266 的图放大。但对照页刻意给 p0/p1/p2 同样的模拟延迟来隔离空间效果；**真实手机的 392 很可能更慢**。p3 同时改变采样率、配对延迟和滤波的墙钟响应，不是严格单变量实验，也不保证画质最好，更不意味着手机已实现该管线。启动时假设第一张深度可用，主要观察循环中的稳定区间。

Java 原类按对应尺寸编译执行；p1 只移除同一处历史融合分支。浏览器以 native gather33 的相同视差（0.016）、候选范围、前景优先与缺口回退生成画面，每眼真正绘制 1920×1080；外部 OES 纹理转换为浏览器视频纹理。这不是 Android 录屏，也不包含真实手机 HDR/解码色彩差异、调度延迟或 NPU 量化误差。灰度仍为 R8，改变的是空间分辨率。

数据来自同一权重的固定 float 模型，输入与输出哈希、分辨率、实际采样率、桌面 CPU 用时及文件长度见 [dataset.json](dataset.json)。本轮每种分辨率 288 帧，共 576 次推理（3 × 96 × 2），不要把四个处理配置当四次模型推理。中间模型、深度二进制和真实视频只在 `.local`；无几何真值，不给高分辨率虚构准确率提升。

## 手机 392 测试包

通过 `-PdepthResolution=392` 选择固定的 392×224，贯穿 GPU 下采样、PBO/CPU 缓冲、QNN 张量、稳定器及 R8 上传；一个 APK 只携带一个模型。还核对了两包 DEX 中编译后的取帧常量与包内模型哈希，见 [apk-verification.json](apk-verification.json)。正常构建仍是 266×154，常规 Lite/Full 发布输入不变。`experimentalModels.392.deviceValidated=false` 记录尚未完成设备验证。

392×224 为 87,808 个像素，相比 40,964 增至 2.14 倍。ViT patch token 从 209 增至 448，注意力的 token-pair 项可增至约 4.59 倍，不能只用 18 ms 线性外推。M4 上固定 float 模型本轮中位数从约 22–26 ms 增到 53–57 ms，仅作桌面参考。

新模型完成 ONNX 静态形状校验及一次 CPU QDQ 推理，输出非恒定且全部有限；证据见 [model-check.json](model-check.json)。**它证明模型可执行，不证明手机 QNN 图成功编译、全部放到 HTP 或达到实时。** Android 仍明确禁用 CPU EP 回退，需手机出现持续 ready、有效深度和推理计数增长后再讨论实际 NPU 性能。

提供的文件位于 `AndroidApp/app/build/distributions/`，各约 101 MiB，附 SHA-256：

- `tachi-depth266-20260912-full-debug.apk`：266 基准，补充尺寸诊断。
- `tachi-depth392-20260912-full-debug.apk`：392 试验。

同 Debug 应用 ID/版本号/签名，可覆盖安装保留设置；不同时安装。建议固定片段、位置、SBS 强度和显示大小，先后各观察至少 30 秒；等首次模型准备完成再计稳定段。分别导出诊断，检查顶层 `realtimeDepthResolution`、每条渲染记录的 `depthWidth/depthHeight`，以及推理/稳定处理耗时、上传耗时、有效深度年龄和更新率。高分辨率慢帧继续保持有效深度，不增加自动压平策略；有问题可覆盖回 266 包。

## 复现与验证

Python 使用 `StereoLab/experiments/requirements.txt`，JDK 在 PATH 或设置 `JAVA_HOME`。先准备既有模型、至少三张校准 PNG、三个本地片段，再生成 392：

```bash
python StereoLab/prepare-qnn-model.py \
  --source StereoLab/.local/models/depth-anything-v2-small/onnx/model.onnx \
  --calibration StereoLab/.local/npu/calib --output-dir StereoLab/.local/npu/resolution-392 \
  --width 392 --height 224 --activation u16 --weight i8
python StereoLab/experiments/prepare_quality_trials.py
npm --prefix StereoLab run dev -- --port 4190
node StereoLab/experiments/verify_quality_trials.mjs /tmp/tachi-quality-page.png
./scripts/build-android.sh debug full 392
# 先保存前一个 APK；不同分辨率共用 Gradle 输出位置。
./scripts/build-android.sh all full
```

生成版本/量化依赖必须匹配固定 manifest，构建不会接受任意替换的模型。可用 `scripts/realtime-sbs-bundle.py` 的 `--resolution 392` 单独打包/校验实验输入；默认仍只选择 266。

通过：两种尺寸的 150 项 JVM 测试、Native Lab 的 392 QNN 编译、前端检查和测试、Android lint、392 Full Debug、266 Full Debug/Release 与默认 Lite Debug 构建、APK 资源/模型校验、签名验证；新增包体回归保证 392 APK 不能冒充默认 Full。StereoLab 12 项测试通过；真实浏览器验证三段加载、WebGL 无错误、原片方向/采样匹配、SBS 尺寸、评分下载及揭盲记录。设备回归矩阵尚未执行，未发布 GitHub Release。
