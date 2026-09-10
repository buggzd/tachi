# 2026-09-09：QNN 候选的桌面数值验证

## 目的与边界

这一步只验证固定输入模型的量化误差和 CPU 参考耗时，为 Android QNN HTP
benchmark 筛选候选。它不证明 QNN 已经在手机上运行，也不代表电影播放链路、
WebView、眼镜输出、功耗或热稳定性已经通过。

## 可复现输入

- 模型：Depth Anything V2 Small，输入 `1×3×154×266`，输出 `1×154×266`。
- 校准/比较帧：三个 Jellyfin 片段各取 8 帧，共 24 张 PNG；仅保存在
  `StereoLab/.local/npu/calib/`。
- 预处理：RGB、双线性缩放、ImageNet mean/std、NCHW float32，与实验页一致。
- 参考：固定形状浮点 ONNX；候选：QNN 预处理后静态量化，U8 权重。

```bash
StereoLab/.local/npu/venv311/bin/python StereoLab/benchmark-qnn-desktop.py \
  --reference StereoLab/.local/npu/depth-anything-v2-small-fixed-266.onnx \
  --candidate StereoLab/.local/npu/depth-anything-v2-small-qnn-266-u8a-u8w.onnx \
  --candidate StereoLab/.local/npu/depth-anything-v2-small-qnn-266-u16a-u8w.onnx \
  --calibration StereoLab/.local/npu/calib \
  --output StereoLab/.local/npu/desktop-comparison-all.json
```

## 结果

| 候选 | 浮点输出平均 Spearman | 归一化 MAE | 同位置排序一致率 | CPU 平均推理 |
| --- | ---: | ---: | ---: | ---: |
| U8 激活 / U8 权重 | 0.263 | 0.305 | 59.9% | 约 23.3 ms |
| U16 激活 / U8 权重 | **0.988** | **0.0277** | **96.6%** | 约 43.0 ms |

U8 激活候选改变了多个片段的前后景排序，淘汰。U16 激活候选保留了相对深度
结构，暂列为后续候选。桌面 CPU 时间只用于相对参考；U16 在 CPU 上较慢并
不能预测 HTP 性能。

## 下一步判定

官方 SDK 已到位，最小图已通过。实机 QNN 拒绝 U16/U8 的逐通道无符号卷积权重，
因此切换到已有 U16/I8 候选：相同 24 帧上的平均 Spearman 0.9795、归一化 MAE
0.0386、排序一致率 95.4%。这些仍是校准集内的相对浮点一致性，不能充当独立
质量验收。实机严格 QNN 分区和性能见 [官方 QAIRT 验证](qairt-device.md)。
