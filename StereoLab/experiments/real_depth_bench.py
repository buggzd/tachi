"""Real-clip temporal diagnostics. Model predictions are NOT geometric ground truth."""
import argparse,json,time
from pathlib import Path
import numpy as np
import cv2,onnxruntime as ort
from temporal_bench import Filter,flow_pair,remap,stats,ROOT,W,H
p=argparse.ArgumentParser();p.add_argument('--out',required=True);args=p.parse_args()
opt=ort.SessionOptions();opt.intra_op_num_threads=4
session=ort.InferenceSession(str(ROOT/'.local/npu/depth-anything-v2-small-fixed-266.onnx'),opt,providers=['CPUExecutionProvider'])
name=session.get_inputs()[0].name;result=[]
for clip in range(3):
    cap=cv2.VideoCapture(str(ROOT/'.local/samples'/f'clip-{clip}.mp4'));rgbs=[]
    for i in range(96):
        ok,frame=cap.read()
        if not ok:break
        if i%3==0:rgbs.append(cv2.cvtColor(cv2.resize(frame,(W,H)),cv2.COLOR_BGR2RGB))
    fps=cap.get(cv2.CAP_PROP_FPS);cap.release();raws=[];cost=[]
    for rgb in rgbs:
        a=(rgb.astype(np.float32)/255-np.array([.485,.456,.406],np.float32))/np.array([.229,.224,.225],np.float32)
        a=a.transpose(2,0,1)[None].copy();start=time.perf_counter();raw=session.run(None,{name:a})[0].squeeze();cost.append((time.perf_counter()-start)*1000);raws.append(raw)
    flows=[]
    for a,b in zip(rgbs,rgbs[1:]):flows.append(flow_pair(cv2.cvtColor(a,cv2.COLOR_RGB2GRAY),cv2.cvtColor(b,cv2.COLOR_RGB2GRAY)))
    variants=[]
    for variant,tau in [('raw_normalized',0),('fixed',None),('time160',.16),('time320',.32)]:
        f=Filter(tau);maps=[];changes=[];spatial=[]
        for raw,rgb in zip(raws,rgbs):
            if tau==0:
                ordered=np.sort(raw,axis=None);lo,hi=ordered[len(ordered)//20],ordered[len(ordered)*19//20];d=np.clip((raw-lo)/max(hi-lo,1e-5),0,1)
            else:d=f.update(raw,rgb,3/fps)
            maps.append(d);spatial.append(float(np.std(d)*30))
        for i,(flow,c) in enumerate(flows):
            m=c>.35
            if m.any():changes.extend((30*abs(maps[i+1]-remap(maps[i],flow)))[m][::20].tolist())
        variants.append(dict(variant=variant,correspondenceDisparityChange=stats(changes),spatialDisparityStdMean=float(np.mean(spatial))))
    result.append(dict(clip=clip,frames=len(raws),observationsHz=fps/3,modelCpuMs=stats(cost[3:]),variants=variants))
Path(args.out).write_text(json.dumps({'results':result,'limits':'First 96 decoded frames per local clip; one observation per 3 frames, CPU float model. Warp-aligned changes on trusted pixels mix errors with real depth motion; lower is not automatically better. Synthetic dynamic-step metrics must be consulted. No mobile pipeline timing.'},indent=2)+'\n')
