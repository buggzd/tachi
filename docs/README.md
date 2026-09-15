# tachi 文档导航

日常使用、开发和后续规划从下表进入。现行文档描述已经实现的行为；带日期的研究、改动记录和实测数据保留为历史依据。

中英文界面与词条维护见 [i18n 说明](I18N.md)。

## 现行文档

| 需要了解 | 入口 |
| --- | --- |
| 安装、连接、遥控、播放与常见问题 | [使用指南](USER_GUIDE.md) |
| 环境、前端联调、构建、验证和分支清理 | [开发指南](DEVELOPMENT.md) |
| 会话、桥接、显示状态、播放约束和设备回归矩阵 | [Android 架构](ANDROID_ARCHITECTURE.md) |
| 主题、壁纸、焦点反馈、教学、时钟和音效 | [界面与交互](UI_GUIDE.md) |
| SBS 视差、坐标单位、USB 控制和光学边界 | [虚拟银幕几何](SBS_GEOMETRY.md) |
| 原生播放迁移与独立解码调试入口 | [原生视频](NATIVE_VIDEO.md) |
| 已采用的性能措施、采样方法和证据范围 | [性能维护](PERFORMANCE.md) |
| 已实现范围、待开发功能和待复核问题 | [功能路线图](JELLYFIN_FEATURE_ROADMAP.md) |
| 已确定的 392 同帧 GPU 局部液化、参数与后续顺序 | [SBS 技术路线总览](SBS_TECHNICAL_ROUTES.md) |
| 主路线构建、发布配置边界与剩余设备验收 | [实时 SBS](REALTIME_SBS.md) |
| 版本号与 Git 标签约束 | [版本规则](VERSIONING.md) |
| 签名、发布和失败恢复 | [发布手册](RELEASE.md) |

主技术路线已由用户确认；文档决策不等于修改发布默认值或补齐设备验收。旧路线比较与旧构建说明已转入[归档索引](archive/README.md)，有日期的实测数据保持原路径。

## 历史与实测资料

| 资料 | 内容与用途 |
| --- | --- |
| [开发历史索引](archive/README.md) | Jellyfin Web 调研、SBS 早期设计、性能审阅和 UI 修改记录 |
| [2026-09-06 真机基准](performance/2026-09-06/README.md) | 主题、动画、播放与 Full-SBS 的初始对照 |
| [2026-09-07 真机复测](performance/2026-09-07/README.md) | 优化后的资源、帧轨迹、播放与恢复检查 |
| [实时 SBS 算法实验](../StereoLab/README.md) | 独立桌面和手机 Chrome 深度估计与双眼合成验证；手机 P0/P1 性能基线已记录，历史基线，当前产品路径见实时 SBS |
| [2026-09-09 SBS 桌面验证](performance/2026-09-09-stereo-lab/README.md) | 三段真实片源、两种推理尺寸的功能断言和匿名性能数据 |
| [2026-09-10 官方 QAIRT 实机验证](performance/2026-09-09-stereo-lab/qairt-device.md) | SM8850/V81 的纯 NPU 深度推理、输出校验与 SBS 并发测量边界 |
| [2026-09-10 QPM 与取帧实验](performance/2026-09-10-stereo-lab/frame-capture-and-qpm.md) | QPM 真实登录门槛，以及共享模型读回派生运动缩略图的前后对照 |
| [2026-09-10 实时 SBS 集成调试](performance/2026-09-10-realtime-sbs/README.md) | 实际 QNN、WebView 取帧和双眼输出跑通，约 8 fps 深度更新瓶颈与系统显示禁用问题 |
| [2026-09-11 桌面优化实验](performance/2026-09-11-desktop-optimization/README.md) | 时间平滑、DIS、保边、逆投影、异步读回及 M4 CoreML 对照；未操作手机 |
| [2026-09-12 原生播放实机调试](performance/2026-09-12-native-video/README.md) | Media3 硬解、GLES/PBO 取帧、固定采样节拍与错误恢复；尚未接入 NPU/深度合成 |
| [2026-09-12 原生 QNN SBS 全链路](performance/2026-09-12-native-qnn-sbs/README.md) | 纯 QNN 深度、每眼 1080p GLES 合成、GPU 计时、慢帧保持及旧结果丢弃 |
| [MyGO 新版诊断与画质回传](performance/2026-09-12-user-diagnostics/mygo-followup.md) | 原生 HLS 大小写校验缺陷、重复字幕解析与鬼影证据 |
| [SBS 匿名评分与 392 深度试验](performance/2026-09-12-quality-trials/README.md) | 新诊断、可评分对照页、实际高分辨率模型与测试 APK；392 尚未实机验证 |
| [2026-09-13 实机分辨率扫描](performance/2026-09-13-resolution-sweep/README.md) | 322–770 的共享原生管线测试、QNN 编译内存边界，以及非调试构建/ART 预编译对照 |
| [2026-09-13 GPU 深度稳定](performance/2026-09-13-gpu-stabilization/README.md) | 精确分位数与历史融合的 compute 实现、颜色快照配对、CPU/GPU 数值检查及实机并发对照 |
| [2026-09-13 日常双档与完整模型共享缓冲](performance/2026-09-13-daily-sbs/README.md) | 518 的 20 分 39 秒产品连续窗口、392 顺序对照、PTS/呈现/缓冲边界与完整模型 GPU/HTP 共享验证 |
| [2026-09-13 GPU 输入与双捕获流水线](performance/2026-09-13-gpu-input-pipeline/README.md) | CHW 数值对照、12/24 Hz 实测、原生 QNN 与 GPU 共享缓冲最小图验证 |
| [2026-09-15 液化修订版复测](performance/2026-09-15-native-liquid-retest/README.md) | 短测 21.38 Hz，原片解码及正式播放器恢复阻塞，未完成长时/同步验收 |
| [2026-09-14 液化实机后续修订](performance/2026-09-14-native-liquid-followup/README.md) | 显示暂停修订、合成缓存、完成计时、字幕时钟与本地测试入口；复测部分通过 |
| [2026-09-14 原生同帧 GPU 液化](performance/2026-09-14-native-liquid/README.md) | 392 / 0.85 / 96 px / 65% 原生实验、成对视频缓冲和桌面 shader 数值验证；见 [实机报告](performance/2026-09-14-native-liquid-device/README.md) |
| [2026-09-14 完整 Quality 与时序补洞](performance/2026-09-14-quality-temporal/README.md) | 隔离复用完整参考渲染核心、前后帧背景实验与网页同帧对照；非手机性能测量 |
| [SBS 伪影量化与首轮优化](performance/2026-09-12-artifact-evaluation/README.md) | 论文指标、真实 Java 消融、真值合成/真实片段代理量与已知退化；未实机验收 |
| [2026-09-14 iw3 与连续扭曲](archive/2026-09-14-iw3-warp.md) | RowFlowV3 反向采样源码阅读与无补洞弹性网格的区别；未运行 iw3 |
| [DLSS / FSR 时序重建研究](archive/2026-09-12-dlss-fsr-sbs.md) | 最新公开集成资料、历史裁剪及 SBS 迁移边界 |
| [2026-09-12 用户诊断与双包测量](performance/2026-09-12-user-diagnostics/README.md) | 成功播放样本的证据边界、失败记录缺失及 Lite/Full 包体实测 |
| [v0.3.0 发布说明](releases/v0.3.0.md) | 已发布版本的能力快照；其他版本见 [GitHub Releases](https://github.com/buggzd/tachi/releases) |
| [2026-09-11 实时 SBS 论文调研](archive/2026-09-11-realtime-sbs-research.md) | 视频深度时序、运动传播、保边上采样与取帧/绘制候选；未实机验证 |

历史中的“当前代码”“下一步”和测试数量只对应其日期与提交。实现范围以路线图及现行源码为准；测试通过不等于覆盖了架构文档的全部设备验收。

## 维护方式

- 功能合入后直接更新所属现行文档和路线图，移除已经完成的待办，避免重复追加一篇实现总结。
- 新的跨模块约束进入架构文档；操作步骤进入使用或开发指南；只在独立主题需要长期维护时新增文档。
- 有复现价值的调研、实验和实测按日期归档，注明代码基线、环境、结论和未覆盖范围。历史问题经复核仍存在时再进入路线图。
- 移动文件时更新正文链接、图片路径、章节锚点和 `AGENTS.md`。图片源文件与性能原始数据保留，不因文档归档而删除。

原生播放器产品接入与用户回传清单：[2026-09-12 验收记录](performance/2026-09-12-native-product/README.md)。
