# 版本与发布规则

本文档定义不可变的版本约束；实际发布步骤和验收清单见 [Release 发布手册](RELEASE.md)。

## 唯一版本源

仓库根目录的 [`version.properties`](../version.properties) 是应用版本的唯一来源：

```properties
versionName=0.2.0
versionCode=2
```

- `versionName` 使用 SemVer：兼容性修复提升 PATCH，向后兼容功能提升 MINOR，不兼容的安装、会话或公开协议变化提升 MAJOR。允许 `-rc.1` 这类预发布后缀，不使用构建元数据。
- `versionCode` 是正整数，对外发布的 Android 版本必须严格递增；发布后不得降低、复用或修改同一版本对应的数值。同一修复中的本地 Debug 构建和真机调试沿用当前版本号，不因每轮安装递增；修复完成、准备交付时统一定版。
- Android Gradle 和眼镜端 Jellyfin 请求头直接读取该文件。`CompanionUI`、`GlassesUI` 的 `package.json` 与各自 `package-lock.json` 版本属于同步元数据，必须与它一致。

修改版本时，先更新 `version.properties` 中的两个值，再同步两套前端元数据：

```bash
npm --prefix CompanionUI version <versionName> --no-git-tag-version
npm --prefix GlassesUI version <versionName> --no-git-tag-version
./scripts/verify-version.sh
```

## Git 标签

- Release 标签只能使用与 `versionName` 完全一致的带注释标签 `v<versionName>`，例如 `v0.2.0`。
- 标签必须指向 `main` 上已通过完整验证、生产 bundle 可从源码生成且工作区干净的提交。
- 已发布标签和 Release 不得移动、覆盖或复用；修正发布内容时提升 PATCH 与 `versionCode`。
- 发布提交不得包含 APK/AAB、SDK、签名文件、凭据、本机地址或开发配置。

发布前运行：

```bash
./scripts/build-android.sh all
git diff --exit-code
git tag -a v<versionName> -m "Release v<versionName>"
./scripts/verify-version.sh v<versionName>
git push origin main v<versionName>
```

推送标签后，[Release Action](../.github/workflows/release.yml) 会重新验证版本、构建并校验正式签名 Lite APK，生成 SHA-256 文件，再创建 GitHub Release。Full 在同一标签的干净源码上本地构建，使用相同正式证书，经包内容校验和设备验收后补充上传；具体流程见 [发布手册](RELEASE.md)。不得上传未经验证或临时签名的 APK。

若已推送的标签在创建 Release 前因 CI 或基础设施故障失败，先在 `main` 修复工作流，再从 Actions 手动运行同一工作流并输入原标签。恢复任务仍会检出并验证原 annotated tag；不得移动或覆盖标签。

## 发布签名

Release 必须持续使用同一份长期保存的自有证书。更换证书会阻止已安装版本原位升级。禁止使用 Debug、临时或仅保存在 CI 中且没有离线备份的证书。

GitHub Actions 需要以下 Repository Secrets：

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 完整 keystore 文件的 Base64 文本 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 正式签名 alias |
| `ANDROID_KEY_PASSWORD` | alias 私钥密码 |

`ANDROID_KEYSTORE_BASE64` 可从离线保存的正式 keystore 生成并直接写入 GitHub：

```bash
base64 < /secure/path/release.jks | gh secret set ANDROID_KEYSTORE_BASE64
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS
gh secret set ANDROID_KEY_PASSWORD
```

其余三个命令由 `gh` 安全提示输入。不要把值放在命令参数、Shell 历史、日志、提交或 Release 附件中。GitHub Secrets 配置完成后仍需单独保存 keystore、alias 和密码的离线备份。
