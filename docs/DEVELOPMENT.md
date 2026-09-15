# tachi（塔奇） 开发和构建指南

这份文档集中记录源码构建、前端调试、发布签名和验证流程。日常安装与使用见 [使用指南](USER_GUIDE.md)；修改会话、WebView 桥、播放、诊断、遥控或显示模式前，请先阅读 [Android 架构说明](ANDROID_ARCHITECTURE.md)。

## 技术基线

| 项目 | 当前配置 |
| --- | --- |
| Android Gradle Plugin / Gradle | 8.7.3 / 8.10.2 |
| Java | Java 11 源码，使用 JDK 17+ 构建 |
| Android SDK | compile SDK 35，build tools 34.0.0 |
| Android 兼容范围 | min SDK 26，target SDK 29 |
| Application ID | `com.jellyfinforrayneo.client` |
| ABI | `arm64-v8a` |
| 眼镜控制 | Android USB Host，Air 3s 显示模式报告 |
| 嵌入式前端 | React 19、Vite、TypeScript（眼镜端）与 `hls.js` |

`targetSdk 29` 保留已有侧载兼容基线，不满足当前 Google Play 的 target SDK 要求；本次显示控制改造未调整目标版本。

## 仓库结构

```text
AndroidApp/                         # 原生 Android Gradle application
└── app/
    ├── src/main/java/.../client/   # Activity、WebView、会话、显示与桥接
    ├── src/test/java/.../client/   # JVM 单元测试
    └── build/generated/webAssets/ # 两套 production bundle（不提交）
GlassesUI/                          # 眼镜 React/TypeScript 客户端与播放器
CompanionUI/                        # 手机 React 登录、设置与触控板
docs/                               # 现行指南、路线图、历史研究与实测
scripts/install-rayneo-sdk.sh       # 历史 SDK 分析辅助，不参与构建
scripts/build-android.sh            # 可复现构建入口
scripts/verify-android.sh           # 源码与 APK 边界检查
```

运行时是一个原生 Android 应用和两个本地 React/Vite 前端。生产 bundle 会生成到：

```text
AndroidApp/app/build/generated/webAssets/GlassesUI/
AndroidApp/app/build/generated/webAssets/CompanionUI/
```

这两个目录被 Git 忽略，由 Gradle 注册为 APK assets，运行时仍使用 `file:///android_asset/GlassesUI/` 和 `CompanionUI/`。只提交前端源码、`public/` 原始资源、构建配置与依赖锁文件，不提交压缩 JS/CSS、生成的 HTML 或复制的图片/音效。

## 环境准备

安装以下工具：

- JDK 17 或更高版本；
- Android SDK platform 35、build tools 34.0.0 和 platform-tools；
- Node.js 与 npm；
- Python 3（APK 前端资源校验）；
- `curl`、`unzip`、`zipinfo`、`rg`、`strings`；
- `md5` 或 `md5sum`，以及 `shasum` 或 `sha256sum`。

通过 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT` 指向 Android SDK。也可以创建被 Git 忽略的 `AndroidApp/local.properties`：

```properties
sdk.dir=/path/to/Android/sdk
```

如果想先单独安装依赖，可以运行：

```bash
npm --prefix GlassesUI ci
npm --prefix CompanionUI ci
```

当前构建不下载、不打包雷鸟 SDK，也不依赖 XR 空间。仅在复核历史协议分析时，可使用保留的 SDK 下载脚本；该分析辅助脚本校验归档 MD5：

```text
0ae0fb9de5dffae6cb0344535e20c454
```

脚本只安装 SHA-256 匹配以下值的 `ffalcon-sdk-client-1.0.3.aar`：

```text
505551d383db80d7852612e67f9158d4c67382304d22619c796abdc0365f15b6
```

如需重新下载并覆盖已存在的本地副本，运行：

```bash
./scripts/install-rayneo-sdk.sh --force
```

## 构建 Android 应用

日常 Debug 验证与构建：

```bash
./scripts/build-android.sh debug
```

其他范围：

```bash
./scripts/build-android.sh release
./scripts/build-android.sh all
```

构建脚本会依次：

1. 运行 APK 资源校验器回归测试，并对两个前端运行 `npm ci`；
2. 检查眼镜端 TypeScript 并运行两套前端回归测试；
3. 通过 Gradle 任务生成两套 production bundle（外层脚本不重复构建）；
4. 运行 JVM 测试和对应的 Android lint；
5. 组装所选 APK；
6. 校验 APK 的运行时依赖、前端入口、ARM64 ABI 和敏感信息隔离。

输出位置：

| 构建 | 输出 |
| --- | --- |
| Debug | `AndroidApp/app/build/outputs/apk/debug/app-debug.apk` |
| 未签名 Release | `AndroidApp/app/build/outputs/apk/release/app-release-unsigned.apk` |
| 已签名 Release | `AndroidApp/app/build/outputs/apk/release/app-release.apk` |

Debug 包自动添加 `.debug` application ID 后缀，可以与正式包并存。Release 保留正式 application ID；没有配置签名时只生成 unsigned APK。

Gradle 的 assets 任务依赖两套前端构建和入口校验，`preBuild` 也执行校验。源码、共享 UI、原始资源、依赖锁文件、Vite 配置或版本改变时会重建；输入和输出均未改变时复用产物。`clean` 会删除生成资源，下次构建自动恢复。直接从 Android Studio/Gradle 构建前，先为两套前端运行 `npm ci`。构建拒绝把开发用 Jellyfin 配置打入 APK。

`verify-android.sh` 会核对 APK 中两套前端的完整文件集合和字节内容与本地生成目录一致，检查入口引用，并拒绝重新跟踪旧的 production bundle。独立验证下载的旧 APK 时，可用 `--apk-only` 只检查入口引用和安全边界，不与当前源码产物比较。

## 前端开发

### 眼镜端

连接真实的开发 Jellyfin 服务器时：

```bash
cp .jellyfin-dev.example.json .jellyfin-dev.json
npm --prefix GlassesUI run dev
```

只在本机填写 `.jellyfin-dev.json`，然后打开 `http://127.0.0.1:4175/`。Vite 开发中间件会在运行时读取配置；production bundle 不会读取或包含该文件。

该配置包含开发服务器和账号信息，已被 Git 忽略。不要把配置内容、请求日志或未经明确授权的真实媒体截图提交到仓库。公开展示图必须先检查并隐去服务器地址、账号和凭据；当前 README 的《攻壳机动队》截图已经仓库所有者授权。

常用命令：

```bash
npm --prefix GlassesUI run check
npm --prefix GlassesUI test
npm --prefix GlassesUI run build
```

### 手机端

独立浏览器预览：

```bash
npm --prefix CompanionUI run dev
```

浏览器中没有 Android 原生桥，因此页面使用展示数据，只能验证视觉与普通交互，不能代表真机会话、诊断或硬件状态。

生成生产资源：

```bash
npm --prefix CompanionUI run build
```

修改 WebView 或跨端交互后，不能只依赖浏览器预览；必须重新生成两套前端资源并完成 Android 验证。

### 浏览器双端联调

需要同时观察手机和眼镜交互时，在仓库根目录运行：

```bash
./scripts/dev-dual-ui.sh
```

脚本会启动两套 Vite 开发服务器和 `http://127.0.0.1:4177/` 联调页，并自动在浏览器中打开。每次启动都会强制重新建立 Vite 依赖预构建缓存，并给联调页及两个 iframe 加入新的刷新标识，避免复用上一次运行的页面。左侧是具有可选 CSS 视口尺寸的 CompanionUI，右侧是按 1920 × 1080 渲染后等比缩放的 GlassesUI。两个 iframe 均保留自己的真实响应式布局与热更新，不是截图或重新实现的测试 UI。

联调桥只在 Vite DEV、指定 iframe 角色和本机父页面来源同时满足时安装。它模拟 Android 层的有限职责：

- 手机登录后把内存会话发布给眼镜端；
- 眼镜运行与播放状态回写手机端；
- 手机触控板的方向、确认和返回指令控制眼镜焦点；
- 显示模式、重试、退出登录和未授权清理在两端同步；
- 密码只经过本机联调服务转发，Token 只保存在当前联调页内存中。

若仓库根目录存在被 Git 忽略的 `.jellyfin-dev.json`，联调页启动后会自动建立开发会话。在 Git linked worktree 中启动时，脚本会自动复用主工作区里的这份本地配置，因此不需要为每个 worktree 复制凭据。也可以通过 `RAYNEO_JELLYFIN_DEV_CONFIG=/absolute/path/to/config.json` 显式选择另一份本地配置。该文件不会被复制到 worktree、写入浏览器存储或纳入 Git。

点击“清除会话”会移除当前账号，两端停止使用该登录；其他已登录账号仍可从手机端列表选择。点击“读取开发会话”可重新使用本地配置。联调页支持多服务器、多账号的切换与移除，账号仅保留在当前页面内存中；重新加载整个联调页会清除该列表。添加失败或取消时保留当前连接。联调服务只监听 `127.0.0.1`，校验 API 来源、限制消息与响应大小，并且不会打印凭据、Token 或服务器响应。

只想启动服务而不自动打开浏览器时：

```bash
RAYNEO_DUAL_UI_NO_OPEN=1 ./scripts/dev-dual-ui.sh
```

联调会话回归测试：

```bash
node --test DevHarness/*.test.mjs
```

这套页面用于快速联调 WebView 消息和响应式 UI，不能模拟眼镜 USB、外接 Display、MediaCodec 或 Android WebView 的设备差异；上述部分仍需执行真机回归矩阵。

## Release 签名与旧版本升级

版本号与 Git 标签约束见 [版本与发布规则](VERSIONING.md)，正式发布操作和验收清单见 [Release 发布手册](RELEASE.md)。

在本机创建被 Git 忽略的 `AndroidApp/keystore.properties`：

```properties
storeFile=release.jks
storePassword=<local-only>
keyAlias=<local-only>
keyPassword=<local-only>
```

`storeFile` 相对 `AndroidApp/` 解析，也可以使用绝对路径。keystore 和属性文件都不得提交。正式发布应使用长期保存的自有签名，并在每次发布时提升 `versionCode`。

原位升级需保持正式 application ID `com.jellyfinforrayneo.client` 和已安装版本的签名证书，才能保留 `jellyfin_companion` 私有会话。证书不一致时，应先导出必要的非敏感配置，再卸载旧包。

不要为了分发方便而使用 Debug 证书签署正式包。

## 验证

### 推荐入口

```bash
./scripts/build-android.sh debug
```

这条命令覆盖前端检查、两套 production bundle、JVM 测试、Debug lint、APK 组装和 APK 边界检查。

搜索基准、已采用的优化和实测依据见 [性能维护](PERFORMANCE.md)；其他入口见 [文档导航](README.md)。

前端相关变更还应明确运行：

```bash
npm --prefix GlassesUI run check
npm --prefix GlassesUI run build
npm --prefix CompanionUI run build
```

需要直接运行 Gradle 时（命令仍从仓库根目录执行）：

```bash
./AndroidApp/gradlew -p AndroidApp \
  :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
./AndroidApp/gradlew -p AndroidApp \
  :app:lintRelease :app:assembleRelease
```

检查指定 APK：

```bash
./scripts/verify-android.sh \
  AndroidApp/app/build/outputs/apk/debug/app-debug.apk
```

这个检查会校验源码和 APK 的运行时依赖边界、单个眼镜 WebView 与两个前端入口，并排除开发配置、私网 IPv4、签名材料及非 ARM64 原生库。

JVM 测试覆盖会话白名单与清理、IPv6 URL 规范化、消息边界、URL 导航、遥控队列、Display 选择、显示模式转换和固定容量诊断事件。设备侧变更还必须执行 [Android 架构说明中的真机回归矩阵](ANDROID_ARCHITECTURE.md#device-regression-matrix)。

### ASS 字幕回归

`GlassesUI` 按需加载 `libass-wasm` 4.1.0 的 worker/WASM 与思源黑体。
这些资源由 Vite 打包到 APK，字体来源、校验值及许可证见
[第三方声明](../THIRD_PARTY_NOTICES.md#source-han-sans-思源黑体)。
更换 renderer 或字体后须重新构建，不能只更新前端 JS。

启动 GlassesUI 开发服务器后，打开 `/tests/ass-renderer.html`：

- Load ASS 使用合成的 `ass-features.ass`，不需要测试账号；1/3/5/10 秒覆盖定位、
  描边、图层、移动、淡入淡出、变换、卡拉 OK、矢量绘图与裁切。
- Play / pause video clock 使用单个 12 秒合成视频检查时间同步、暂停与黑边几何；
  Turn off 应清空透明画布，并终止 worker、取消回调及释放 blob。
- Subtitle URL / Time 可检查另一个本地样本。真实媒体字幕及附件只能保存在被忽略的
  本地目录，不得提交；不要在 URL、截图或日志中暴露测试账号、Token 或服务器地址。

合成视频可用 FFmpeg 重建：`color=c=0x162030:s=640x360:r=24:d=12`，
H.264、yuv420p、无音频、MP4 faststart。测试 HTML 和 fixtures 不作为 production 入口。
`assVideo.test.mjs` 覆盖续播、帧时间戳、暂停、seek、隐藏页面和销毁；
`assRenderer.test.mjs` 覆盖 file 资源、取消、限制、失败和 blob/worker 清理。
设备验收还必须覆盖 APK 内 file 资源、附带/缺失字体、HLS/直放与 2D/SBS 的同帧显示。

## 真机调试

查看 Android 显示拓扑：

```bash
adb shell dumpsys display | rg 'DisplayDeviceInfo|displayId|FLAG_PRESENTATION'
```

如果设备与 scrcpy 支持外接屏捕获：

```bash
scrcpy --list-displays
scrcpy --display-id=0 --window-title="Phone"
scrcpy --display-id=<external-display-id> --window-title="RayNeo Air"
```

Debug 包开启 WebView 调试。日志只应筛选通用 Activity、WebView、眼镜 USB 和 MediaCodec 状态；禁止打印会话 JSON、Token、密码、完整服务器地址或响应正文。

验证播放能力时，Activity/WebView 的硬件加速只说明合成路径可用，不代表 Chromium 一定选择硬件视频解码器。代表性媒体必须在真机上确认实际使用的 `MediaCodec` 组件。

## 仓库卫生

以下内容不得提交：

- 凭据、Token、Quick Connect 代码或真实账号；
- 局域网地址和 `.jellyfin-dev.json`；
- RayNeo SDK 二进制、APK、AAB；
- keystore、签名属性和私钥；
- `local.properties`、绝对 SDK 路径；
- `node_modules`、Gradle/Android 构建输出或 IDE 状态。

保留无关的工作区修改，只提交源码与原始资源，使用聚焦的 Conventional Commit。

### 分支合并与工作区清理

新分支只合并源码、配置和锁文件，然后运行完整构建；生成目录不会参与 Git 合并。旧分支仍可能携带 `app/src/main/assets/{GlassesUI,CompanionUI}` 的历史产物，首次合入时移除这两个旧目录的生成文件，再从合并后的源码构建。不要选择某一分支的压缩包代替重建。

功能完成并合入 `main` 后，检查对应 worktree 的未提交/未跟踪文件，以及被忽略的本地配置；确认无需保留后，先用 `git worktree remove <path>` 移除工作目录，再用 `git branch -d <branch>` 删除本地分支。远端旧分支也应确认已合入并无人继续使用后删除。保留有未提交工作、凭据或独立本地资料的目录，不使用强制删除。

### 连接页原生桥回归

`npm --prefix CompanionUI run test:browser` 使用 Playwright 和本机 Chrome 启动独立 Vite
测试服务，模拟空账号与已有账号的原生状态。覆盖两种主题、手动地址弹窗、状态更新、
紧凑视口、提交和关闭，捕获 React 渲染错误，不访问真实服务器或设备。


### 播放进度交互回归

`node CompanionUI/scripts/verify-seek.mjs` 启动两端真实 React 界面的无服务器浏览器回归，使用模拟原生播放事件，覆盖两种主题、唯一焦点、短滑十秒、拖动预览及反向修正、完整进度条、取消／多指／切集／过期，以及松手仅提交一次并保留播放／暂停状态。浏览器预览入口为 GlassesUI 的 `/tests/player-preview.html`，需测试脚本提供模拟原生桥接。此检查不替代真机 Direct/HLS、2D/SBS 的手感和播放恢复验证。


### 海报比例回归

`node CompanionUI/scripts/verify-covers.mjs` 使用真实卡片组件验证两种主题下的竖版合集、横版、方形、横幅与缺失元数据条目的统一比例。无服务器预览入口为 GlassesUI 的 `/tests/cards-preview.html`。布局共用 `getCardShape`，数据来自 `PrimaryImageAspectRatio`；自动比例使用 Jellyfin Web 的中位数和标准比例归一规则，不能以视频分辨率或 Folder／BoxSet 类型替代。

`node CompanionUI/scripts/verify-focus-recovery.mjs` 验证禁用／隐藏／inert 默认焦点的四向恢复、详情操作导航、返回按钮确认，以及异步失去播放能力后的焦点恢复。
