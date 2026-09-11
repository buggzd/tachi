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
| 已采用的性能措施、采样方法和证据范围 | [性能维护](PERFORMANCE.md) |
| 已实现范围、待开发功能和待复核问题 | [功能路线图](JELLYFIN_FEATURE_ROADMAP.md) |
| 实时 3D 开发构建与统一实机调试 | [实时 SBS](REALTIME_SBS.md) |
| 版本号与 Git 标签约束 | [版本规则](VERSIONING.md) |
| 签名、发布和失败恢复 | [发布手册](RELEASE.md) |

## 历史与实测资料

| 资料 | 内容与用途 |
| --- | --- |
| [开发历史索引](archive/README.md) | Jellyfin Web 调研、SBS 早期设计、性能审阅和 UI 修改记录 |
| [2026-09-06 真机基准](performance/2026-09-06/README.md) | 主题、动画、播放与 Full-SBS 的初始对照 |
| [2026-09-07 真机复测](performance/2026-09-07/README.md) | 优化后的资源、帧轨迹、播放与恢复检查 |
| [实时 SBS 算法实验](../StereoLab/README.md) | 独立桌面和手机 Chrome 深度估计与双眼合成验证；手机 P0/P1 性能基线已记录，尚未接入 Android 产品 |
| [2026-09-09 SBS 桌面验证](performance/2026-09-09-stereo-lab/README.md) | 三段真实片源、两种推理尺寸的功能断言和匿名性能数据 |
| [2026-09-10 官方 QAIRT 实机验证](performance/2026-09-09-stereo-lab/qairt-device.md) | SM8850/V81 的纯 NPU 深度推理、输出校验与 SBS 并发测量边界 |
| [2026-09-10 QPM 与取帧实验](performance/2026-09-10-stereo-lab/frame-capture-and-qpm.md) | QPM 真实登录门槛，以及共享模型读回派生运动缩略图的前后对照 |
| [2026-09-10 实时 SBS 集成调试](performance/2026-09-10-realtime-sbs/README.md) | 实际 QNN、WebView 取帧和双眼输出跑通，约 8 fps 深度更新瓶颈与系统显示禁用问题 |
| [v0.3.0 发布说明](releases/v0.3.0.md) | 已发布版本的能力快照；其他版本见 [GitHub Releases](https://github.com/buggzd/tachi/releases) |
| [2026-09-11 实时 SBS 论文调研](archive/2026-09-11-realtime-sbs-research.md) | 视频深度时序、运动传播、保边上采样与取帧/绘制候选；未实机验证 |

历史中的“当前代码”“下一步”和测试数量只对应其日期与提交。实现范围以路线图及现行源码为准；测试通过不等于覆盖了架构文档的全部设备验收。

## 维护方式

- 功能合入后直接更新所属现行文档和路线图，移除已经完成的待办，避免重复追加一篇实现总结。
- 新的跨模块约束进入架构文档；操作步骤进入使用或开发指南；只在独立主题需要长期维护时新增文档。
- 有复现价值的调研、实验和实测按日期归档，注明代码基线、环境、结论和未覆盖范围。历史问题经复核仍存在时再进入路线图。
- 移动文件时更新正文链接、图片路径、章节锚点和 `AGENTS.md`。图片源文件与性能原始数据保留，不因文档归档而删除。
