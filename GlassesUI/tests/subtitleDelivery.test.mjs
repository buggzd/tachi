import { resolveI18nImport } from './i18n-test-helper.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { transformWithEsbuild } from 'vite'

const { code } = await transformWithEsbuild(
  await readFile(new URL('../src/jellyfin.ts', import.meta.url), 'utf8'),
  'jellyfin.ts', { target: 'es2022' },
)
const { code: progressCode } = await transformWithEsbuild(
  await readFile(new URL('../src/watchProgress.ts', import.meta.url), 'utf8'),
  'watchProgress.ts', { target: 'es2022' },
)
const progressUrl = `data:text/javascript;base64,${Buffer.from(resolveI18nImport(progressCode)).toString('base64')}`
const isolated = code.replace(/from ["']\.\/watchProgress["']/, `from "${progressUrl}"`).replace(
  /import \{ getNativeHardwareVideoCodecs \} from ["']\.\/runtime["'];?/,
  'const getNativeHardwareVideoCodecs = () => ["h264"]; const window = globalThis; const __APP_VERSION__ = "0.0.0-test";',
)
assert.notEqual(isolated, code)
const { JellyfinClient } = await import(`data:text/javascript;base64,${Buffer.from(resolveI18nImport(isolated)).toString('base64')}`)
const session = {
  serverUrl: 'https://media.example.invalid/jellyfin', accessToken: 'fixture-token',
  userId: 'user', deviceId: 'subtitle-test',
}

function playbackFixture(t, { codec = 'ass', external = false, container = 'mkv', delivery = '/original/Stream.ass', failFallback = false, directUrl, range = 'SDR', audioCodec = 'aac' } = {}) {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body))
    if (failFallback && !requests.at(-1).EnableDirectPlay) return new Response('{}', {status:500})
    return new Response(JSON.stringify({ PlaySessionId: 'play-session', MediaSources: [{
      Id: 'source', Container: container, Bitrate: 5_000_000, SupportsDirectPlay: true, DirectStreamUrl: directUrl,
      TranscodingUrl: '/Videos/item/master.m3u8?SubtitleStreamIndex=4&SubtitleMethod=Encode', DefaultSubtitleStreamIndex: 4,
      MediaAttachments: [{ Index: 6, FileName: 'font.ttf' }, { Index: 7, FileName: 'poster.jpg' }, { Index: -1, FileName: 'bad.otf' }],
      MediaStreams: [
        { Type: 'Video', Index: 0, Codec: 'h264', Width: 1920, Height: 1080, BitDepth: 8, VideoRangeType: range },
        { Type: 'Audio', Index: 1, Codec: audioCodec },
        { Type: 'Subtitle', Index: 4, Codec: codec, IsExternal: external, DeliveryUrl: delivery },
        { Type: 'Subtitle', Index: 5, Codec: 'ssa', DeliveryUrl: '/original/Stream.ssa' },
      ],
    }] }), { headers: { 'Content-Type': 'application/json' } })
  })
  const requests = []
  const client = new JellyfinClient(session)
  return { requests, prepare: (selection = {}, ticks = 0) => client.preparePlayback({ id: 'item', canPlay: true }, ticks, selection) }
}

function expectSubtitle(plan, index, format = 'ass') {
  const url = new URL(plan.subtitleUrl)
  assert.equal(url.pathname, `/jellyfin/Videos/item/source/Subtitles/${index}/Stream.${format}`)
  assert.equal(url.searchParams.get('api_key'), session.accessToken)
  assert.equal(url.searchParams.get('startPositionTicks'), '0')
  assert.equal(url.searchParams.get('copyTimestamps'), 'false')
  assert.equal(url.searchParams.get('addVttTimeMap'), 'false')
  assert.equal(plan.subtitleFormat, format)
  assert.equal(plan.subtitleBurnedIn, false)
  const video = new URL(plan.url)
  assert.equal(video.searchParams.get('SubtitleStreamIndex') ?? video.searchParams.get('subtitleStreamIndex'), '-1')
  assert.notEqual(video.searchParams.get('SubtitleMethod'), 'Encode')
}

test('delivers original ASS to libass and excludes subtitles from the HLS video', async (t) => {
  const { prepare, requests } = playbackFixture(t)
  const plan = await prepare()
  assert.equal(plan.playMethod, 'Transcode')
  expectSubtitle(plan, 4)
  for (const request of requests) {
    assert.deepEqual(request.DeviceProfile.SubtitleProfiles.filter(p => p.Method === 'External').map(p => p.Format), ['ass', 'ssa', 'vtt', 'webvtt'])
    assert.equal(request.AlwaysBurnInSubtitleWhenTranscoding, false)
    assert.equal(request.DeviceProfile.TranscodingProfiles[0].EnableSubtitlesInManifest, false)
  }
  assert.equal(requests[1].SubtitleStreamIndex, -1)
  assert.deepEqual(plan.subtitleFontUrls.map(url => new URL(url).pathname), ['/jellyfin/Videos/item/source/Attachments/6'])
})

test('delivers external SSA as ASS while preserving direct video playback', async (t) => {
  const { prepare } = playbackFixture(t, { codec: 'ssa', external: true, container: 'mp4', delivery: 'https://media.example.invalid/raw.ssa' })
  const plan = await prepare()
  assert.equal(plan.playMethod, 'DirectPlay')
  expectSubtitle(plan, 4)
})

test('switching subtitle tracks at a resume position requests the selected track on the full media timeline', async (t) => {
  const { prepare } = playbackFixture(t)
  expectSubtitle(await prepare(), 4)
  const plan = await prepare({ subtitleStreamIndex: 5 }, 3_000_000_000)
  expectSubtitle(plan, 5)
  assert.equal(plan.startPositionTicks, 3_000_000_000)
  assert.equal(plan.subtitleStreamIndex, 5)
  const disabled = await prepare({ subtitleStreamIndex: -1 })
  assert.equal(disabled.subtitleUrl, undefined)
  assert.equal(disabled.subtitleStreamIndex, -1)
  assert.equal(disabled.subtitleFormat, undefined)
  assert.equal(disabled.subtitleFontUrls, undefined)
})

for (const codec of ['srt', 'subrip', 'vtt', 'webvtt', 'mov_text']) {
  test(`${codec} text subtitles use the same WebVTT delivery with or without a server URL`, async (t) => {
    const { prepare } = playbackFixture(t, { codec, delivery: codec === 'mov_text' ? null : `/original/Stream.${codec}` })
    const plan = await prepare()
    expectSubtitle(plan, 4, 'vtt')
    assert.equal(plan.subtitleFontUrls, undefined)
  })
}

test('bitmap subtitles still request burn-in and have no local text URL', async (t) => {
  const { prepare, requests } = playbackFixture(t, { codec: 'pgssub', container: 'mp4' })
  const plan = await prepare()
  assert.equal(plan.playMethod, 'Transcode')
  assert.equal(plan.subtitleBurnedIn, true)
  assert.equal(plan.subtitleUrl, undefined)
  assert.equal(requests[1].AlwaysBurnInSubtitleWhenTranscoding, true)
  assert.ok(requests[1].DeviceProfile.SubtitleProfiles.some(p => p.Format === 'pgssub' && p.Method === 'Encode'))
})


test('a failed fallback negotiation cannot reuse a server burn-in URL for local ASS', async (t) => {
  const { prepare } = playbackFixture(t, { failFallback: true })
  expectSubtitle(await prepare(), 4)
})

test('server direct URLs also clear case-insensitive subtitle selection for local ASS', async (t) => {
  const { prepare } = playbackFixture(t, { container: 'mp4', directUrl: '/Videos/item/stream.mp4?subtitleStreamIndex=4&subtitleMethod=Encode' })
  const plan = await prepare()
  expectSubtitle(plan, 4)
  assert.equal(new URL(plan.url).searchParams.has('subtitleMethod'), false)
})

function nativeBridge(t) {
  const previous = globalThis.RayNeoGlasses
  globalThis.RayNeoGlasses = { nativePlaybackAvailable: () => true, getNativeAudioCodecs: () => '["aac","opus"]' }
  t.after(() => { if (previous) globalThis.RayNeoGlasses = previous; else delete globalThis.RayNeoGlasses })
}

test('native MKV direct play preserves authored ASS and advertises native containers', async t => {
  nativeBridge(t)
  const fixture = playbackFixture(t, {container:'mkv'})
  const plan = await fixture.prepare()
  assert.equal(plan.playMethod, 'DirectPlay')
  assert.match(new URL(plan.url).pathname, /stream\.mkv$/)
  assert.equal(plan.subtitleFormat, 'ass')
  assert.ok(fixture.requests[0].DeviceProfile.DirectPlayProfiles.some(profile => profile.Container === 'mkv'))
})

test('native RGBA output sends HDR and unavailable audio decoders to the server fallback', async t => {
  nativeBridge(t)
  const hdr = playbackFixture(t, {range:'HDR10'})
  assert.equal((await hdr.prepare()).playMethod, 'Transcode')
  const audio = playbackFixture(t, {audioCodec:'truehd'})
  assert.equal((await audio.prepare()).playMethod, 'Transcode')
})
