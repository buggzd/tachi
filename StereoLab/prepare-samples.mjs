/** Download bounded local excerpts. Credentials stay in memory; FFmpeg receives
 * only an ephemeral loopback URL. Never writes playback/watch-state reports. */
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
const exec = promisify(execFile), root = import.meta.dirname;
const args = process.argv.slice(2);
const number = (key, fallback, min, max) => {
    const i = args.indexOf(key), value = i < 0 ? fallback : Number(args[i + 1]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error('Invalid sample option');
    return value;
};
let server, session, base;
try {
    const duration = number('--seconds', 20, 5, 120), offset = number('--offset', 120, 0, 3600);
    const count = number('--count', 3, 1, 5);
    if (!Number.isInteger(count)) throw new Error('Invalid sample count');
    const common = (await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root })).stdout.trim();
    const paths = process.env.RAYNEO_JELLYFIN_DEV_CONFIG
        ? [resolve(process.env.RAYNEO_JELLYFIN_DEV_CONFIG)]
        : [resolve(root, '../.jellyfin-dev.json'), resolve(common, '../.jellyfin-dev.json')];
    let config;
    for (const path of paths) { try { config = JSON.parse(await readFile(path, 'utf8')); break; } catch {} }
    if (!config) throw new Error('Development configuration unavailable');
    const url = new URL(config.serverUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid server');
    base = config.serverUrl.replace(/\/+$/, '');
    const auth = 'MediaBrowser Client="tachi-stereo-lab", Device="Desktop feasibility", DeviceId="tachi-stereo-lab", Version="1"';
    async function request(path, options = {}) {
        const r = await fetch(base + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000),
            headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': auth,
                ...(session ? { 'X-Emby-Token': session.AccessToken } : {}), ...options.headers } });
        if (!r.ok) throw new Error('Jellyfin request failed');
        return r;
    }
    session = await (await request('/Users/AuthenticateByName', { method: 'POST', body: JSON.stringify({ Username: config.username, Pw: config.password }) })).json();
    config = null;
    if (!/^[a-f0-9]{32}$/i.test(session.User?.Id) || typeof session.AccessToken !== 'string') throw new Error('Invalid session');
    const list = await (await request(`/Users/${session.User.Id}/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Fields=MediaSources,MediaStreams&Limit=100&SortBy=DateCreated&SortOrder=Descending`)).json();
    const candidates = (list.Items || []).filter(x => /^[a-f0-9]{32}$/i.test(x.Id) && x.RunTimeTicks > (offset + duration) * 1e7);
    if (!candidates.length) throw new Error('No suitable video');
    // Spread excerpts across the returned catalog instead of selecting adjacent episodes only.
    const selected = Array.from({ length: Math.min(count, candidates.length) }, (_, i) => candidates[Math.floor(i * candidates.length / Math.min(count, candidates.length))]);
    const route = '/' + randomUUID();
    server = createServer(async (req, res) => {
        const match = req.url?.match(new RegExp('^' + route + '/([0-4])$'));
        if (!match || !selected[Number(match[1])] || !['GET', 'HEAD'].includes(req.method) || req.headers.origin) { res.writeHead(404).end(); return; }
        const range = req.headers.range;
        if (range && !/^bytes=\d+-\d*$/.test(range)) { res.writeHead(416).end(); return; }
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        try {
            const upstream = await fetch(base + `/Videos/${selected[Number(match[1])].Id}/stream?Static=true`, {
                redirect: 'error', method: req.method, signal: abort.signal,
                headers: { 'X-Emby-Token': session.AccessToken, ...(range ? { Range: range } : {}) },
            });
            const headers = { 'Cache-Control': 'no-store' };
            for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges'])
                if (upstream.headers.has(key)) headers[key] = upstream.headers.get(key);
            res.writeHead(upstream.status, headers);
            if (upstream.body) Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
            else res.end();
        } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const dir = resolve(root, '.local/samples'); await mkdir(dir, { recursive: true });
    const manifest = [];
    for (let i = 0; i < selected.length; i++) {
        const file = `clip-${i}.mp4`, target = resolve(dir, file);
        await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(offset),
            '-i', `http://127.0.0.1:${server.address().port}${route}/${i}`, '-t', String(duration),
            '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=w=min(1920\\,iw):h=min(1080\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', target],
        { timeout: 240000, maxBuffer: 1024 * 1024 });
        const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
            'stream=width,height,r_frame_rate,nb_frames,codec_name:format=duration', '-of', 'json', target])).stdout);
        const v = probe.streams[0];
        manifest.push({ label: `Sample ${i + 1}`, file, width: v.width, height: v.height, fps: v.r_frame_rate,
            frames: Number(v.nb_frames), seconds: Number(probe.format.duration), bytes: (await stat(target)).size });
        console.log(JSON.stringify(manifest.at(-1)));
    }
    await writeFile(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
} catch {
    console.error('Sample preparation failed. Check local configuration, connectivity, and FFmpeg. Private upstream output was suppressed.');
    process.exitCode = 1;
} finally {
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    if (session && base) await fetch(base + '/Sessions/Logout', { method: 'POST', headers: { 'X-Emby-Token': session.AccessToken }, signal: AbortSignal.timeout(5000) }).catch(() => {});
}
