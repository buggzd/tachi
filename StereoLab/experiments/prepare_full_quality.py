"""Isolated full upstream Quality path + experimental temporal background repair.
Uses existing 2/98 normalized depth. Does not run upstream app or inference.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
import subprocess
import cv2
import numpy as np

LAB=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(LAB/'vendor/qinglong-quality'),str(LAB/'.local/quality-core')]
import torch
from depth_surge_3d.rendering.stereo_renderer import StereoRenderer, StereoRenderSettings
from depth_surge_3d.rendering.quality.renderer import (prepare_relative_quality_frame,
    render_prepared_relative_quality_compact, _render_unrepaired_eye_once, _build_eye_offsets)
from temporal_background import background_registration, fill_from_frames, original_gather


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--frames',type=int,default=96);parser.add_argument('--clips',type=int,default=3)
    args=parser.parse_args();cv2.setNumThreads(2);torch.set_num_threads(4)
    source_manifest=LAB/'.local/samples/quality-p02-p98/manifest.json'
    manifest=json.loads(source_manifest.read_text());out=LAB/'.local/samples/full-quality';out.mkdir(exist_ok=True)
    cache=LAB/'.local/full-quality-cache'/hashlib.sha256((sha(source_manifest)+sha(LAB/'vendor/qinglong-quality/SOURCE_HASHES.json')).encode()).hexdigest()[:16];cache.mkdir(parents=True,exist_ok=True)
    settings=StereoRenderSettings(stereo_strength=3.2, convergence=.5, stereo_render_mode='quality')
    renderer=StereoRenderer('cpu',temporary_budget_bytes=128*1024*1024)
    report={'schema':1,'width':1920,'height':1080,'strength':1,'depth':'p2, 392x224, 2/98, half rate + two-frame delay',
            'sourceManifestSha256':sha(source_manifest),'coreHashesSha256':sha(LAB/'vendor/qinglong-quality/SOURCE_HASHES.json'),
            'limits':'Offline CPU Quality renderer; temporal repair uses DIS-derived robust affine background motion, +/-1 and +/-3 frames. No phone timing claim. Untrusted matches rejected; fallback is full Quality.', 'clips':[]}
    for clip in range(args.clips):
        info=manifest['clips'][clip];profile=next(p for p in manifest['profiles'] if p['id']=='p2')
        maps=np.fromfile(LAB/'.local'/info['data']['p2']['url'].removeprefix('/'),np.uint8).reshape(-1,224,392)
        cap=cv2.VideoCapture(str(LAB/'.local'/info['source'].removeprefix('/')));frames=[]
        for i in range(args.frames):
            ok,image=cap.read()
            if not ok:break
            frames.append(cv2.resize(image,(1920,1080)))
        cap.release();depths=[maps[max(0,min(len(maps)-1,(i-2)//2))].astype(np.float32)/255 for i in range(len(frames))]
        clipcache=cache/str(clip);clipcache.mkdir(exist_ok=True)
        timings=[]
        for i,(image,depth) in enumerate(zip(frames,depths)):
            path=clipcache/f'{i:04}.npz'
            if path.exists():continue
            start=time.perf_counter()
            prepared=prepare_relative_quality_frame(frame=image,canonical=depth,settings=settings)
            result=render_prepared_relative_quality_compact(renderer=renderer,prepared=prepared)
            pre=[]
            for eye in ['left','right']:
                raw=_render_unrepaired_eye_once(renderer=renderer,source=image,geometry=prepared.geometry,
                    offsets=_build_eye_offsets(prepared.geometry,settings,eye),band_height=24)
                pre.append(raw.image)
            np.savez_compressed(path,left=result.left_image,right=result.right_image,
                lc=result.left_coverage_count,rc=result.right_coverage_count,lp=pre[0],rp=pre[1])
            timings.append(time.perf_counter()-start)
            print(f'clip {clip+1} Quality frame {i+1}/{len(frames)} {timings[-1]:.2f}s',flush=True)
        writers={}
        for name in ['original','quality','temporal','provenance','holes']:
            writers[name]=subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','bgr24',
                '-video_size','3840x1080','-framerate',str(info['fps']),'-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','16','-pix_fmt','yuv420p',
                '-movflags','+faststart',str(out/f'clip-{clip}-{name}.mp4')],stdin=subprocess.PIPE)
        stats=[]
        for i,image in enumerate(frames):
            donors=[]
            for offset in [1,-1,3,-3]:
                j=i+offset
                if j<0 or j>=len(frames):continue
                matrix=background_registration(image,frames[j],depths[i],depths[j])
                donors.append((offset,frames[j],depths[j],matrix))
            with np.load(clipcache/f'{i:04}.npz') as data:
                eyes={n:[] for n in writers};record={'frame':i,'acceptedRegistrations':[d[0] for d in donors if d[3] is not None]}
                for label,sign in [('l',1),('r',-1)]:
                    quality=data['left' if sign==1 else 'right'];coverage=data[label+'c'];pre=data[label+'p']
                    temporal,origin=fill_from_frames(pre,coverage,quality,depths[i],donors,sign)
                    mask=np.zeros_like(quality);mask[coverage<16]=(180,0,180);mask[origin>0]=(0,220,0);mask[origin<0]=(220,160,0)
                    holes=np.clip(pre.astype(float)+(1-coverage[...,None]/16)*np.array([180,0,180]),0,255).astype(np.uint8)
                    for n,value in [('original',original_gather(image,depths[i],sign)),('quality',quality),('temporal',temporal),('provenance',mask),('holes',holes)]:eyes[n].append(value)
                    record[label]={'missing':int(np.count_nonzero(coverage<16)),'future':int(np.count_nonzero(origin>0)),'past':int(np.count_nonzero(origin<0))}
                stats.append(record)
                for name,writer in writers.items():writer.stdin.write(np.concatenate(eyes[name],axis=1).tobytes())
            if i%12==0:print(f'clip {clip+1} temporal {i+1}/{len(frames)}',flush=True)
        for writer in writers.values():
            writer.stdin.close()
            if writer.wait()!=0:raise RuntimeError('video encoding failed')
        report['clips'].append({'fps':info['fps'],'frames':len(frames),'duration':len(frames)/info['fps'],
            'videos':{n:f'/samples/full-quality/clip-{clip}-{n}.mp4' for n in writers},'stats':stats,'qualityFrameSeconds':timings})
        (out/'manifest.json').write_text(json.dumps(report,indent=2)+'\n')
    print('Full Quality preview ready',flush=True)

if __name__=='__main__':main()
