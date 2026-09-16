<p align="center">
  <img src="artwork/app-icon/tachi-icon-rounded.png" width="128" height="128" alt="tachi（塔奇）应用图标">
</p>

<h1 align="center">tachi（塔奇）</h1>

<p align="center"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

> 面向 RayNeo Air 系列眼镜的第三方 Jellyfin 客户端：手机负责连接与遥控，眼镜负责浏览与播放，一个应用提供 2D 镜像和 SBS 立体虚拟屏幕。

tachi（塔奇）的名字源自《攻壳机动队》的塔奇克马（TaChikoma）。

本项目不是 Jellyfin 或 RayNeo 的官方产品，与这些公司不存在隶属或背书关系。

[产品演示](#产品演示) · [快速开始](#快速开始) · [核心能力](#核心能力) · [当前边界](#当前边界) · [文档](#文档)

## 产品演示

90 秒体验 tachi：手机就是遥控器，眼镜负责浏览与播放。

https://github.com/user-attachments/assets/5dd75ead-3682-4bb2-9181-6368b4049c73

<p align="center">
  <img src="docs/images/dual-screen-showcase.png" width="96%" alt="tachi（塔奇）双端界面：眼镜端攻壳机动队剧集详情与手机伴侣端，等高并排展示">
</p>

<p align="center"><sub>眼镜端与手机端使用演示</sub></p>

## 快速开始

你需要一台可访问的 Jellyfin 服务器、RayNeo Air 系列眼镜及配套 Android 手机。源码构建还需要 JDK 17+、Node.js/npm、Python 3，以及 Android SDK platform 35 和 build tools 34.0.0。

1. 从 [GitHub Releases](https://github.com/buggzd/tachi/releases) 下载正式签名的 ARM64 APK。GitHub Actions 构建 Lite，维护者本地构建并验收后补充 Full；以实际 Release 附件为准。两版分别为 Lite（原生 2D／平面 SBS）与 Full（另含实时深度模型及 QNN，当前验证 SM8850/V81），详见 [构建说明](docs/REALTIME_SBS.md)。需要自行构建 Debug APK 时：

   ```bash
   git clone https://github.com/buggzd/tachi.git
   cd tachi
   ./scripts/build-android.sh debug
   ```

2. 将 APK 安装到配套手机：

   ```bash
   adb install -r /path/to/downloaded.apk
   ```

   自行构建时可将路径替换为 `AndroidApp/app/build/outputs/apk/debug/app-debug.apk`。没有 ADB 时，也可以把该 APK 发送到手机并通过文件管理器安装。

3. 接入眼镜并启动应用，在手机端选择 Jellyfin 服务器、完成登录，然后进入触控板控制眼镜界面。

首次构建会安装两套前端依赖并完成测试；当前应用通过 Android USB 直接控制眼镜，无需雷鸟 SDK 或 XR 空间应用。环境配置、侧载说明和常见问题见 [使用指南](docs/USER_GUIDE.md) 与 [开发和构建指南](docs/DEVELOPMENT.md)。

## 核心能力

- **服务器与账号管理**：保存多个服务器和同一服务器下的多个账号，切换时复用登录状态；添加失败或取消时保留当前连接。
- **手机连接，眼镜观看**：手机端完成局域网发现、手动连接、Quick Connect、密码登录、设置与触控遥控；眼镜端专注媒体浏览和播放。
- **覆盖常用 Jellyfin 浏览流程**：支持首页内容流、媒体库、搜索、筛选、文件夹与剧集浏览，以及电影、剧集、季和单集详情。
- **同步你的观看状态**：支持继续观看、下一集、收藏、看过状态和播放进度回传。
- **兼顾直放与兼容性**：优先使用原生 Media3 硬件解码直放，不兼容时回退到 Jellyfin 的 H.264/AAC HLS；支持音轨、文字字幕和服务端烧录字幕。
- **两种眼镜显示方式**：可在 Mirror 2D 与 SBS 虚拟银幕之间切换；银幕支持四档靠近程度和独立大小调节，并保持单路视频、声音和播放上报。
- **无需 ADB 也能排查问题**：手机端显示连接阶段和安全诊断，可分享经过脱敏的诊断报告。
- **中英文界面**：默认跟随系统，也可在手机连接页或两端设置中选择简体中文 / English，自动保存并同步。
- **观看偏好**：手机与眼镜设置都能切换液态玻璃（liquid-glass）／simpleUI 和四档字幕大小，自动保存、两端同步；播放器沿用设置中选择的文字字号。

<p align="center"><img src="docs/images/glasses-episodes.png" width="96%" alt="tachi 眼镜端《攻壳机动队》分集浏览"></p>

## 工作方式

| 手机端 Companion | 眼镜端 Glasses |
| --- | --- |
| 发现服务器、登录、设置、诊断 | 浏览媒体库、查看详情、播放视频 |
| 触控板移动焦点、确认、返回 | 显示唯一空间焦点并接收遥控 |
| 选择 2D/3D 显示模式 | 输出 Mirror 2D 或 SBS 立体画面 |

应用运行时会话、显示模式和两端消息由原生 Android 层统一管理，具体设计见 [Android 架构说明](docs/ANDROID_ARCHITECTURE.md)。

## 当前边界

这是一个面向 RayNeo Air 配套设备侧载的可运行 MVP，目前请注意：

- GitHub Releases 仅提供 ARM64 Android 包，运行时需要 Android System WebView。
- `targetSdk 29` 保留已有侧载兼容基线，不满足当前 Google Play 的上架要求。
- Air 3s 使用独立 USB 控制；HyperOS 连接眼镜后需要手动开启系统「屏幕镜像」，模式切换后可能需再次开启，详见 [显示模式说明](docs/USER_GUIDE.md#眼镜显示模式)。
- 尚未实现离线下载和播放列表编辑。
- 不兼容的媒体依赖 Jellyfin 服务端转码，本项目的原生主播放器不附带通用软件视频解码器。
- UDP 自动发现基于 IPv4；IPv6 服务器需要手动填写域名或规范的 IPv6 地址。

完整限制、IPv6 写法和故障处理见 [使用指南](docs/USER_GUIDE.md)。后续计划见 [功能路线图](docs/JELLYFIN_FEATURE_ROADMAP.md)。

## 文档

| 你想了解 | 文档 |
| --- | --- |
| 安装、连接、遥控、播放与常见问题 | [使用指南](docs/USER_GUIDE.md) |
| 环境、构建、测试与分支维护 | [开发指南](docs/DEVELOPMENT.md) |
| 会话、WebView、显示与播放架构 | [Android 架构](docs/ANDROID_ARCHITECTURE.md) |
| 已实现范围与后续工作 | [功能路线图](docs/JELLYFIN_FEATURE_ROADMAP.md) |
| 版本、签名与发布 | [版本规则](docs/VERSIONING.md) · [发布手册](docs/RELEASE.md) |
| 界面、SBS 几何、性能及历史资料 | [完整文档导航](docs/README.md) |
| 中英文界面与词条维护 | [i18n 说明](docs/I18N.md) |

文档导航区分现行维护说明、历史研究和真机实测；早期设计中的待办不代表当前功能缺口。

## 贡献

欢迎提交 Issue 和 PR。开始修改前请阅读 [开发和构建指南](docs/DEVELOPMENT.md)；涉及会话、桥接、播放、诊断、遥控或显示模式时，还需要阅读 [Android 架构说明](docs/ANDROID_ARCHITECTURE.md)。

提交 PR 前至少运行：

```bash
./scripts/build-android.sh debug
```

请使用聚焦的 Conventional Commit，并避免提交凭据、局域网地址、SDK 二进制、APK、签名文件或本机路径。

## 许可证与第三方声明

本项目采用 [MIT License](LICENSE)，版权所有 © 2026 buggzd。

Jellyfin 名称和商标归其权利人所有；RayNeo 开发文档及硬件相关标识归其权利人所有。依赖与许可证信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

[Jellyfin 文档](https://jellyfin.org/docs/) · [Jellyfin OpenAPI](https://api.jellyfin.org/) · [RayNeo Air 开发文档](https://rayneo.gitbook.io/rayneo-devdoc/)
