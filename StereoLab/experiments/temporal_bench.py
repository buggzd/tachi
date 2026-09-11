"""Offline causal algorithm ablations; synthetic geometry is GT, model output is not.
Run from any cwd. Single-thread OpenCV CPU timing excludes video capture/inference.
"""
import argparse, json, time, platform
from pathlib import Path
import numpy as np
import cv2

cv2.setNumThreads(1)
RNG = np.random.default_rng(20260911)
W,H=266,154
Y,X=np.mgrid[:H,:W].astype(np.float32)
ROOT=Path(__file__).resolve().parents[1]

def stats(a):
    a=np.asarray(a)
    return dict(n=int(a.size),mean=float(a.mean()),p95=float(np.percentile(a,95)))

def remap(a,f):
    return cv2.remap(a,X+f[:,:,0],Y+f[:,:,1],cv2.INTER_LINEAR,borderMode=cv2.BORDER_REPLICATE)

def flow_pair(previous,current):
    dis=cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_ULTRAFAST)
    backward=dis.calc(current,previous,None)
    forward=dis.calc(previous,current,None)
    fb=np.linalg.norm(backward+remap(forward,backward),axis=2)
    photo=np.abs(current.astype(np.float32)-remap(previous,backward).astype(np.float32))
    valid=(X+backward[:,:,0]>=0)&(X+backward[:,:,0]<W-1)&(Y+backward[:,:,1]>=0)&(Y+backward[:,:,1]<H-1)
    confidence=np.exp(-fb/1.5-photo/20)*valid
    return backward,confidence

class Filter:
    def __init__(self,tau=None):
        self.tau=tau;self.last=None;self.rgb=None;self.low=0;self.high=1
    def update(self,raw,rgb,dt):
        ordered=np.sort(raw,axis=None);lo,hi=ordered[len(ordered)//20],ordered[len(ordered)*19//20]
        if hi-lo<1e-5:return self.last
        change=np.abs(rgb.astype(np.int16)-self.rgb.astype(np.int16)) if self.rgb is not None else None
        reset=self.last is None or change.mean()>35
        ar=.15 if self.tau is None else -np.expm1(-dt/self.tau)
        ap=.35 if self.tau is None else ar
        if reset:self.low,self.high=lo,hi
        else:self.low+=ar*(lo-self.low);self.high+=ar*(hi-self.high)
        out=np.clip((raw-self.low)/(self.high-self.low),0,1)
        if not reset:
            gate=(change.sum(2)<=18)&(np.abs(out-self.last)<.12)
            out=np.where(gate,self.last+ap*(out-self.last),out)
        self.last=out;self.rgb=rgb.copy()
        return out

def temporal():
    # Stable patterned scene with a localized physical depth step, retaining global anchors.
    base=(.1+.8*X/(W-1)).astype(np.float32)
    roi=(X>105)&(X<145)&(Y>55)&(Y<100)
    base[roi]=.45
    rgb=np.repeat(np.clip(base[:,:,None]*255,0,255).astype(np.uint8),3,2)
    output=[]
    for hz in [4,8,16]:
        times=np.arange(0,4,1/hz)
        frames=[]
        for t in times:
            truth=base.copy();truth[roi]=.45 if t<2 else .54
            raw=truth+RNG.normal(0,.008,truth.shape).astype(np.float32)
            # Scale/shift noise represents monocular ambiguity, not physical motion.
            raw=raw*(1+.025*np.sin(t*19))+.012*np.sin(t*13)
            frames.append((raw,truth))
        for name,tau in [('fixed',None),('time80',.08),('time160',.16),('time320',.32)]:
            f=Filter(tau);errors=[];cost=[];responses=[]
            lo,hi=np.sort(base,axis=None)[[base.size//20,base.size*19//20]]
            for i,(raw,truth) in enumerate(frames):
                start=time.perf_counter();out=f.update(raw,rgb,1/hz);cost.append((time.perf_counter()-start)*1000)
                ideal=np.clip((truth-lo)/(hi-lo),0,1)
                if .5<times[i]<2:errors.extend((30*(out-ideal))[~roi][::12].tolist())
                responses.append(float(out[roi].mean()))
            response={}
            # Clean steps isolate filter lag from common-mode noise crossing the threshold.
            for delta in [.04,.09]:
                clean=Filter(tau)
                for _ in range(hz):clean.update(base,rgb,1/hz)
                startval=float(clean.last[roi].mean());target=(.45+delta-lo)/(hi-lo)
                step=base.copy();step[roi]+=(delta)
                readings=[float(clean.update(step,rgb,1/hz)[roi].mean()) for _ in range(2*hz)]
                hits=[i/hz*1000 for i in range(len(readings)-2) if all(v>=startval+.9*(target-startval) for v in readings[i:i+3])]
                response[str(delta)]=hits[0] if hits else None
            output.append(dict(hz=hz,variant=name,stableDisparityErrorP95=float(np.percentile(np.abs(errors),95)),cleanStep90Ms=response,cpuMs=stats(cost[2:])))
    return output

def scene(t):
    # Known horizontal foreground motion with texture attached to the object.
    x0=25+2*t; mask=(X>=x0)&(X<x0+64)&(Y>=38)&(Y<119)
    background=(70+22*np.sin(X*.23)+17*np.cos(Y*.19))
    foreground=170+35*np.sin((X-x0)*.43)+24*np.cos(Y*.33)
    image=np.where(mask,foreground,background).clip(0,255).astype(np.uint8)
    depth=np.where(mask,.8,.2).astype(np.float32)
    return image,depth,mask

def motion():
    images=[];truth=[];masks=[]
    for t in range(72):
        im,d,m=scene(t);images.append(im);truth.append(d);masks.append(m)
    flows=[];conf=[];cost=[]
    for i in range(1,len(images)):
        start=time.perf_counter();f,c=flow_pair(images[i-1],images[i]);flows.append(f);conf.append(c);cost.append((time.perf_counter()-start)*1000)
    results=[]
    # 24Hz display, 8/12Hz ideal fresh depth, delayed by two display frames.
    for stride in [3,2]:
        for mode in ['hold','dis_unchecked','dis_confident']:
            current=truth[0].copy();ages=[];errors=[];edge_errors=[];reveal_errors=[];warp_cost=[]
            for t in range(1,len(images)):
                start=time.perf_counter()
                if mode!='hold':
                    warped=remap(current,flows[t-1]);current=np.where(conf[t-1]>.35,warped,current) if mode=='dis_confident' else warped
                k=t-2
                if k>=0 and k%stride==0:
                    delivered=truth[k].copy()
                    if mode!='hold':
                        valid=np.ones((H,W),np.float32)
                        for j in range(k,t):
                            delivered=remap(delivered,flows[j]);valid=remap(valid,flows[j])*conf[j]
                        current=np.where(valid>.35,delivered,current) if mode=='dis_confident' else delivered
                    else:current=delivered
                warp_cost.append((time.perf_counter()-start)*1000)
                if t>5:
                    err=30*np.abs(current-truth[t]);errors.append(float(err.mean()))
                    edge=cv2.morphologyEx(masks[t].astype(np.uint8),cv2.MORPH_GRADIENT,np.ones((9,9),np.uint8)).astype(bool)
                    edge_errors.append(float(err[edge].mean()))
                    reveal=masks[t-1]&~masks[t]
                    if reveal.any():reveal_errors.append(float(err[reveal].mean()))
            results.append(dict(modelHz=24/stride,variant=mode,disparityMAE=float(np.mean(errors)),edgeDisparityMAE=float(np.mean(edge_errors)),newlyRevealedDisparityMAE=float(np.mean(reveal_errors)),propagationMs=stats(warp_cost[3:])))
    return dict(flowBothDirectionsMs=stats(cost[3:]),results=results,limits='Ideal noiseless model depth; two-frame delivery delay; no texture acquisition cost; rejected regions hold nonzero old disparity.')

def affine():
    x=RNG.uniform(.1,.9,12000).astype(np.float32)
    clean=.88*x+.04;target=clean+RNG.normal(0,.004,x.shape)
    bad=RNG.random(x.shape)<.2;target[bad]=RNG.uniform(0,1,bad.sum())
    A=np.column_stack([x,np.ones_like(x)])
    result=[]
    for name in ['least_squares','huber_bounded']:
        start=time.perf_counter();coef=np.linalg.lstsq(A,target,rcond=None)[0]
        if name=='huber_bounded':
            for _ in range(5):
                r=A@coef-target;weight=np.minimum(1,.015/(np.abs(r)+1e-6));root=np.sqrt(weight)
                coef=np.linalg.lstsq(A*root[:,None],target*root,rcond=None)[0]
                coef[0]=np.clip(coef[0],.8,1.2);coef[1]=np.clip(coef[1],-.1,.1)
        result.append(dict(variant=name,disparityMAE=float(np.mean(abs(A@coef-clean))*30),cpuMs=(time.perf_counter()-start)*1000,scale=float(coef[0]),shift=float(coef[1])))
    return dict(results=result,limits='One synthetic correspondence fit with 20% outliers; not proof that registration preserves real forward motion. Not enabled in temporal pipeline.')

def cut_response():
    old=np.tile(np.linspace(.1,.9,W,dtype=np.float32),(H,1))
    new=old[:,::-1].copy()
    rgb=np.zeros((H,W,3),np.uint8);next_rgb=np.full_like(rgb,180)
    results=[]
    for name,tau in [('fixed',None),('time160',.16)]:
        f=Filter(tau);f.update(old,rgb,1/8)
        actual=f.update(new,next_rgb,1/8)
        target=Filter(tau).update(new,next_rgb,1/8)
        results.append(dict(variant=name,newObservationResidual=float(np.abs(actual-target).max()),heldOldSceneMsBeforeObservation=2*1000/24))
    return dict(results=results,limits='Obvious photometric cut; ideal two-display-frame delivery delay. No guarantee for similar-color cuts; no claim that old scene disappears before new observation.')

def edge_filter():
    w,h=960,540;y,x=np.mgrid[:h,:w];mask=x>(w*.45+35*np.sin(y/60))
    truth=np.where(mask,.8,.2).astype(np.float32)
    guide=(truth+.07*np.sin(x*.17)*np.sin(y*.19)).astype(np.float32)
    low=cv2.resize(truth,(W,H),interpolation=cv2.INTER_AREA)
    bil=cv2.resize(low,(w,h),interpolation=cv2.INTER_LINEAR)
    reference=cv2.Canny((truth*255).astype(np.uint8),20,50)>0
    results=[]
    for name in ['bilinear','guided','joint_bilateral']:
        times=[]
        for repeat in range(13):
            start=time.perf_counter()
            src=cv2.resize(low,(w,h),interpolation=cv2.INTER_LINEAR)
            if name=='guided':src=cv2.ximgproc.guidedFilter(guide,src,8,.001)
            if name=='joint_bilateral':src=cv2.ximgproc.jointBilateralFilter(guide,src,9,.08,4)
            times.append((time.perf_counter()-start)*1000)
        predicted=cv2.Canny((src*255).clip(0,255).astype(np.uint8),20,50)>0
        dil=lambda a:cv2.dilate(a.astype(np.uint8),np.ones((5,5),np.uint8)).astype(bool)
        precision=float((predicted&dil(reference)).sum()/max(1,predicted.sum()))
        recall=float((reference&dil(predicted)).sum()/max(1,reference.sum()))
        interior=(x<300)|(x>650)
        results.append(dict(variant=name,cpuMs=stats(times[3:]),disparityMAE=float(abs(src-truth).mean()*30),edgeF1=2*precision*recall/max(1e-9,precision+recall),textureLeakageStd=float(np.std((src-truth)[interior])*30)))
    return results

def real_motion():
    out=[]
    for clip in range(3):
        cap=cv2.VideoCapture(str(ROOT/'.local/samples'/f'clip-{clip}.mp4'));images=[]
        for i in range(96):
            ok,frame=cap.read()
            if not ok:break
            images.append(cv2.cvtColor(cv2.resize(frame,(W,H)),cv2.COLOR_BGR2GRAY))
        cap.release();elapsed=[];rawerr=[];warperr=[];coverage=[]
        for a,b in zip(images,images[1:]):
            start=time.perf_counter();f,c=flow_pair(a,b);elapsed.append((time.perf_counter()-start)*1000)
            m=c>.35
            if m.any():
                rawerr.append(float(np.abs(a.astype(float)-b)[m].mean()));warperr.append(float(np.abs(remap(a,f).astype(float)-b)[m].mean()))
            coverage.append(float(m.mean()))
        out.append(dict(clip=clip,frames=len(images),flowMs=stats(elapsed[3:]),trustedFraction=stats(coverage),unwarpedPhotometricMAE=stats(rawerr),warpedPhotometricMAE=stats(warperr),limits='RGB correspondence diagnostic on trusted pixels only, not geometric depth truth; decode/downsample excluded.'))
    return out

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',required=True);args=parser.parse_args()
    output={'environment':{'platform':platform.platform(),'opencv':cv2.__version__,'numpy':np.__version__,'opencvThreads':1,'seed':20260911},'temporal':temporal(),'motion':motion(),'affine':affine(),'cut':cut_response(),'upsampling':edge_filter(),'realMotion':real_motion()}
    Path(args.out).write_text(json.dumps(output,indent=2)+'\n');print(json.dumps(output,indent=2))
