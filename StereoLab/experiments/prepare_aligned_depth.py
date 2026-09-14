"""Add mesh-only same-frame 392 depth from existing actual float inference caches."""
import hashlib
import json
from pathlib import Path
import numpy as np

LOCAL = Path(__file__).resolve().parents[1] / '.local'
PROFILE = dict(id='p4', label='392×224 · 严格同帧 · 无历史融合 / 范围平滑',
               width=392, height=224, stride=1, delay=0)

def main():
    for dataset in ['quality-p02-p98', 'quality-motion']:
        folder = LOCAL / 'samples' / dataset
        manifest = json.loads((folder / 'manifest.json').read_text())
        clips = []
        for clip in manifest['clips']:
            frames = clip.get('frames', manifest['frames'])
            model = clip['models']['392']['sha256']
            cache = LOCAL / 'quality-cache' / f'{clip["sourceSha256"][:12]}-{model[:12]}-{frames}.npz'
            with np.load(cache) as cached:
                raw = cached['raw']
                if raw.shape != (frames,224,392) or not np.isfinite(raw).all():
                    raise ValueError('Invalid cached model output')
                flat = raw.reshape(frames,-1)
                ranks = [flat.shape[1]*2//100,flat.shape[1]*98//100]
                selected = np.partition(flat,ranks,axis=1)
                lo,hi = selected[:,ranks[0]],selected[:,ranks[1]]
                if np.any(hi-lo<=1e-6):
                    raise ValueError('Degenerate depth range')
                normalized = np.clip((raw-lo[:,None,None])/(hi-lo)[:,None,None],0,1)
                maps = np.floor(normalized*255+.5).astype(np.uint8)
            file = folder / f'clip-{clip["id"]}-p4.bin'
            file.write_bytes(maps.tobytes())
            clips.append(dict(sourceSha256=clip['sourceSha256'],data=dict(
                url=f'/samples/{dataset}/{file.name}',count=frames,
                sha256=hashlib.sha256(file.read_bytes()).hexdigest())))
        (folder/'aligned.json').write_text(json.dumps(dict(profile=PROFILE,clips=clips,
            normalization='Independent exact P2/P98 ranks per frame; no pixel history or range EMA. Offline float model, not mobile latency.'),indent=2)+'\n')
        print(dataset, 'aligned clips:',len(clips))

if __name__=='__main__':
    main()
