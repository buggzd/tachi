import { defineConfig } from 'vite';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export default defineConfig({
    server: { host: '127.0.0.1', port: 4188, strictPort: true },
    worker: { format: 'es' },
    build: { rollupOptions: { input: {
        main: resolve(import.meta.dirname, 'index.html'),
        quality: resolve(import.meta.dirname, 'quality-trials.html'),
        mesh: resolve(import.meta.dirname, 'mesh-trials.html'),
        fullQuality: resolve(import.meta.dirname, 'full-quality-trials.html'),
    } } },
    plugins: [{
        name: 'local-stereo-assets',
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                const pathname = new URL(req.url, 'http://localhost').pathname;
                const prefix = pathname.startsWith('/models/') ? 'models' : pathname.startsWith('/samples/') ? 'samples' : null;
                if (!prefix) { next(); return; }
                const root = resolve(import.meta.dirname, '.local', prefix);
                let path;
                try { path = resolve(root, decodeURIComponent(pathname.slice(prefix.length + 2))); } catch { res.writeHead(400).end(); return; }
                if (!path.startsWith(root + sep) || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404).end(); return; }
                try {
                    const info = await stat(path);
                    if (!info.isFile()) throw new Error();
                    const type = path.endsWith('.json') ? 'application/json' : path.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream';
                    let start = 0, end = info.size - 1, status = 200;
                    if (req.headers.range) {
                        const m = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
                        if (!m || Number(m[1]) >= info.size || (m[2] && Number(m[2]) < Number(m[1]))) { res.writeHead(416).end(); return; }
                        start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), end) : end; status = 206;
                    }
                    res.writeHead(status, { 'Content-Type': type, 'Content-Length': end - start + 1,
                        'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
                        ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}) });
                    if (req.method === 'HEAD') res.end();
                    else createReadStream(path, { start, end }).on('error', () => res.destroy()).pipe(res);
                } catch { res.writeHead(404).end(); }
            });
        },
    }],
});
