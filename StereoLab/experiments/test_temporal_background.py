import unittest
import cv2
import numpy as np
from temporal_background import background_registration, fill_from_frames

class TemporalBackgroundTests(unittest.TestCase):
    def test_future_frame_recovers_exposed_background_without_changing_covered_pixels(self):
        h,w=180,480
        rng=np.random.default_rng(5)
        bg=cv2.GaussianBlur(rng.integers(30,180,(h,w,3),dtype=np.uint8),(5,5),0)
        current=bg.copy();future=bg.copy();current[:,200:260]=(0,0,255);future[:,220:280]=(0,0,255)
        depth=np.full((h,w),.2,np.float32);depth[:,200:260]=.8
        next_depth=np.full((h,w),.2,np.float32);next_depth[:,220:280]=.8
        matrix=background_registration(current,future,depth,next_depth)
        self.assertIsNotNone(matrix)
        np.testing.assert_allclose(matrix,[[1,0,0],[0,1,0]],atol=.5)
        coverage=np.full((h,w),16,np.uint8);coverage[10:-10,200:202]=0
        pre=current.copy();pre[coverage==0]=0
        output,origin=fill_from_frames(pre,coverage,current,depth,[(1,future,next_depth,matrix)],1)
        self.assertGreater(np.count_nonzero(origin),100)
        np.testing.assert_array_equal(output[coverage==16],current[coverage==16])
        self.assertLess(int(output[origin!=0,2].max()),220)

    def test_missing_or_rejected_donors_preserve_fallback_exactly(self):
        image=np.full((32,64,3),100,np.uint8);coverage=np.zeros((32,64),np.uint8)
        output,origin=fill_from_frames(image,coverage,image,np.full((32,64),.2,np.float32),[],1)
        np.testing.assert_array_equal(output,image);self.assertEqual(np.count_nonzero(origin),0)

    def test_background_flow_tracks_camera_translation(self):
        rng=np.random.default_rng(11)
        image=cv2.GaussianBlur(rng.integers(20,220,(180,480,3),dtype=np.uint8),(5,5),0)
        donor=cv2.warpAffine(image,np.float32([[1,0,6],[0,1,-2]]),(480,180),borderMode=cv2.BORDER_REFLECT)
        depth=np.full((180,480),.2,np.float32)
        matrix=background_registration(image,donor,depth,depth)
        self.assertIsNotNone(matrix)
        np.testing.assert_allclose(matrix,[[1,0,6],[0,1,-2]],atol=.5)

    def test_cut_is_rejected(self):
        a=np.zeros((180,480,3),np.uint8);b=np.full_like(a,255);depth=np.full((180,480),.2,np.float32)
        self.assertIsNone(background_registration(a,b,depth,depth))

if __name__=='__main__':unittest.main()
