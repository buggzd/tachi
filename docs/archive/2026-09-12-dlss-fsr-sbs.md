# 2026-09-12 DLSS / FSR 时序资料与 SBS 画质研究

研究基线：tachi `8cee14f` 原生 QNN SBS。任务是分析边缘鬼影和深度抖动，不是接入桌面游戏超分 SDK。
源资料读取于 2026-09-12；下述改造是建议，未实现、未完成实机画质或功耗验收。

## 本次核实的版本与公开边界

- NVIDIA [最新 Release v310.9.1](https://github.com/NVIDIA/DLSS/releases/tag/v310.9.1)，发布于 2026-09-08；
  发布说明为增加 Ray Reconstruction Transformer Mode（Preset F）及修复。这里的版本是 SDK 版本，
  不能把 RR 的新增模式直接当成 Super Resolution 内部算法的完整说明。
- [Streamline DLSS 接入指南](https://github.com/NVIDIA-RTX/Streamline/blob/main/docs/ProgrammingGuideDLSS.md)
  明确要求输入颜色、深度、运动矢量、输出资源；运动尺度、jitter 和资源尺寸必须一致。
  当前示例列出 K/M/L 等 preset。公开集成说明不能证明闭源网络内部采用了某个指定滤波公式。
- AMD 当前仓库的 [FSR Upscaling 4.1.1 文档](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/blob/60f4ea81909200d8542eca14dccb2628b763a9a3/Kits/FidelityFX/docs/techniques/super-resolution-ml.md)
  版本表日期 2026-06-24。它使用 ML 时空重建，经 API / 签名二进制集成，仍要求深度和运动矢量。
  **FSR 4 已不要求应用一定提供 Reactive / Transparency & Composition mask，这些输入为可选。**
  文档描述的调试视图显示运动和历史混合权重；不能据此声称当前网络结构或训练损失已公开。
- 可直接审阅实现的是 [FSR 3 upscaler 历史重投影](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/blob/60f4ea81909200d8542eca14dccb2628b763a9a3/Kits/FidelityFX/upscalers/fsr3/include/gpu/fsr3upscaler/ffx_fsr3upscaler_reproject.h)、
  [累积 / RectifyHistory](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/blob/60f4ea81909200d8542eca14dccb2628b763a9a3/Kits/FidelityFX/upscalers/fsr3/include/gpu/fsr3upscaler/ffx_fsr3upscaler_accumulate.h)
  和 [反应 / 遮挡判定](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/blob/60f4ea81909200d8542eca14dccb2628b763a9a3/Kits/FidelityFX/upscalers/fsr3/include/gpu/fsr3upscaler/ffx_fsr3upscaler_prepare_reactivity.h)。
  不把这些手写 shader 公式冒充 FSR 4 或 DLSS 最新网络实现。

## 应借鉴的机制

1. **先运动对齐，再融合历史。** 重投影把当前像素映射到历史帧中的同一物体，而不是直接取相同屏幕坐标。
2. **遮挡露出时降低或拒绝历史。** 新露出的背景过去被前景挡住，没有可直接复用的历史；错误历史会形成拖影。
3. **历史裁剪。** FSR 3 的 RectifyHistory 用当前局部颜色分布限制历史值，并依据运动、反应、遮挡、历史锁定
   等信息调整贡献。它不是简单固定比例混合。迁移到深度时，应使用保边的局部深度范围和置信度，
   不能直接套用颜色的 YCoCg 盒子或跨前后景的 min/max。
4. **稳定区域保留历史，变化区域快速响应。** 降噪和拖尾是一对权衡；全画面统一加重平滑会伤害运动轮廓。
5. **控制输入一致性与重置。** 镜头切换、尺寸变化、时间步长、输入曝光等会改变历史意义，需要明确处理。

游戏引擎能给出几何深度、相机信息和对象运动；普通视频只有最终 RGB，模型给出的还是相对深度。
我们必须估计光流及置信度，深度尺度也需对齐。视频没有受控 jitter 多帧采样，不能照搬游戏投影 jitter。
DLSS / FSR 4 也不能直接在这台 Adreno 手机上当现成库调用。它们解决的主要是时序重建，
SBS 的新视点还会暴露原图根本看不到的区域，单帧输入无法保证恢复真实隐藏纹理。

## 当前管线为何容易出现类似现象

- 当前深度采样约 12 Hz，观测帧龄通常跨多个 24 fps 视频帧，使用新颜色与旧轮廓会造成几何错位。
  增加吞吐会缩短一部分延迟，但不替代 PTS 同步。
- CPU TemporalDepth 直接融合相同坐标的旧值；颜色和深度门限切换可能在运动边缘改变平滑方式。
- 每帧重估 5%/95% 的相对深度范围，画面构图或模型尺度漂移会影响全局视差。动态范围平滑只能缓解，
  更可靠的方案是在可信、已对齐区域中拟合跨帧尺度/偏移，并限制异常更新。
- 266×154 到 1920×1080 每轴约放大七倍，普通 bilinear 会混合前后景。SBS 反投影是几何操作，
  深度边缘的偏差会变成颜色边缘的位置偏差。
- 当前 gather 缺少有效解时仍选择候选，不区分真实遮挡露出与正常可见区域，可能拉伸前景边缘填洞。

## 建议实施顺序与 GPU 分工

| 顺序 | 改造 | CPU / GPU 边界 |
| --- | --- | --- |
| 1 | 取得真实视频 PTS、绑定样本与深度、有限帧队列和统一音画字幕时钟 | CPU 调度；GPU 保留对应帧纹理，不能只保留会被覆盖的 OES 引用 |
| 2 | GPU 低分辨率光流或块匹配、历史重投影、前后向一致性与遮挡置信度 | GPU 并行；动画纯色区缺纹理，需要置信度降权，不能强用光流 |
| 3 | 归一化尺度稳定、保边历史裁剪和按时间步长的平滑 | 逐像素部分 GPU；分位数 / 小统计先在 CPU 优化，避免搬到 GPU 后又同步读回 |
| 4 | 保边上采样、显式空洞掩码与偏向背景的有限填补 | GPU；保护前景轮廓与细线，控制不可恢复区域的形变幅度 |
| 5 | 阶段重叠后评估 24/12 Hz 调度、温控和功耗 | 固定质量条件下比较，切档保留有效历史而不自动关闭深度 |

只把后处理搬到 GPU 会改善耗时，但不会自动修复同坐标历史融合的算法问题。
当前诊断中的约 18 ms “推理”计时还包含 ORT 调用和输出取值开销，不是硬件 profiler 单独测量的 HTP kernel 时间。

## 验收设计

先用桌面可重复片段比较静止画面、匀速横移、前景遮挡后露出背景、细线/头发、动画纯色区和镜头切换。
分离测量：静态深度方差、经运动补偿后的时序误差、轮廓位移误差、遮挡区域残留以及 PTS 配对误差；
不能用整图平均误差掩盖边缘问题。保留基线并做消融比较，确认减少鬼影没有换来更明显闪烁。
GPU 移植需要检查 float 纹理/FBO 能力、历史纹理 ping-pong、显式 fence 和 generation 清理。
最终仍需同片源实机 2D/SBS、音画字幕同步、seek、热态和功耗验证。
