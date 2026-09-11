"""ORT CPU/CoreML CPU+ANE eligibility probe. CoreML EP != verified ANE placement."""
import json,time,hashlib,platform,argparse
from pathlib import Path
import numpy as np
from PIL import Image
import onnxruntime as ort
ROOT=Path(__file__).resolve().parents[1]

def stats(a):return {'mean':float(np.mean(a)),'p95':float(np.percentile(a,95)),'n':len(a)}

p=argparse.ArgumentParser();p.add_argument('--out',required=True);args=p.parse_args()
model=ROOT/'.local/npu/depth-anything-v2-small-fixed-266.onnx'
inputs=[]
for path in sorted((ROOT/'.local/npu/calib').glob('*.png'))[:6]:
    rgb=np.asarray(Image.open(path).convert('RGB').resize((266,154)),dtype=np.float32)/255
    rgb=(rgb-np.array([.485,.456,.406],np.float32))/np.array([.229,.224,.225],np.float32)
    inputs.append(rgb.transpose(2,0,1)[None].copy())
assert inputs
out={'ort':ort.__version__,'platform':platform.platform(),'modelSha256':hashlib.sha256(model.read_bytes()).hexdigest(),'availableProviders':ort.get_available_providers(),'limits':'ORT CoreML CPUAndNeuralEngine excludes GPU but permits CPU inside CoreML. EP profiling cannot prove ANE hardware placement. No QNN INT8 claim. Tensor input prepared before timing.','results':[]}
reference=None
for variant,providers in [('cpu',['CPUExecutionProvider']),('coreml_cpu_ane',[('CoreMLExecutionProvider',{'ModelFormat':'MLProgram','MLComputeUnits':'CPUAndNeuralEngine','RequireStaticInputShapes':'1'}),'CPUExecutionProvider'])]:
    opt=ort.SessionOptions();opt.intra_op_num_threads=4;opt.enable_profiling=True
    opt.profile_file_prefix=str(ROOT/'.local/npu/coreml-probe')
    start=time.perf_counter()
    try:
        session=ort.InferenceSession(str(model),opt,providers=providers)
        init=(time.perf_counter()-start)*1000
        name=session.get_inputs()[0].name
        for a in inputs[:3]:session.run(None,{name:a})
        times=[];values=[]
        for i in range(18):
            start=time.perf_counter();value=session.run(None,{name:inputs[i%len(inputs)]})[0];times.append((time.perf_counter()-start)*1000)
            if i<len(inputs):values.append(value)
        profile=json.loads(Path(session.end_profiling()).read_text());counts={}
        for event in profile:
            provider=event.get('args',{}).get('provider')
            if provider:counts[provider]=counts.get(provider,0)+1
        if reference is None:reference=values
        errors=[]
        for a,b in zip(values,reference):
            scale=max(1e-6,float(np.percentile(b,95)-np.percentile(b,5)))
            errors.append(float(np.mean(np.abs(a-b))/scale))
        out['results'].append(dict(variant=variant,initMs=init,runMs=stats(times),providers=session.get_providers(),profileNodeEvents=counts,relativeOutputMAE=stats(errors)))
        del session
    except Exception as e:
        out['results'].append(dict(variant=variant,errorType=type(e).__name__))
    Path(args.out).write_text(json.dumps(out,indent=2)+'\n');print(variant,flush=True)
