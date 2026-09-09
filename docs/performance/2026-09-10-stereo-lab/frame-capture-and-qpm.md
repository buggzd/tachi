# QPM 获取核实与取帧共享读回实验

测试日期：2026-09-10。此记录只覆盖 SDK 获取核实和桌面 StereoLab 取帧实验，未进入正式播放器集成。

## QPM 真实访问结果

使用 Google Chrome 打开 Qualcomm Package Manager 的官方入口：
`https://qpm.qualcomm.com/#/main/tools/details/Qualcomm_AI_Runtime_SDK`。
接受 Cookie 提示后页面先显示加载转圈，随后跳转到 `myaccount.qualcomm.com` 的
`My Account` 登录页。页面明确显示 `Email*`、`Password*`、`Sign in`，并写明
“With a Qualcomm ID, you can access product information, such as documentation, tools,
software, support communities, and more.”，另有 Qualcomm employee / Qualpass 提示。

这证明当前障碍是明确的 Qualcomm ID 登录/授权，而不是根据静态 HTML 壳推断的权限错误。
未代填账号、密码或验证码；登录前没有可读取的发行版本、V81 支持矩阵、下载包或校验值。
此前的公开 QAIRT 2.25 资料仍只覆盖到 HTP V75，不能作为 SM8850/V81 部署包。
要继续取得官方环境，需要用户在 Chrome 的 Qualcomm 登录页完成登录并返回 QPM；下载时间另计。
当前本机再次运行 `StereoLab/.local/platform-tools/adb devices -l` 没有在线设备，手机侧 NPU
执行仍以此前保存的 Direct probe 失败证据为准。

## 一次读取派生运动缩略图

基线是 `809b30a` 的原始链路：每个视频回调先读取一次 96×54 RGBA 缩略图供运动估计；
模型空闲时再把同一视频绘制/读回为 266×154 并打包 RGB。候选只改了这一环节：在模型推理
启动的回调中使用那次 266×154 的 RGBA 读回，通过中心采样派生 96×54 灰度；模型忙时仍
使用原来的 96×54 读取。模型、运动场、渲染、素材和测量脚本不变。

测试条件完全相同：macOS Apple Silicon、Chrome 152 headless + ANGLE Metal、WebGPU FP16，
1920×1080 Jellyfin 片段，266×154 输入，640×360 每眼，Debug/运动传播/SBS 渲染开启，
每个片段预热后测 12 秒。原始指标保存在：

- [基线 JSON](frame-capture-baseline.json)
- [共享模型读回 JSON](frame-capture-shared-model-read.json)

三段素材的逐段 P50/P95 如下，单位为毫秒：

| 素材 | `processingMs` 基线 → 候选 | `processingMs` P95 基线 → 候选 | SBS 回调 fps | 有效立体帧占比 | 深度年龄 P50/P95（候选） |
|---|---:|---:|---:|---:|---:|
| Sample 1，23.976 fps | 9.1 → 5.6 | 10.6 → 6.8 | 23.994 → 23.995 | 98.6% → 99.3% | 41.7 / 83.4 |
| Sample 2，23.976 fps | 9.2 → 5.7 | 10.7 → 6.7 | 23.909 → 23.908 | 98.3% → 97.9% | 83.4 / 83.4 |
| Sample 3，25 fps | 9.4 → 5.7 | 11.7 → 7.2 | 24.912 → 24.990 | 97.3% → 98.0% | 80.0 / 80.0 |
| 三段中位数 | 9.2 → 5.7（−38.0%） | 10.7 → 6.8（−36.4%） | 23.994 → 23.995 | 98.3% → 98.0% | — |

`captureMs` 在候选的模型回调中包含较大图像读回和灰度派生，因此中位数约增加
0.5–0.6ms；`inferenceCaptureMs` 也包含同一段共享读回，不能与 `captureMs` 相加，
不能据此说读回本身变慢。应以端到端主线程 `processingMs` 判断重复读回是否减少。
模型 Worker 的 `inferenceMs` 中位数保持约 17.8–18.0ms，说明本次收益来自主线程去掉一次
Canvas 读回，而不是把模型计算时间误计为取帧收益。

功能检查三段均通过：非平面深度、左右眼差异、超越平面位移的场景深度像素变化、暂停、
seek 和单视频约束均通过；候选 Debug 深度范围为 208/255/255，说明估算深度仍实际显示。
解码丢帧三段均为 0；SBS 提交率和深度年龄没有一致的改善或恶化趋势，因此不把它们宣称为
此次改动的性能收益。

## Worker 边界

当前实现仍在主线程完成 `drawImage(video)` 和 `getImageData()`；深度模型的预处理、推理和
结果缩小已经在 Worker。把视频读回移到 Worker 需要额外的 `VideoFrame`/`ImageBitmap` 传输，
会改变时序和内存所有权。本轮没有把这条路径混入共享读回实验，也没有把“模型在 Worker”
解释为“取帧成本已消失”。下一次应单独以同样素材测量 VideoFrame/Bitmap 传输的主线程 P50/P95、
提交率、深度年龄和画质；若无净收益，不保留该复杂路径。

## 当前结论

不依赖 SDK 的共享读回改动有可重复的主线程收益，并通过桌面功能门槛，可以保留在
[StereoLab/main.js](../../../StereoLab/main.js)。它不能证明 Android WebView 或手机 NPU 的
同等收益。NPU 最短执行链路仍停在官方 V81 运行环境获取：QPM 登录前无法得到可追溯的 QAIRT
发行包，手机当前也没有在线 ADB；取得 SDK 后应先按官方版本重新做 FP16 最小图的
`backend/device/context/graph` 验证。
