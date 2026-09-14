"""Build only the isolated MIT rendering extension; never runs upstream setup/app."""
import hashlib
import json
from pathlib import Path
import subprocess
import sysconfig
import pybind11

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'vendor/qinglong-quality'
OUT = ROOT / '.local/quality-core'
OUT.mkdir(parents=True, exist_ok=True)
for rel, expected in json.loads((VENDOR / 'SOURCE_HASHES.json').read_text()).items():
    if hashlib.sha256((VENDOR / rel).read_bytes()).hexdigest() != expected:
        raise RuntimeError(f'Reference source changed: {rel}')
source = VENDOR / 'native/quality_kd_native.cpp'
sha = hashlib.sha256(source.read_bytes()).hexdigest()
(OUT / 'quality_kd_build_identity.h').write_text(f'#define QUALITY_KD_SOURCE_SHA256 "{sha}"\n')
output = OUT / ('_quality_kd_native' + sysconfig.get_config_var('EXT_SUFFIX'))
subprocess.run(['c++', '-O2', '-std=c++17', '-shared', '-fPIC', '-undefined', 'dynamic_lookup',
                '-I'+pybind11.get_include(), '-I'+sysconfig.get_path('include'), '-I'+str(OUT),
                str(source), '-o', str(output)], check=True)
print('Built isolated Quality extension')
