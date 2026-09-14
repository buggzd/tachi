# 原生液化：实机反馈后的修订与复测入口

对应首次实测 [22c4d0a 报告](../2026-09-14-native-liquid-device/README.md)。本页记录开发侧修订，**不宣称已消除设备黑屏或达到 24 Hz**。

## 修订

- DisplayModeStateMachine：已确认且稳定的显示模式在 Activity 暂停时不再请求 USB 2D 往返；恢复同一连接不重新写入 EDID。系统弹窗可能早于 disabled-display 回调触发 onPause，因此旧的无条件 pause→2D 是可确认的额外切换来源。未完成模式切换被打断仍回退安全 2D；断连/销毁路径保留。系统已禁用的外接显示仍需系统许可，不绕过系统镜像确认。
- GPU 液化增加非阻塞完成 fence、提交成本与观察等待统计，保留原始 GPU query。完成观察包含队列和轮询延迟，不是纯 compute 时长；旧的近零 query 不再作为性能结论依据。即使暂停且没有后续深度任务也继续有界轮询至完成。
- liquid 配置将每眼 1080p 合成结果缓存到 SBS FBO，同一对重复呈现时只 blit，不重复执行搜索/液化渲染。新 pair、深度/模式/几何/调试变化或 GL 重建使缓存失效；增加约 15.8 MiB FBO 存储，收益待实机对照。
- native snapshot 增加 pairedPosition 和 playerMinusPairedMs。ASS 与 WebVTT 采用成对视频时间，进度/seek/观看上报继续用播放器媒体时钟；未配对、普通 2D、seek 待确认或非法时间使用原时钟。字幕仍受原生状态上报频率影响，不宣称逐显示帧精准同步。
- **音频未加固定延迟**：尚无可信口型/音频测量，先量化缓存优化后的等待，避免按旧 83 ms 盲加补偿。playerMinusPairedMs 是软件时钟差，不是光学/声学延迟。

## 同 APK 高动态入口

新增 `SbsFixtureActivity`，仅 `dailySbs=liquid` 启用，启动受 `android.permission.DUMP` 保护，可由 ADB shell 启动，普通第三方应用不能直接调用。使用同 APK 模型/运行库/native-video；不读写 Jellyfin 会话或观看进度。

```bash
adb push StereoLab/.local/samples/motion-test.mp4 /sdcard/Download/tachi-motion-test.mp4
adb shell am start -n com.jellyfinforrayneo.client.debug/com.jellyfinforrayneo.client.SbsFixtureActivity
```

在界面选择 **Choose local video**，经系统文件选择器授予该文件 URI 读取权限。优先把画面放入系统已经启用的外接显示，否则在手机显示。该入口不改变 USB 模式；若要在眼镜 SBS 验证，先在主界面设置并确认 SBS 已应用。退出 fixture 后回主界面复核显示恢复。

按钮可 seek 到约 347/579 帧时间；按钮不是帧精确解码保证。日志标签 `TachiLiquidFixture` 每秒输出匿名结构化数据；`pairedPtsUs` 用于识别实际成对源时间。根据实际 PTS 选择网页同帧，而不是把按钮上的帧号当已显示帧。没有字幕的本地 fixture 不能替代 Jellyfin 音轨/字幕测试。

## 新诊断

- `cachedPairDraws`：复用已渲染 SBS 的次数；`pairRenderUpdates`：重新计算 SBS 的次数。
- `pairedPtsUs`：接受的视频/深度对的源 PTS，未知则不作为匹配证据。
- `playerMinusPairedMs`：播放器时钟减成对视频时间。
- `liquidsubmitMsMean/P95`、`liquidfenceObservedMsMean/P95`、`liquidpollMsMean/P95`：CPU 提交、完成观察和轮询工作，不能与 query 相加。

## 复测顺序

1. 安装 [build-verification.json](build-verification.json) 指定的修订 APK，保留数据，不使用旧 SHA 校验新包。
2. 主界面确认眼镜模式，启动 fixture，通过系统文件选择器打开高动态素材。记录实际源 PTS、深度和 L/R，复核人物 l/r、鬼影与跳边。
3. 从 fixture、系统选择器或播放器返回，复核是否仍出现黑屏/镜像请求；记录触发动作、display 事件、pause/resume 和 USB 模式动作，不能仅凭消失一次宣称根治。
4. 与旧 18.9 Hz / 17 ms 对照，区分合成更新和缓存 blit；检查 GPU query 与 fence 观察的覆盖范围。检查缓存是否导致旧画面/旧深度/错误尺寸。
5. Jellyfin 播放，复核 ASS/WebVTT 在暂停、seek、深度开关后同步，再独立判断音频领先。短测通过才继续 20–30 分钟；问题出现时保留证据，不拼接播放窗口。

修订 APK：`AndroidApp/app/build/distributions/tachi-sbs-liquid-392-followup.apk`。

## 复测阶段结果

见 [9 月 15 日收尾报告](../2026-09-15-native-liquid-retest/README.md)：兼容素材短测有有效配对和缓存计数，高动态原片解码及正式播放器恢复阻塞；同步、显示恢复和长时验收仍未完成。
