# Release 发布手册

本文档是正式版本的操作清单。版本号和标签的强制规则见[版本与发布规则](VERSIONING.md)，构建环境见[开发和构建指南](DEVELOPMENT.md)。

## 正式发布身份

- 项目名称：`tachi`（塔奇）；GitHub 仓库：[`buggzd/tachi`](https://github.com/buggzd/tachi)
- Android application ID：`com.jellyfinforrayneo.client`
- 首个正式版本：`v0.2.0`，`versionCode=2`
- 正式签名证书 SHA-256：`71:28:B1:AE:A0:7F:26:9F:15:40:2B:9C:DC:4D:5D:D6:80:5D:79:AC:C1:EF:E6:B7:F9:85:FD:2C:AF:AC:C4:75`

证书指纹和 alias 不是秘密，可以用于核对发布身份。keystore、私钥和密码必须保密；后续 APK 必须继续使用同一私钥，才能覆盖升级 `v0.2.0` 及之后的安装。

改名保留原 application ID、签名证书与持久化键名，现有用户可继续覆盖升级。后续发布附件使用 `tachi-<versionName>-{lite,full}-arm64-v8a.apk`；已发布的旧版标签和附件保持原样。

## 发布前准备

1. 确认长期 keystore 在仓库外至少有两份受保护的备份，并另外保存 alias、keystore 密码和私钥密码。
2. 确认仓库的 GitHub Actions Secrets 已配置：
   - `ANDROID_KEYSTORE_BASE64`
   - `ANDROID_KEYSTORE_PASSWORD`
   - `ANDROID_KEY_ALIAS`
   - `ANDROID_KEY_PASSWORD`
   - `REALTIME_SBS_BUNDLE_URL`（见下节；两个版本全部通过才发布）
3. 使用 JDK 17+、Node.js 和 Android platform 35/build tools 34.0.0。
4. 确认 `main` 已同步，且没有混入与本次发布无关的修改。

GitHub Secrets 是只写的 CI 配置，不是可下载的备份。不要仅依赖 GitHub 保存签名材料。

## 实时深度构建输入

GitHub runner 没有开发机的 `.local/npu`。发布 Full 前，需要从已经验证的本地依赖生成 CI 输入包：

```bash
python3 scripts/realtime-sbs-bundle.py pack StereoLab/.local/tachi-realtime-sbs-ci.zip
```

脚本只收集 `AndroidApp/realtime-sbs-runtime.json` 固定的模型、ORT AAR 和九个厂商库，逐个核对 SHA-256，
不会打包整个 SDK、账号文件或编译缓存。将此 ZIP 放到你管理的、CI 可访问的 HTTPS 存储，
把下载 URL 配置为仓库 Secret `REALTIME_SBS_BUNDLE_URL`。URL 可携带限时访问授权，应保证发布时未过期；
不能将 URL 或 ZIP 提交 Git。模型/SDK 的分发须遵循各自许可，输入包不是公开的 Release 附件。

工作流下载后先验证文件清单、大小和每个文件哈希，再安装到忽略目录。构建脚本会重建选定的 APK 容器，
包校验还会拒绝超过 8 MiB 的 ZIP 开销，防止增量打包残留的无引用数据使 Lite 膨胀。缺失 Secret、过期链接、
多余文件或哈希不匹配都会中止发布，不会只发布一半。换模型或 SDK 时，先完成设备验证，再更新清单和输入包。
本地可验证输入包：

```bash
python3 scripts/realtime-sbs-bundle.py install StereoLab/.local/tachi-realtime-sbs-ci.zip
```

Lite 不带模型及 QNN/ORT，但仍使用原生视频播放器，支持 2D 与平面 SBS；Full 增加实时深度转换，
当前验证设备为 SM8850/V81。Lite 没有在线模型安装功能，需要实时 3D 时覆盖安装 Full。
两版同版本号、应用 ID 与正式签名，保留设置，不能并排安装。已有旧版本 Release 附件保持原样。

## 更新版本

先编辑根目录的 `version.properties`：

```properties
versionName=<SemVer>
versionCode=<严格递增的正整数>
```

再同步两套前端元数据并校验：

```bash
npm --prefix CompanionUI version <versionName> --no-git-tag-version
npm --prefix GlassesUI version <versionName> --no-git-tag-version
./scripts/verify-version.sh
```

已经分发过的 `versionCode` 和版本标签不得复用。修复已发布版本时提升 PATCH 和 `versionCode`，不要替换原 Release 附件。

## 检查敏感文件

`.gitignore` 会过滤常见环境文件、Android 私钥容器、PEM/PK8 私钥、keystore 的 Base64 副本和构建产物。发布前仍需检查：

```bash
git status --short --ignored
git ls-files | rg -i \
  '(^|/)(\.env($|\.)|keystore\.properties$|signing\.properties$|[^/]+\.(jks|keystore|p12|pfx|pkcs12|pem|key|pk8)(\..*)?$|[^/]*(keystore|signing)[^/]*\.(base64|b64)$)' \
  | rg -v '(^|/)\.env(\.[^/]+)?\.example$' || true
```

第二条命令应没有输出。还要人工检查 staged diff，避免密码、Token、服务器地址或本机绝对路径出现在普通文本中：

```bash
git diff --cached
```

`.gitignore` 不会停止跟踪已经提交过的文件。若敏感文件曾进入提交，立即停止发布、撤销跟踪并轮换相关私钥或密码；若已推送，还必须按泄露事件处理 Git 历史，不能只增加忽略规则。

## 完整构建与提交

```bash
./scripts/build-android.sh all lite
# 先保存 Lite APK（Gradle 两种配置使用同一输出路径）
./scripts/build-android.sh all full
git diff --exit-code
git status --short
```

构建必须通过两套前端检查与生产 bundle、JVM 测试、Debug/Release lint、APK assembly 和 APK 边界检查。构建后 `git diff --exit-code` 必须通过，确保构建没有改写受 Git 跟踪的源码。前端产物不提交；构建会核对 APK 内两套前端的完整文件集合和字节内容与本次生成结果一致。

确认 staged 内容后，使用聚焦的 Conventional Commit 并先推送 `main`：

```bash
git add <明确的文件列表>
git diff --cached
git commit -m "chore(release): prepare v<versionName>"
git push origin main
```

## 创建发布标签

只创建指向已推送 `main` 提交的 annotated tag：

```bash
git tag -a v<versionName> -m "Release v<versionName>"
./scripts/verify-version.sh v<versionName>
git push origin v<versionName>
```

标签推送后，[Signed Android release](../.github/workflows/release.yml) 会执行以下步骤：

1. 验证 SemVer、`versionCode`、annotated tag 和 `main` 可达性；
2. 恢复临时 keystore 和固定 QNN 输入，依次构建正式签名的 Lite/Full ARM64 Release APK；
3. 验证构建没有改写源码、APK 内前端资源与本次构建一致且通过边界检查，并使用 `apksigner` 验签；
4. 验证 Lite 无模型/QNN/ORT 残留、Full 模型和厂商库字节匹配清单；生成各自 SHA-256 文件并创建 GitHub Release。

CI 不会发布 unsigned APK，也不会回退到 Debug 证书。

## 验收 GitHub Release

确认 Actions 成功、Release 不是 Draft，并同时存在两个 APK 与各自 `.sha256`。下载后校验：

```bash
gh release download v<versionName> --repo buggzd/tachi
shasum -a 256 --check tachi-<versionName>-full-arm64-v8a.apk.sha256
${ANDROID_HOME}/build-tools/34.0.0/apksigner verify \
  --verbose --print-certs tachi-<versionName>-full-arm64-v8a.apk
```

Linux 可将 `shasum -a 256 --check` 替换为 `sha256sum --check`。验签结果必须至少显示 v2 scheme 为 `true`、签名者数量为 1，证书 SHA-256 必须与本文记录一致。最后在目标手机完成一次安装或覆盖升级烟雾测试。

## 失败恢复

- 标签尚未推送：修复问题、重新完整验证，再创建标签。
- 标签已经推送但 Release 尚未创建：不得移动或删除标签。先在 `main` 修复 CI，再从 Actions 手动运行 `Signed Android release`，输入原标签。
- Release 已创建：不得覆盖标签或附件。提升 PATCH 与 `versionCode`，创建一个新 Release。
- keystore 私钥丢失：同包名 APK 无法覆盖现有安装。只能要求用户卸载后重装，或更换 application ID 作为另一款应用发布。

## 签名材料轮换

普通密码泄露时，应立即更新相应 GitHub Secret 和离线记录。私钥疑似泄露时不要继续发布，应先评估 Android 版本覆盖范围和密钥轮换方案；不能简单生成新证书后继续使用原包名覆盖安装。

任何签名材料变更都应由仓库所有者明确确认，并在不包含秘密值的情况下记录证书指纹、启用版本和迁移影响。
