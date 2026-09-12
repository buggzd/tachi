"""Metric safeguards: exact geometry is perfect; freezing genuine motion is not."""
import unittest
import numpy as np
from artifact_bench import metrics, scenes, SCALE, ROI


class ArtifactMetricTests(unittest.TestCase):
    def test_exact_geometry_has_no_spatial_or_temporal_error(self):
        _, gt, _, _, masks = next(s for s in scenes(1) if s[0] == 'shallow_motion')
        result = metrics(gt, gt.copy(), masks, np.ones(len(gt)))
        for name in ('maePx', 'p95Px', 'edgeMaePx', 'revealMaePx', 'temporalChangeErrorPx'):
            self.assertEqual(0, result[name])
        self.assertAlmostEqual(1, result['foregroundContrastRatio'], places=5)

    def test_freezing_real_motion_is_penalized_despite_zero_output_frame_difference(self):
        _, gt, _, _, masks = next(s for s in scenes(1) if s[0] == 'shallow_motion')
        frozen = np.repeat(gt[:1], len(gt), axis=0)
        self.assertEqual(0, np.abs(np.diff(frozen, axis=0)).sum())
        result = metrics(gt, frozen, masks, np.ones(len(gt)))
        self.assertGreater(result['temporalChangeErrorPx'], 0)
        self.assertGreater(result['maePx'], 0)
        self.assertLess(result['foregroundContrastRatio'], .5)

    def test_depth_bias_reports_single_eye_pixels_without_fitting_bias_away(self):
        _, gt, _, _, masks = next(s for s in scenes(1) if s[0] == 'static_noise')
        result = metrics(gt, gt + .1, masks, np.ones(len(gt)))
        self.assertAlmostEqual(.1 * SCALE, result['maePx'], places=5)
        self.assertAlmostEqual(.1 * SCALE, result['edgeMaePx'], places=5)

    def test_reveal_mask_keeps_small_ghost_regions_visible_in_metrics(self):
        _, gt, _, _, masks = next(s for s in scenes(1) if s[0] == 'shallow_motion')
        pred = gt.copy()
        reveal = masks[:-1] & ~masks[1:] & ROI
        pred[1:][reveal] += .1
        result = metrics(gt, pred, masks, np.ones(len(gt)))
        self.assertAlmostEqual(.1 * SCALE, result['revealMaePx'], places=5)
        self.assertLess(result['maePx'], result['revealMaePx'] / 10)


if __name__ == '__main__':
    unittest.main()
