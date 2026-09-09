# SBS 虚拟银幕：现行几何与硬件边界

tachi 已实现普通 2D 视频的可调远近虚拟银幕：复用同一个 WebView 帧，在左右眼分别缩放和平移。无需第二个播放器、逐像素深度生成或 XR 空间服务。显示状态机和生命周期约束见 [Android 架构](ANDROID_ARCHITECTURE.md#rayneo-display-state)，操作方式见 [使用指南](USER_GUIDE.md#眼镜显示模式)。

逐像素深度生成与双眼重投影另有 [独立桌面实验](../StereoLab/README.md)，尚未接入 APK；下文仍描述已发布的平面虚拟银幕。

## 坐标与视差

完整 SBS 输出包含两个并排的 16:9 眼区。设每眼原生宽度为 `N`、高度为 `H`，缩放比例为 `s`，总眼内视差为 `d = uL - uR`：

```text
inset = (1 - s) × N / 2
leftX = inset + d / 2
rightX = inset - d / 2
top = (1 - s) × H / 2
```

右眼在完整传输画面中另加一个 `N` 的区域起点；这个并排偏移不是双目视差。正 `d` 增加会聚。先确定原生像素位移，再缩放源画面，使银幕大小不会改变设定视差。两眼分别裁剪到自己的区域，黑底填充其余部分。

保留边缘余量 `m = 0.01N`，约束为：

```text
s × N + |d| + 2m ≤ N
```

实现位于 [StereoScreenGeometry.java](../AndroidApp/app/src/main/java/com/jellyfinforrayneo/client/StereoScreenGeometry.java)。硬件模式和实际 View 都必须满足 Full-SBS 比例；不支持的半宽、旋转或裁切几何不能误确认成功。

## 参数与页面视口

| 参数 | 当前值与含义 |
| --- | --- |
| `depthLevel` | 整数 0–3；每眼宽度 1920 时，总视差分别为 0/8/16/24 px，随实际眼区宽度等比缩放 |
| `sizePercent` | 整数 80–95；独立于深度，并受边缘余量约束 |
| 初始偏好 | 深度 1、大小 90%；历史测试使用的 95% 不是默认值 |
| 参数过渡 | 180 ms Canvas 几何动画，遵守系统动画设置；不重载 WebView 或视频 |
| 页面设计宽度 | 1440 CSS px，由 WebView overview fitting 适配源 View |

设置由原生 `SessionRepository` 保存，输入白名单与边界见 [StereoScreenSettings.java](../AndroidApp/app/src/main/java/com/jellyfinforrayneo/client/StereoScreenSettings.java)。

设稳定渲染密度为 `ρ`、页面缩放为 `z`、设计宽度 `C=1440`：

```text
z = N / (ρ × C)
CSS 到原生像素比例 = N / C
CSS 视口高度 = H × C / N
```

在 `N=1920, H=1080` 时，页面视口为 1440×810 CSS px，再应用双眼变换。WebView 使用 Activity 的稳定渲染上下文，Presentation 负责实际窗口和原生像素布局；JS 的 `screen.*` 不作为硬件模式的确认依据。

## USB 模式控制

本应用通过 Android USB Host 直接控制已核验的 Air 3s HID 接口：

| 项目 | 契约 |
| --- | --- |
| 设备 | VID/PID `1bbb:af50`，接口 0，HID class/subclass/protocol `3/0/0` |
| 端点 | interrupt OUT `0x01`、IN `0x81`，最大包 64 字节 |
| SBS 命令 | 固定 64 字节，开头 `66 06`，其余为零 |
| 2D 命令 | 固定 64 字节，开头 `66 07`，其余为零 |
| 传输 | 单线程有界队列，等待最多 750 ms，完成后释放接口和连接 |

实现只接受上述固定身份与报告，不提供任意字节桥接、固件写入或 USB 重置。协议来源和静态分析证据保留在 [历史记录第 16 节](archive/2026-09-05-sbs-design.md#16-移除-xr-空间依赖直接控制-usb2026-09-06)，历史 SDK 下载脚本仅供复核，不参与构建或运行。

USB 授权等待不遮黑眼镜，也不占用硬件切换的 8 秒窗口。只有活动硬件切换可以隐藏 WebView；写入命令后还须核对实际物理输出和 View 几何。若输出已经符合请求，不重复发送切换命令；失败显示安全 2D，不自动重试。

HyperOS 的系统“屏幕镜像”控制外接显示是否可用；应用的 2D/SBS 设置控制眼镜模式，两者是独立状态。系统关闭逻辑外屏时需要用户恢复镜像，应用不会替用户修改系统开关。

## 光学含义与限制

理想平面模型满足：

```text
d = fx × b × (1/Z - 1/Z0)
```

`fx` 为眼内像素焦距，`b` 为瞳距，`Z0` 为零视差参考距离，`Z` 为会聚刺激指定的距离。此式需要正确的坐标、光学参数与个体校准，不能仅用产品宣传中的屏幕尺寸推算可靠的米数。

Air 3s 的标称 FoV 46°、1080P/每眼与 BirdBath 光学背景只是建模参考；FoV 的方向、个体 IPD、佩戴和光学零点仍影响结果。当前只提供相对远近档位，不承诺米制距离、舒适极限或匹配的调焦距离。银幕随头移动，没有世界固定或头部追踪。

完整推导和带来源的官方参数比较见 [历史分析](archive/2026-09-05-sbs-design.md)。其中升级前“没有视差”的描述以及 SDK/XR 服务实现属于已替换的代码基线。

## 验证

参数、边界和模式状态有 JVM 覆盖；实际输出仍须执行 [设备回归矩阵](ANDROID_ARCHITECTURE.md#device-regression-matrix)。重点确认物理模式与窗口一致、页面四边可见、双向切换保留同一 document/video、深度与大小独立、运动视频/字幕双眼更新，以及一个声音和一组播放上报。

左右眼检查图只用于临时验收；退出设置、切换模式、断连或恢复失败后必须清除。截图和原生帧数不能代替逐眼佩戴、光学舒适度或音画同步检查。历史设备证据见 [切换与裁切修复](archive/2026-09-05-sbs-design.md#17-切换后画面缩小与视口裁切修复2026-09-06) 和 [性能复测](performance/2026-09-07/README.md)。
