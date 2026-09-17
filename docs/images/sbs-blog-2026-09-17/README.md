# 实时 SBS 博客插图

配套正文：[手机实时 2D 转 3D 折腾记录](../../archive/2026-09-17-realtime-sbs-blog.md)。

`01`–`05` 为原创原理示意，没有使用影视片源、账号截图或第三方项目运行截图，不代表算法真实输出或跨项目画质测评。可编辑 SVG 为源文件，PNG 为二倍尺寸导出，方便 Markdown 平台引用。

| 文件 | 内容 |
| --- | --- |
| `01-disocclusion.svg` / `.png` | 前景位移、新露出区域与隐藏颜色 |
| `02-methods.svg` / `.png` | 三个参考项目及 tachi 的实现区别 |
| `03-pairing.svg` / `.png` | 旧深度配新 RGB 与同帧提交 |
| `04-liquid.svg` / `.png` | 全局形变与背景局部液化的原理 |
| `05-pipeline.svg` / `.png` | 原生实时流水线、双槽与缓存 |

SVG 使用系统中文字体，可由支持中文字体的 SVG 渲染器导出 PNG。本次使用 sharp，输入 density 为 144；源图宽度 1200，导出宽度 2400。PNG 中已固化字形，发布平台不需要安装字体。正文采用相对图片路径；转载时一并上传 PNG，并按目标平台调整路径。

## 高动态实际案例

`06`–`15` 来自开发时 `StereoLab/mesh-trials.html` 的“高动态 · 30 秒”案例。按用户要求用于本篇技术说明，未包含完整视频、音轨、账号或服务器信息。“高动态”指运动，不是 HDR。素材版权归原权利人，这些截图不作为原创示意图授权。

| 文件 | 内容 |
| --- | --- |
| `06-motion-rgb-depth.png` | 第 579 帧原图与实际预计算深度 |
| `07-motion-cut.png` | 第 579 帧原图与断边网格，统一局部裁切 |
| `08-motion-contours.png` | 第 579 帧原图 / gather33 / 弹性网格 / 局部液化，同坐标裁切 |
| `09-motion-sbs.png` | 第 579 帧局部液化 SBS，保留 3840×1080 canvas 像素并在外侧加图注 |

`06`–`09` 统一采用 p4：392×224、逐帧 P2/P98、stride=1、delay=0、无历史融合和范围 EMA；合成强度 0.85，液化羽化 96 px、拉伸 65%。断边阈值 0.08，弹性网格 193 列。帧号从 0 开始，素材 30 fps。采集时视频帧和深度索引分别为 579/579（p4），页面无 JavaScript 错误。

它们是浏览器 WebGL 加预计算 float 深度的结果，不是 Android QNN 输出，也没有重新跑三个参考项目。未对图像做修复或增强；画面对比仅作同帧观察，不从截图推断时间稳定性。裁切图最近邻放大，原图/深度并排图等比缩小。

未修改的 canvas PNG 保存在 `motion-captures/`；[参数、裁切坐标和原图哈希](motion-captures.json)可用于追溯。`04-liquid.svg/png` 保留为原理图源素材，正文改用实际轮廓对照。

## 第 74 帧深度、第 576 帧历史融合、第 579 帧完整流程

`10-motion-profiles-delayed.png`（p0/p1/p2）和 `11-motion-profiles-aligned.png`（p3/p4）改用第 74 帧，每行按深度、gather33、liquid 排列。完整 1920×1080 画面缩为 640×360；深度最近邻缩放，RGB 使用 Lanczos。p0–p2 深度索引36，采样自第72帧；p3/p4 索引74。

`13-motion-history-control.png` 使用第576帧的p0/p1对照，仅像素历史开关不同；`14-motion-history-detail.png` 展示p2/p3/p4的组合档位。左列深度、右列液化左眼，统一裁切 `[535,370,1065,665]` 并最近邻放大两倍。p0–p2深度索引287，采样自574；p3/p4索引576。后者不是单变量实验，配对延迟与历史融合应分别解释。`15-motion-source-74-576.png` 提供两帧的全幅原始画面。

p0/p2/p3 有像素历史融合与范围 EMA；p1 无像素历史，但保留范围 EMA；p4 两项均关闭。合成强度0.85，液化96 px / 65%。原579档位截图保留在 `motion-captures/`，不再用于深度档位插图。

`12-motion-pipeline.png` 的六个阶段均使用第 579 帧：RGB、p4 归一化深度、左眼背景额外修正、实际 shader 诊断、左眼正常结果、SBS。`579-depth-p4-native.png` 保留 392×224 灰度输入；`579-left-correction.png` 是实际 `makeBackgroundLiquid` Float32 输出在 RG16F 上传前，减去基础视差并换算成每眼 1920 源宽像素后的可视化。色标固定 0–12 px，黑到橙，本帧最大约 10.5629 px；不是自动拉满对比度，也不是 shader 耗时或置信度图。

流程图中的深度与修正场采用最近邻展示，其余画面等比缩小；完整 SBS 不裁切、不改变宽高比。页面 debug 模式的绿色表示额外拉伸，紫色表示 gather 回退，并非真实遮挡恢复正确率。原始完整 canvas 和各档位参数继续记录在 `motion-captures/` 与 `motion-captures.json` 中。
