# 性能维护与实测依据

本页记录当前已采用的性能措施和复测方法。数值报告按日期保留；未完成工作集中在 [功能路线图](JELLYFIN_FEATURE_ROADMAP.md)，不从旧报告直接复制待办。

## 已采用的措施

| 区域 | 现行行为 | 维护约束 |
| --- | --- | --- |
| HLS 加载 | 播放器按需动态加载 `hls.js`，浏览和直放不解析整个 HLS 库 | 离开播放器或换轨后，过期加载不能挂载媒体源；保留硬件能力筛选及 H.264/AAC 回退 |
| Series 搜索 | 分段构建拼音索引、可取消，按媒体对象复用索引；一次查询只规范化一次 | 不跨会话按 ID 复用旧数据；保留中文、拼音、别名、季集提示和排序结果 |
| 焦点与卡片 | 单次方向输入复用元素几何，未变化媒体卡跳过重复渲染 | 下一次输入重新测量；收藏、进度、滚动和焦点恢复仍正确 |
| 隐藏装饰 | 音柱和手机触控提示在淡出结束后暂停，显示时恢复 | 不截断可见退出效果；快速显示/隐藏、暂停视频和旧 WebView 均需兼容 |
| SBS 绘制 | WebView 内容失效驱动两眼绘制，静态内容不依赖无条件 vsync 循环 | 视频、字幕、滚动和参数动画仍同步更新；保持一个 WebView、视频和音频流 |
| WebView 图层 | 手机和 Mirror 2D 不强制整 View 图层，已应用 SBS 保留一个硬件纹理 | `LAYER_TYPE_NONE` 不等于软件渲染；不得引入 CPU 视频帧读回 |
| 主题 | simpleUI 移除高开销装饰，Liquid 保留其可见视觉效果 | 不通过降低视频刷新率、清晰度或缩短 HLS 缓冲来替代 UI 优化 |

实现入口：`GlassesUI/src/seriesSearch.ts`、`GlassesUI/src/App.tsx`、`SharedUI/hiddenAnimations.mjs` 和 `GlassesWebViewController`。具体显示不变量见 [Android 架构](ANDROID_ARCHITECTURE.md#single-webview-stereo-rendering)。

## 如何使用已有报告

| 资料 | 能支持的结论 | 不能据此承诺 |
| --- | --- | --- |
| [9 月 5 日桌面审阅](archive/2026-09-05-performance-review.md) | 合成搜索基准、HLS 懒加载与该版浏览器视觉对照 | Android 真机帧率、功耗或当前包体积 |
| [9 月 6 日真机基准](performance/2026-09-06/README.md) | 当时主题、动画、2D/SBS 和代表性视频的资源差异 | 其中所有优化建议仍未实现，或静态 SBS 仍保持当时开销 |
| [9 月 7 日优化复测](performance/2026-09-07/README.md) | 被测版本的静态 SBS 冗余绘制和呈现排队减少；部分播放场景资源下降 | Liquid 首页已经大幅降耗、全部 4K60 丢帧已修复或跨设备节电比例 |
| [模糊实现核验](performance/2026-09-07/blur-audit.md) | 固定 WebView 版本的模糊实现链及采样证据 | 任意 WebView/设备上的统一性能表现 |

9 月 6 日建议中的“暂停不可见装饰”和“静态 SBS 按需绘制”已实施。将 Liquid 可见循环改为有限次的建议未采用，当前保留视觉效果。4K60 剩余丢帧、长时热态与非充电功耗仍需独立评估。

历史静态窗口可能没有持续时钟等后续 UI 更新，不能要求新版本完全复现“0 绘制帧”。判断是否出现冗余循环，应同时记录页面内容、更新频率和采样窗口。

## 复测方法

搜索使用合成数据，不读取开发凭据：

```bash
npm --prefix GlassesUI test
npm --prefix GlassesUI run benchmark
```

真机资源采样使用 [现有采样器](../scripts/measure-device-performance.mjs)，条件和 FrameTimeline 配置见 [9 月 7 日报告](performance/2026-09-07/README.md#复现)。比较时固定设备、WebView、视频片段、播放位置、主题、显示模式和预热条件，交叉运行至少三轮并记录温度与电源状态。

CPU、整机 GPU 忙碌率、HWUI 绘制、视频丢帧和实际呈现时间分别解释；不把任一指标直接换算成电池续航或触控到光子的延迟。静态采样不加入持续 rAF 探针。保留所有有效样本和未覆盖范围。

性能优化仍需 [构建检查](DEVELOPMENT.md#验证) 与 [设备回归](ANDROID_ARCHITECTURE.md#device-regression-matrix)。字幕交付异常、renderer 崩溃后的停止上报等历史发现单独列在路线图的待复核项中，不能用资源指标改善代替正确性验收。

## 实时 3D 当前基线

后续围绕[392 严格同帧 GPU 局部液化](SBS_TECHNICAL_ROUTES.md)优化。GPU 已承担输入预处理、逐帧范围归一化与液化；产品主机输入读回和输出交接仍存在。合成缓存减少重复配对帧的绘制成本，不能把缓存刷新计为新视频帧。

[修订版短测](performance/2026-09-15-native-liquid-retest/README.md)为 119.604 秒、21.38 Hz，未完成长时及同步验收；与旧 18.9 Hz 测试不同素材/热态，不计算提升比例。接下来先解决恢复与同步、完成 20–30 分钟同配置测量，再评估注册共享缓冲的端到端收益。

正在验证的实现见[24 Hz 采样诊断与液化邻域复用](performance/2026-09-15-liquid-24hz/README.md)：共享 tile 保持原公式，桌面数值通过，实机收益尚待测量。
