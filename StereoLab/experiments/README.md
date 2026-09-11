# 桌面实时 SBS 优化实验

报告与数据：[2026-09-11 优化报告](../../docs/performance/2026-09-11-desktop-optimization/README.md)。
实验与 Android 产品实现分离，不操作 ADB，不自动切回平面，也没有将候选改为产品默认值。

需要 Python 3.11 / macOS ARM64（CoreML 对照仅适用于 macOS），以及现有本地文件：

- `StereoLab/.local/samples/clip-{0,1,2}.mp4`
- `StereoLab/.local/npu/calib/*.png`
- `StereoLab/.local/npu/depth-anything-v2-small-fixed-266.onnx`

依赖版本见 `requirements.txt`。在独立环境安装，模型、片源与依赖不进入 Git。
以下从仓库根目录运行，将 `python` 换成已安装依赖的解释器：

```bash
python -m pip install -r StereoLab/experiments/requirements.txt
python StereoLab/experiments/test_temporal.py
python StereoLab/experiments/temporal_bench.py --out /tmp/algorithms.json
python StereoLab/experiments/real_depth_bench.py --out /tmp/real-depth.json
python StereoLab/experiments/coreml_bench.py --out /tmp/coreml.json
npm --prefix StereoLab ci
npm --prefix StereoLab run dev
# 另一个终端，逐条执行性能测试，避免相互争用资源：
node StereoLab/experiments/capture_bench.mjs /tmp/capture.json
node StereoLab/experiments/warp_bench.mjs /tmp/warp.json
```

Chrome 使用实际安装版本，脚本记录版本与 ANGLE renderer。浏览器脚本只访问本地
已下载片段，不访问 Jellyfin 账号、不上报播放。CoreML 的本地详细 profile 写到
`.local/npu`；结果只导出 provider 计数，不把完整 profile 或绝对路径提交。

`temporal_bench.py` 的固定参数基线复现 `DepthStabilizer` 的浮点内部状态、P5/P95
与 RGB 门控，指标使用量化前相对深度；没有模拟最终 U8 舍入（单眼最大约 0.059 px）。
合成指标将归一化误差乘以 30，表示源坐标单眼视差，不包含虚拟银幕缩放。
`real_depth_bench.py` 使用浮点模型；没有声称与 Android U16/I8 模型逐点相同。

本轮运动实验使用有界两帧推理延迟与 8/12 Hz 理想深度源，迟到结果经过每一段流
映射至当前帧。低可信度区域保留旧值。DIS 不是现有 JS block matcher 的原样移植，
本轮没有进行二者直接 A/B；生产实现仍须解决运动缩略图读回与传输成本。
