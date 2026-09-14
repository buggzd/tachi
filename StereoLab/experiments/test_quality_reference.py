"""Contract tests for the isolated, byte-identical upstream rendering subset."""
import hashlib
import json
from pathlib import Path
import sys
import unittest
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
VENDOR=ROOT/'vendor/qinglong-quality'
sys.path[:0]=[str(VENDOR),str(ROOT/'.local/quality-core')]
from depth_surge_3d.rendering.stereo_renderer import StereoRenderer, StereoRenderSettings
from depth_surge_3d.rendering.quality.renderer import prepare_relative_quality_frame, render_prepared_relative_quality_compact
from depth_surge_3d.rendering.quality import native_kd

class QualityReferenceTests(unittest.TestCase):
    def test_rendering_sources_and_loaded_extension_match_snapshot(self):
        hashes=json.loads((VENDOR/'SOURCE_HASHES.json').read_text())
        for rel,expected in hashes.items():
            self.assertEqual(hashlib.sha256((VENDOR/rel).read_bytes()).hexdigest(),expected,rel)
        self.assertEqual(native_kd.native_build_info()['source_sha256'],hashes['native/quality_kd_native.cpp'])

    def test_zero_strength_exactly_preserves_both_eyes(self):
        rng=np.random.default_rng(3);image=rng.integers(0,256,(64,128,3),dtype=np.uint8)
        depth=np.full((16,32),.2,np.float32);depth[:,10:20]=.8
        settings=StereoRenderSettings(stereo_strength=0,stereo_render_mode='quality')
        prepared=prepare_relative_quality_frame(frame=image,canonical=depth,settings=settings)
        output=render_prepared_relative_quality_compact(renderer=StereoRenderer('cpu'),prepared=prepared)
        np.testing.assert_array_equal(output.left_image,image)
        np.testing.assert_array_equal(output.right_image,image)
        self.assertTrue(np.all(output.left_coverage_count==16))

    def test_nonzero_strength_exposes_partial_coverage_in_both_eyes(self):
        image=np.full((64,128,3),(160,80,20),np.uint8);image[:,40:80]=(20,30,230)
        depth=np.full((16,32),.2,np.float32);depth[:,10:20]=.8
        settings=StereoRenderSettings(stereo_strength=3.2,stereo_render_mode='quality')
        prepared=prepare_relative_quality_frame(frame=image,canonical=depth,settings=settings)
        output=render_prepared_relative_quality_compact(renderer=StereoRenderer('cpu'),prepared=prepared)
        for coverage in [output.left_coverage_count,output.right_coverage_count]:
            self.assertTrue(np.any(coverage<16));self.assertTrue(np.all(coverage<=16))
        self.assertFalse(np.array_equal(output.left_image,output.right_image))

if __name__=='__main__':unittest.main()
