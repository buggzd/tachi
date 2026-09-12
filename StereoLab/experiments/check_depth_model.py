"""Static-shape and CPU QDQ smoke check; deliberately makes no QNN device claim."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import onnx
import onnxruntime as ort
from PIL import Image

p=argparse.ArgumentParser()
p.add_argument('--model', type=Path, required=True)
p.add_argument('--calibration', type=Path, required=True)
p.add_argument('--width', type=int, required=True)
p.add_argument('--height', type=int, required=True)
p.add_argument('--out', type=Path, required=True)
args=p.parse_args()
model=onnx.load(args.model); onnx.checker.check_model(model)
image_path=sorted(args.calibration.glob('*.png'))[0]
with Image.open(image_path) as image:
    a=np.asarray(image.convert('RGB').resize((args.width,args.height),Image.Resampling.BILINEAR),dtype=np.float32)
a=(a/255-np.array([.485,.456,.406],np.float32))/np.array([.229,.224,.225],np.float32)
options=ort.SessionOptions();options.intra_op_num_threads=4
session=ort.InferenceSession(str(args.model),options,providers=['CPUExecutionProvider'])
assert session.get_inputs()[0].shape==[1,3,args.height,args.width]
d=session.run(None,{session.get_inputs()[0].name:a.transpose(2,0,1)[None].copy()})[0]
assert d.shape==(1,args.height,args.width) and np.isfinite(d).all() and d.max()>d.min()
result=dict(modelSha256=hashlib.sha256(args.model.read_bytes()).hexdigest(),
    calibrationImageSha256=hashlib.sha256(image_path.read_bytes()).hexdigest(),
    inputShape=session.get_inputs()[0].shape,outputShape=list(d.shape),finite=True,
    minimum=float(d.min()),maximum=float(d.max()),checker=True,provider='CPUExecutionProvider',
    onnxruntime=ort.__version__,opsets={v.domain:v.version for v in model.opset_import},deviceValidated=False,
    limits='One calibration frame smoke check; CPU QDQ execution does not prove Android QNN graph placement, accuracy or latency.')
args.out.write_text(json.dumps(result,indent=2)+'\n')
print('Static shape, ONNX checker and CPU QDQ smoke check passed')
