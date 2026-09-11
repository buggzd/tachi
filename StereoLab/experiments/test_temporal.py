import unittest
import numpy as np
from temporal_bench import Filter,flow_pair,remap,W,H,X,Y

class TemporalTests(unittest.TestCase):
    def test_flat_frame_keeps_previous_map(self):
        f=Filter(.16);rgb=np.zeros((H,W,3),np.uint8)
        previous=f.update(X/W,rgb,1/8).copy()
        np.testing.assert_array_equal(f.update(np.zeros((H,W),np.float32),rgb,1/8),previous)
    def test_identity_flow_preserves_depth(self):
        gray=np.clip(100+60*np.sin(X*.2)*np.cos(Y*.3),0,255).astype(np.uint8)
        flow,confidence=flow_pair(gray,gray)
        self.assertLess(float(abs(flow).max()),.01)
        np.testing.assert_allclose(remap(X/W,flow),X/W,atol=.001)
        self.assertGreater(float(confidence[2:-2,2:-2].mean()),.99)
    def test_time_constant_is_cadence_independent_without_pixel_gate(self):
        # Range EMA should settle equally over one second at any model cadence.
        results=[]
        for hz in [4,8,16]:
            f=Filter(.16);rgb=np.zeros((H,W,3),np.uint8)
            f.update(X/W,rgb,1/hz)
            for _ in range(hz):f.update(X/W+.1,rgb,1/hz)
            results.append(f.low)
        self.assertLess(max(results)-min(results),1e-6)
    def test_cut_does_not_blend_old_scale(self):
        f=Filter(.16);rgb=np.zeros((H,W,3),np.uint8)
        before=f.update(X/W,rgb,.125)
        after=f.update(X/W*2+5,np.full_like(rgb,255),.125)
        np.testing.assert_allclose(after,before,atol=1e-6)

if __name__=='__main__':unittest.main()
