# 首轮集成实机调试

结论：tachi 开发包已在 SM8850 / Android 16 与 TCL 眼镜上跑通真实 Jellyfin
视频取帧、严格 QNN 深度推理、灰度预览及 Full SBS 输出。**完整实时目标未通过**：
视频约 24 fps，但深度只更新约 8 fps。不能用此前独立 NPU / WebGL 基准替代此结果。

## 基线与范围

- 起点为 `533fdc2`，本次精简 AGSL 候选循环中的冗余 UI 区域检查。
- 可选 realtime Debug 包，官方 V81 QNN 后端，CPU EP fallback 禁用；应用日志确认
  DSP skeleton 成功加载，随后持续返回实际深度。未使用独立 benchmark 预加载。
- 一个真实 Jellyfin 动画片段，HLS H.264/AAC、1920×1080、23.976 fps，字幕关闭。
- 一个 glasses WebView、一个 HTML video；系统物理输出 3840×1080/60 Hz。
  外接屏截图确认两眼视频、信息面板和灰度图可见；不构成光学方向或运动质量验收。
- 信息面板开启，原始 CPU Canvas 取帧；没有完整音频/服务器上报计数、GPU 时间、
  长时间热态或多个代表片段验收。测试结束关闭转换并暂停播放。

## 实测

[原始脱敏采样](sample.json) 保存相对时间、固定状态和数值，不含帧、账号或片源地址。
样本是优化版本的一段 48.212 秒连续深度回复窗口，394 个有效结果，无 stale/error。

| 项目 | 平均 | P95 |
| --- | --- | --- |
| 深度更新频率 | 8.151 fps | — |
| 原生处理（解码、预处理、推理、归一化） | 30.805 ms | 35 ms |
| 捕获起点到 JS 回复的帧龄 | 96.185 ms | 119 ms |
| CPU Canvas drawImage | 20.572 ms | 40.1 ms |
| getImageData | 0.361 ms | 0.5 ms |
| btoa 本身 | 0.413 ms | 0.6 ms |

原生时间不是纯 NPU kernel 时间；回复帧龄也不是最终呈现延迟。阶段耗时通过
DevTools 临时包装函数采样，可能产生扰动；`btoa` 不包含前面的字节转字符串循环。
视频质量计数在采样末尾为 1338 总帧、0 掉帧，这是播放器累计值，不是深度窗口帧数。

精简前独立抽样约 7.81 fps、原生 P95 35 ms；另一段约 58 秒视频增量采样为
1389 帧、0 新增掉帧。临时把 Canvas 改为 GPU 模式，drawImage 约 0.99 ms，
getImageData 约 32.30 ms，深度仍约 7.78 fps，因而未合入此设置。
这些实验对应不同播放时间，不能据此宣称着色器优化有确定的性能增益。

AGSL 精简的依据是：目的点的 UI 保护区横向扩展 17 像素，而候选源最多偏移
16 像素；目的点在保护区外时，候选源不可能落入实际 UI。去掉每个候选重复的
八区域检查，保留视频边界与外层保护。桌面实际 shader 的几何/遮挡测试通过；
JVM、Lint、开发 APK 构建和 APK 验证通过。

## 恢复检查

- 暂停后等待清理，再观察 1.5 秒：无新增深度回复。
- 恢复后深度返回；向前 seek 10 秒后继续返回新序号，仍只有一个 video。
- 关闭实时转换后等待清理，再观察 1 秒：无新增深度回复，原视频继续播放。
- 未覆盖完整账号、renderer 丢失、音轨、直放、冷热启动及设备回归矩阵。

## 切换 SBS 后系统禁用显示

实机复现：USB 模式切换后设备仍存在，物理模式已是 3840×1080，但外接 display
为 OFF / disabled，应用失去 Presentation。通过 Android shell 的 `cmd display
enable-display` 重新启用该外接显示后，应用恢复并确认 stereo applied。
因此这不是无线 ADB 断连或深度推理失败。

Android 16 的 `enableConnectedDisplay` 要求 `MANAGE_DISPLAYS`，该权限为
signature。普通 APK 无法申请系统签名权限，ADB shell 的成功不能作为应用可调用
的证据。当前仍需要 HyperOS 的“屏幕镜像”操作；不加入自动 USB 重试循环。

来源：[DisplayManagerService](https://github.com/aosp-mirror/platform_frameworks_base/blob/android16-release/services/core/java/com/android/server/display/DisplayManagerService.java)
及 [系统权限声明](https://github.com/aosp-mirror/platform_frameworks_base/blob/android16-release/core/res/AndroidManifest.xml)。

## 下一步

优先拆分帧通道的同步等待与渲染开销，验证异步 GPU 降采样/读回和受限流水线，
而非继续仅优化模型。24 fps 的帧预算为 41.7 ms，当前串行捕获与原生处理已超过
预算；150 ms 过期保护不能让 8 fps 深度变成逐视频帧转换。需要独立测量 AGSL/HWUI
时间、实际深度使用帧龄与覆盖比例，然后再执行多片段、快速运动和热态验收。
