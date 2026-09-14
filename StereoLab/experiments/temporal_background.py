"""Offline background registration from measured bidirectional DIS flow.
Only repairs disocclusions. A robust affine background model extrapolates motion
into occluded pixels, where ordinary optical flow is undefined. Not dense-flow
truth, not a guarantee for parallax, moving backgrounds or repeated textures.
"""
import cv2
import numpy as np


def background_registration(current, donor, current_depth, donor_depth):
    h, w = current.shape[:2]
    small = (480, round(h * 480 / w))
    a = cv2.resize(cv2.cvtColor(current, cv2.COLOR_BGR2GRAY), small)
    b = cv2.resize(cv2.cvtColor(donor, cv2.COLOR_BGR2GRAY), small)
    # Conservative cut gate; also rejects illumination changes and large movement.
    if np.mean(cv2.absdiff(a, b)) > 32:
        return None
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    f = dis.calc(a, b, None); back = dis.calc(b, a, None)
    yy, xx = np.mgrid[:small[1], :small[0]].astype(np.float32)
    qx, qy = xx + f[..., 0], yy + f[..., 1]
    reverse = cv2.remap(back, qx, qy, cv2.INTER_LINEAR)
    da = cv2.resize(current_depth, small)
    db = cv2.remap(cv2.resize(donor_depth, small), qx, qy, cv2.INTER_LINEAR)
    far = da <= np.quantile(da, .55)
    valid = far & (abs(da-db) < .08) & (np.linalg.norm(f+reverse, axis=2) < .7)
    valid &= (qx > 2) & (qx < small[0]-3) & (qy > 2) & (qy < small[1]-3)
    photometric_error = np.abs(cv2.remap(b, qx, qy, cv2.INTER_LINEAR).astype(np.float32) - a)
    valid &= photometric_error < 18
    ys, xs = np.where(valid[::4, ::4]); ys *= 4; xs *= 4
    if len(xs) < 80:
        return None
    scale = np.array([w/small[0], h/small[1]], np.float32)
    src = np.stack([xs,ys], axis=1).astype(np.float32) * scale
    dst = (np.stack([xs,ys], axis=1) + f[ys,xs]) * scale
    cv2.setRNGSeed(0)
    matrix, inliers = cv2.estimateAffine2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=1.5, maxIters=1000)
    if matrix is None or np.mean(inliers) < .75:
        return None
    # No unrestricted extrapolation from tiny background fragments.
    support = src[inliers[:,0] != 0]
    if np.ptp(support[:,0]) < w*.35 or np.ptp(support[:,1]) < h*.25:
        return None
    return matrix.astype(np.float32)


def fill_from_frames(pre, coverage, fallback, depth, donors, eye, strength=1.):
    h,w=coverage.shape
    yy,xx=np.mgrid[:h,:w].astype(np.float32)
    # Boundary depths are sampled in approximate source coordinates; use the far
    # side to avoid using foreground motion/colour to repair newly exposed space.
    d=cv2.resize(depth,(w,h),interpolation=cv2.INTER_LINEAR)
    far=cv2.erode(d,cv2.getStructuringElement(cv2.MORPH_RECT,(65,1)))
    sx=xx-eye*(far-.5)*.016*strength*w
    output=fallback.copy(); provenance=np.zeros((h,w),np.int8)
    missing=coverage<16
    chosen=np.zeros((h,w),bool)
    for offset,image,donor_depth,matrix in donors:
        if matrix is None:
            continue
        qx=matrix[0,0]*sx+matrix[0,1]*yy+matrix[0,2]
        qy=matrix[1,0]*sx+matrix[1,1]*yy+matrix[1,2]
        dd=cv2.resize(donor_depth,(w,h))
        # Erosion of background acceptance excludes antialiased foreground edges.
        sample_max=cv2.dilate(dd,np.ones((5,5),np.uint8))
        z=cv2.remap(sample_max,qx,qy,cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT,borderValue=1)
        accept=missing & ~chosen & (z<=far+.035) & (abs(z-far)<.08)
        accept &= (qx>=2)&(qx<w-3)&(qy>=2)&(qy<h-3)
        rgb=cv2.remap(image,qx,qy,cv2.INTER_LINEAR)
        composed=np.clip(np.rint(pre.astype(np.float32)+rgb.astype(np.float32)*(1-coverage[...,None]/16)),0,255).astype(np.uint8)
        output[accept]=composed[accept];provenance[accept]=offset;chosen |= accept
    return output,provenance


def original_gather(image, depth, eye, strength=1.):
    """CPU translation of native gather33 at 1x, for offline same-frame comparison."""
    h,w=image.shape[:2];d=cv2.resize(depth,(w,h),interpolation=cv2.INTER_LINEAR)
    xx=np.broadcast_to(np.arange(w,dtype=np.int32),(h,w));source=xx.copy()
    found=np.zeros((h,w),bool);best=np.full((h,w),-1,np.float32);best_error=np.full((h,w),1e6,np.float32)
    rows=np.arange(h)[:,None]
    for dx in range(-16,17):
        q=xx+dx;valid=(q>=0)&(q<w);safe=np.clip(q,0,w-1)
        value=d[rows,safe];error=abs(dx+eye*(value-.5)*(.016*w*strength))
        hit=valid&(error<.75);win=hit&(~found|(value>best))
        fallback=valid&~hit&~found&(error<best_error)
        source[win|fallback]=safe[win|fallback];best[win]=value[win];best_error[fallback]=error[fallback];found |= hit
    return image[rows,source]
