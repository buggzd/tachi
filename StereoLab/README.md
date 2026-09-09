# tachi 实时 SBS 算法实验

独立、只在本机运行的可行性验证页。一个 HTML `<video>` 解码视频，
Depth Anything V2 Small 在浏览器 WebGPU 中实时估计深度，WebGL 2 输出左右眼。
不使用预计算深度，也不调用云端推理。此实验尚未接入 Android APK、原生 NPU、
Jellyfin 的正式播放/上报链路或眼镜 USB 控制。

首轮结果与证据边界见 [2026-09-09 桌面验证](../docs/performance/2026-09-09-stereo-lab/README.md)。

## 运行

需要 Node.js 22+、Chrome（WebGPU/WebGL 2）、FFmpeg/FFprobe。

```bash
npm --prefix StereoLab ci
npm --prefix StereoLab run models
npm --prefix StereoLab run samples
npm --prefix StereoLab run dev
```

打开 `http://127.0.0.1:4188/`，点击「加载深度模型」和「播放 / 暂停」。
先以 266px 深度输入检查性能，再比较 378px、518px 的细节。
每眼输出可独立选择 640×360、1280×720、1920×1080；最大传输画面为 3840×1080。
视频默认静音，可以使用下方唯一视频的原生控件开启声音。

Debug 默认并排展示原视频、模型估计深度和时间对齐后的渲染深度。白色较近、黑色较远，
均为相对值。模型面板保留估计对应的视频时间；渲染面板显示当前视频时间、深度年龄与
剩余立体强度。无效历史在切镜/seek 后清空，避免把上一镜头的深度误认为当前估计。

`models` 下载固定 revision 的 ONNX 权重及模型配置，记录 SHA-256；默认 FP16，
`?dtype=fp32` 可验证 FP32。下载支持 `HTTPS_PROXY`，在 macOS 上也会尝试系统 PAC
中的代理指令。代理地址和认证信息不写入记录。运行页只读取本地模型。

`samples` 读取被忽略的 `.jellyfin-dev.json`，自动回溯主 Git 工作区，也接受已有的
`RAYNEO_JELLYFIN_DEV_CONFIG`。它从当前账号可访问的媒体中抽取三个 20 秒片段，
在电脑上转为最大 1080p 的 H.264/AAC MP4。不会修改看过状态或上报观看进度。
FFmpeg 只收到临时 loopback 地址；Jellyfin Token 留在进程内存中的请求头。
结束后关闭代理并退出实验登录会话。

```bash
npm --prefix StereoLab run samples -- --count 3 --seconds 20 --offset 120
```

模型、真实片段、截图、生成 bundle 和验证输出均保存在被忽略的目录。
真实媒体不得直接提交；脱敏后的技术报告可进入 `docs/performance/`。
本地切片用于隔离算法性能，不证明网络直放、HLS、DRM、字幕或 Android 已经兼容。

## 核心算法

采用与现有银幕一致的眼内视差符号：`D = uL - uR`，正值增加会聚。
所有位移均先换算到每眼原生像素，SBS 右眼的横向区域起点不属于视差。

```text
n = clamp((q - shotLow) / (shotHigh - shotLow), 0, 1)
D = base + amplitude × (n - 0.5)
uL = inset + u + D / 2
uR = inset + u - D / 2
```

`base`、`amplitude` 在界面中按 1920px 参考宽度设置，再随实际每眼宽度等比缩放。
默认基础视差 8px、幅度 24px、画面大小 90%，对应总视差区间 -4…20px。
几何验证只保证不越过眼区，不代表经过光学校准的距离或舒适范围。

| 阶段 | 实现与边界 |
| --- | --- |
| 真实深度 | Worker 中的固定版本 DA V2 Small ONNX；输入尺寸为 14 的整数倍；处理原始浮点输出，避免把 FP16 位模式当作深度 |
| 相对深度范围 | 5%/95% 分位数建立镜头范围，以 2% 权重缓慢更新；不对每一帧独立拉满对比度 |
| 时间传播 | 96×54 灰度网格上的 8×8 分块匹配，搜索 ±4 格；按匹配误差降低历史可信度；当前/历史融合权重 0.65/0.35 |
| 推理结果对齐 | 保存最多 24 帧且不超过 0.5 秒的运动历史；新深度沿历史传播到当前视频时间；拒绝超过 250ms、跨切镜/seek 或不匹配的结果 |
| 过期处理 | 深度年龄 200–350ms 时逐渐降低立体幅度，350ms 后为平面；只有一个推理请求在途，5 秒无响应时终止 Worker 并报错 |
| 双眼重投影 | GPU 逐像素前向投射；颜色引导四邻域深度上采样；Z-buffer 保留近表面；同一视频纹理依次绘制两眼 |
| 背景补洞 | 对未覆盖像素做有界水平搜索；两侧都存在时选择较远表面，防止拉伸前景轮廓；保留外围黑边，不跨眼取样 |
| 生命周期 | 暂停后停止视频驱动的连续提交；seek、倒退/循环、明显切镜清理历史；模型错误停止 AI 更新并显示平面 |

显露区域的宽度近似为 `abs(Dforeground - Dbackground) / 2`。
增加立体强度会同步放大补洞需求和深度误差，建议先检查温和视差。

这是一套有意简化的实时基线：分块运动不等于精确光流；未实现前后向光流验证、
长期背景重建、生成式修补、稳健的跨帧仿射尺度拟合、字幕独立景深、黑边检测或
场景语义校验。相对深度可能在透明物、反射、细线条和运动模糊处出错。

## 验证与统计

```bash
npm --prefix StereoLab test
npm --prefix StereoLab run build
npm --prefix StereoLab run verify -- --geometry-only
npm --prefix StereoLab run verify -- --seconds 60 --width 1920 --input 266
```

验证器启动独立 loopback Vite 服务和 Chrome，结束时关闭；需要本机已安装 Chrome。
macOS 测试使用 ANGLE Metal；WebGPU 使用浏览器实验启用标志，因此不是其他浏览器的
默认兼容性声明。三个片段分别预热、计时，检查真实模型更新、非平面深度、双眼输出、
暂停、seek、视频单实例及性能门槛。长于片段的采样会覆盖自动循环。

门槛是：输出回调频率至少达到源帧率 90%，视频解码丢帧低于 2%，至少 80% 的
提交帧有未完全过期的立体深度。失败同样保存技术指标，不能把平面回退计作成功。
这些是实验准入门槛，不是观影画质或手机持续性能验收。

指标区分：

- `processingMs`：主线程取缩略图、运动估计和 GPU 提交的 CPU 墙钟耗时。
- `inferenceMs`：Worker 预处理、模型执行、结果读取/缩小的总耗时，包含 GPU 等待；不是纯模型内核时长。
- `gpuMs`：GPU timer query 测量纹理上传、重投影和补洞；不支持时为 null，不能用 CPU 提交时间代替。
- `callbackFps` / `missedVideoCallbacks`：视频帧驱动的 SBS 提交频率和漏掉的视频回调；不等于眼镜物理呈现帧率。
- `droppedVideoFrames`：HTML video 的解码/播放质量统计，与回调遗漏分开。
- `depthAgeMs`：当前视频时间减深度采样时间，包含推理期间视频前进的时间。
- `temporalDepthInnovation`：运动对齐后新深度与历史预测的平均差异；没有真值，不能解释为深度准确率。

测量在桌面浏览器中进行，同时开启了用于证据抓取的 `preserveDrawingBuffer`。
手机 NPU 性能、Android WebView 的视频纹理传递、音画对齐和长期温升都需要后续独立验收。

## 模型与依赖

- 模型：`onnx-community/depth-anything-v2-small`，revision
  `4472b7362082ad9968fee890ca0f1e5aca36b93d`，模型卡声明 Apache-2.0。
- FP16 ONNX SHA-256：`2df6223f206b5164e21f664ace61dabeb9bb6a49b8b5a3e00510b4807d0f5b04`。
- FP32 ONNX SHA-256：`afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c`。
- Transformers.js 3.8.1（Apache-2.0）、ONNX Runtime Web（MIT）、Vite 和 Playwright
  版本由此目录的独立 lockfile 固定；模型和依赖不会被打入 Android APK。

后续接入必须继续满足 [Android 架构](../docs/ANDROID_ARCHITECTURE.md)：
一个眼镜 WebView、一个 HTML video、一个声音与上报流。当前原生银幕复制不能直接产生
逐像素双眼差异，需先验证新的合成路径与原有基础视差如何协同。

## 手机 Chrome 验证

无线 ADB 连接后，将本地实验服务端口 reverse 到手机，并将
`localabstract:chrome_devtools_remote` forward 到本机空闲端口。
打开手机 Chrome 后，用 `--cdp http://127.0.0.1:<调试端口>
--url http://127.0.0.1:<实验服务端口>` 运行验证器；例如附加
`--width 640 --input 266 --seconds 12`。验证器创建和关闭自己的测试页，
断开 CDP 时保留手机 Chrome；ADB 映射由调用者管理。

手机报告写入 `.local/verification-android-*`，与桌面证据分开。
实际输入尺寸必须匹配请求档位。功能检查继续覆盖所有片段，性能未达标
会记录 `performancePassed: false` 并以非零状态退出，不能作为实时验证通过。
Android Chrome 的结果不代表应用 WebView、眼镜输出或 NPU 性能。
