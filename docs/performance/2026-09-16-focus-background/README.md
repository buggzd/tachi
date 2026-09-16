# Android 遥控焦点与封面背景复测

## 基线与根因

无线 ADB 连接实际运行的 tachi Debug，通过眼镜 WebView 的 CDP 读取聚合状态。
在 Liquid 详情选集页，手机持有窗口焦点，眼镜 `document.hasFocus()` 为 false。
经手机的 `JellyfinNative.remoteCommand("right", false)` 发送遥控：

| 观察 | 修复前 |
| --- | --- |
| `document.activeElement` 移到下一卡片 | 是 |
| 空间焦点标记移到下一卡片 | 是 |
| `focusin` 事件数 | 0 |
| 背景图片改变 | 否 |

只给当前卡片补发一次冒泡 `focusin` 后，背景立即改变。图片加载与模糊无需修改；
React 的 `onFocus`/`onFocusCapture` 未收到通知才是这次问题的直接原因。

## 修复与验证

统一焦点函数观察 `.focus()` 的同步 `focusin`，仅在逻辑目标改变且事件缺失时补发。
正常浏览器事件不会重复，同一目标重复选择不会重复补发。图片 URL 仅在设备内存中
比较是否变化，不记录地址、令牌、媒体标题、图片内容或账号。

安装修复版后，Mirror 2D 实测首页 Hero → 内容行、内容行横向切换、详情选集横向切换：
眼镜文档仍未获得窗口焦点，每次测试移动产生 1 个通知，背景改变，空间焦点标记为 1 个。
详情选集测试先定位到第一集，再使用原生遥控移动；未启动媒体播放。

SBS 切换后 HyperOS 报告外屏 disabled，等待用户开启系统镜像；本轮尚未完成
SBS 修复后复测，不能以 Mirror 2D 的通过结果代替 SBS 验收。

83 项前端测试通过，含新增的缺失通知、正常通知去重、同一目标及已移除节点回归；
TypeScript、两套前端 Gradle 产物、应用/播放器 JVM 测试、lint、Debug APK 构建和
`verify-android.sh` 通过。该记录不替代完整播放、登录、插拔及所有主题的回归矩阵。
