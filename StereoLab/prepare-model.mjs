import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const repository = 'onnx-community/depth-anything-v2-small';
const revision = '4472b7362082ad9968fee890ca0f1e5aca36b93d';
const directory = resolve(import.meta.dirname, '.local/models/depth-anything-v2-small');
const files = ['config.json', 'preprocessor_config.json', 'README.md', 'onnx/model.onnx', 'onnx/model_fp16.onnx'];
const expected = {
    'config.json': '3aee5b9bc4f711ee885c2526d871f0c8c6c8c4b26b8e04253d0167f6a83264f5',
    'preprocessor_config.json': '03576db3c13dd0471fdf5f5e1428befcb95de063fe699879150b293dc9e0a2c6',
    'README.md': '2fdd0db4eb5d7725fe0f1522e03a63f0b3c7dc93c805669f3322f665fb3b4c86',
    'onnx/model.onnx': 'afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c',
    'onnx/model_fp16.onnx': '2df6223f206b5164e21f664ace61dabeb9bb6a49b8b5a3e00510b4807d0f5b04',
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
try {
    // curl does not automatically use macOS PAC settings. Read only the system's
    // configured proxy; never persist/print proxy addresses or authentication.
    let proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (!proxy && process.platform === 'darwin') {
        try {
            const settings = (await exec('scutil', ['--proxy'])).stdout;
            const pac = settings.match(/ProxyAutoConfigURLString\s*:\s*(\S+)/)?.[1];
            if (pac) {
                const text = await (await fetch(pac, { signal: AbortSignal.timeout(5000) })).text();
                const match = text.match(/(SOCKS5|PROXY)\s+([^;"\s]+)/);
                if (match) proxy = (match[1] === 'SOCKS5' ? 'socks5h://' : 'http://') + match[2];
            }
        } catch {}
    }
    await mkdir(resolve(directory, 'onnx'), { recursive: true });
    let old = {};
    try { old = JSON.parse(await readFile(resolve(directory, 'provenance.json'), 'utf8')); } catch {}
    const hashes = {};
    for (const file of files) {
        const path = resolve(directory, file);
        let cached = false;
        try { cached = old.revision === revision && expected[file] === digest(await readFile(path)); } catch {}
        if (!cached) {
            await exec('curl', ['--fail', '--silent', '--location', '--retry', '2', '--max-time', '300',
                ...(proxy ? ['--proxy', proxy] : []), '--output', path + '.part',
                `https://huggingface.co/${repository}/resolve/${revision}/${file}`], { timeout: 930000, maxBuffer: 1024 });
            const size = (await stat(path + '.part')).size;
            if (size < 2 || size > 512 * 1024 * 1024) throw new Error('Invalid model size');
            await rename(path + '.part', path);
        }
        hashes[file] = digest(await readFile(path));
        if (hashes[file] !== expected[file]) throw new Error('Model checksum mismatch');
        console.log(JSON.stringify({ file, bytes: (await stat(path)).size, sha256: hashes[file], cached }));
    }
    await writeFile(resolve(directory, 'provenance.json'), JSON.stringify({ repository, revision, sha256: hashes }, null, 2) + '\n');
} catch {
    console.error('Model preparation failed. Check network/proxy configuration. Private proxy output was suppressed.');
    process.exitCode = 1;
}
