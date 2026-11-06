import { resolveI18nImport } from './i18n-test-helper.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { transformWithEsbuild } from 'vite'
import vm from 'node:vm'
import ts from 'typescript'
import * as i18n from '../../SharedUI/i18n.mjs'
import * as themes from '../../SharedUI/theme.mjs'
import * as subtitles from '../../SharedUI/subtitles.mjs'

const moduleUrl = async (name, replace = value => value) => {
  const { code } = await transformWithEsbuild(await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), `${name}.ts`, { target: 'es2022' })
  return `data:text/javascript;base64,${Buffer.from(resolveI18nImport(replace(code))).toString('base64')}`
}
const progressUrl = await moduleUrl('watchProgress')
const { JellyfinClient } = await import(await moduleUrl('jellyfin', code => code
  .replace(/from ["']\.\/watchProgress["']/, `from "${progressUrl}"`)
  .replace(/import \{ getNativeHardwareVideoCodecs \} from ["']\.\/runtime["'];?/, 'const getNativeHardwareVideoCodecs = () => ["h264"]; const window = globalThis; const __APP_VERSION__ = "0.0.0-test";')))

const session = {
  serverUrl: 'https://media.example.invalid/jellyfin', accessToken: 'fixture-token',
  userId: 'fixture-user', deviceId: 'fixture-device',
}

function assertModernAuthorization(init, authenticated = true) {
  const headers = new Headers(init.headers)
  assert.match(headers.get('Authorization'), /^MediaBrowser Client="tachi", /)
  assert.match(headers.get('Authorization'), /DeviceId="[^"]+", Version="0\.0\.0-test"/)
  if (authenticated) assert.match(headers.get('Authorization'), /Token="fixture-token"/)
  else assert.doesNotMatch(headers.get('Authorization'), /Token=/)
  assert.equal(headers.has('X-Emby-Token'), false)
  assert.equal(headers.has('X-Emby-Authorization'), false)
}

function assertModernMediaUrl(value) {
  const url = new URL(value)
  assert.equal(url.origin, 'https://media.example.invalid')
  assert.ok(url.pathname.startsWith('/jellyfin/'))
  assert.deepEqual([...url.searchParams].filter(([key]) => /api_?key|x-emby-token|x-mediabrowser-token/i.test(key)), [['ApiKey', session.accessToken]])
  return url
}

test('catalog requests authenticate when legacy headers are disabled without forgetting the session', async t => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async (value, init) => {
    count++
    assertModernAuthorization(init)
    assert.equal(new URL(value).pathname, '/jellyfin/Users/fixture-user/Items')
    assert.equal(new URL(value).searchParams.has('ApiKey'), false)
    return Response.json({ Items: [{ Id: 'film', Name: 'Film', Type: 'Movie' }] })
  })
  const client = new JellyfinClient(session, () => assert.fail('Valid credentials must not clear the account'))
  assert.equal((await client.loadFolder({ id: 'library' }))[0].id, 'film')
  assert.equal(count, 1)
})

test('poster, backdrop and logo URLs use the supported media credential parameter', () => {
  const client = new JellyfinClient(session)
  const item = client.mapItem({ Id: 'film', Type: 'Movie', ImageTags: { Primary: 'poster', Logo: 'logo' }, BackdropImageTags: ['background'] })
  for (const url of [item.imageUrl, item.coverUrl, item.backdropUrl, item.logoUrl]) assertModernMediaUrl(url)
})

function playbackFixture(t, { directUrl, transcodeUrl = '/Videos/film/master.m3u8?api_key=stale&ApiKey=also-stale', subtitleCodec = 'ass', serverUrl = session.serverUrl, forceTranscode = false } = {}) {
  t.mock.method(globalThis, 'fetch', async (_value, init) => {
    assertModernAuthorization(init)
    return Response.json({ PlaySessionId: 'fixture-playback', MediaSources: [{
      Id: 'source', Container: 'mp4', Bitrate: 5_000_000, SupportsDirectPlay: true, DirectStreamUrl: directUrl,
      TranscodingUrl: transcodeUrl, DefaultSubtitleStreamIndex: 2,
      MediaAttachments: [{ Index: 3, FileName: 'fixture.ttf' }],
      MediaStreams: [
        { Type: 'Video', Index: 0, Codec: 'h264', Width: 1920, Height: 1080, BitDepth: 8 },
        { Type: 'Audio', Index: 1, Codec: 'aac' },
        { Type: 'Subtitle', Index: 2, Codec: subtitleCodec },
      ],
    }] })
  })
  return new JellyfinClient({ ...session, serverUrl }).preparePlayback({ id: 'film', canPlay: true }, 0, { forceTranscode })
}

test('direct video, HLS fallback, original ASS and attached fonts all carry current media credentials', async t => {
  const plan = await playbackFixture(t)
  assert.equal(plan.playMethod, 'DirectPlay')
  assertModernMediaUrl(plan.url)
  assert.equal(assertModernMediaUrl(plan.fallback.url).pathname, '/jellyfin/Videos/film/master.m3u8')
  assert.equal(assertModernMediaUrl(plan.subtitleUrl).pathname, '/jellyfin/Videos/film/source/Subtitles/2/Stream.ass')
  assert.equal(assertModernMediaUrl(plan.subtitleFontUrls[0]).pathname, '/jellyfin/Videos/film/source/Attachments/3')
})

test('WebVTT delivery uses supported media authentication too', async t => {
  const plan = await playbackFixture(t, { subtitleCodec: 'srt' })
  assert.equal(assertModernMediaUrl(plan.subtitleUrl).pathname, '/jellyfin/Videos/film/source/Subtitles/2/Stream.vtt')
})

for (const path of [
  'Videos/film/stream.mp4',
  '/Videos/film/stream.mp4',
  '/jellyfin/Videos/film/stream.mp4',
  '//media.example.invalid/jellyfin/Videos/film/stream.mp4',
  'https://media.example.invalid/jellyfin/Videos/film/stream.mp4',
]) {
  test(`refreshes supplied media credentials and preserves the server base path: ${path}`, async t => {
    const plan = await playbackFixture(t, { directUrl: `${path}?api_key=old&API_KEY=older&apiKey=oldest&X-Emby-Token=obsolete&X-MediaBrowser-Token=obsolete&static=true` })
    const url = assertModernMediaUrl(plan.url)
    assert.equal(url.pathname, '/jellyfin/Videos/film/stream.mp4')
    assert.equal(url.searchParams.get('static'), 'true')
  })
}

test('servers installed at the origin root retain unprefixed playback paths', async t => {
  const plan = await playbackFixture(t, { serverUrl: 'https://media.example.invalid', directUrl: '/Videos/film/stream.mp4?api_key=old' })
  assert.equal(new URL(plan.url).pathname, '/Videos/film/stream.mp4')
  assert.equal(new URL(plan.fallback.url).pathname, '/Videos/film/master.m3u8')
  assert.equal(new URL(plan.url).searchParams.get('ApiKey'), session.accessToken)
  assert.equal(new URL(plan.url).searchParams.has('api_key'), false)
})

for (const path of [
  'https://other.example.invalid/Videos/film/stream.mp4',
  '//other.example.invalid/jellyfin/Videos/film/stream.mp4',
  'https://media.example.invalid/outside/stream.mp4',
  'https://media.example.invalid/jellyfin-other/stream.mp4',
  'http://media.example.invalid/jellyfin/Videos/film/stream.mp4',
  'https://name:password@media.example.invalid/jellyfin/Videos/film/stream.mp4',
  '../Videos/film/stream.mp4',
  '/Videos/%2e%2e/%2e%2e/outside/stream.mp4',
]) {
  test(`rejects a supplied playback URL outside the authenticated server boundary: ${path}`, async t => {
    await assert.rejects(playbackFixture(t, { directUrl: path }), error => error.code === 'response'
      && !error.message.includes(session.accessToken) && !error.message.includes(path))
  })
}

for (const [kind, path] of [
  ['cross-origin', 'https://other.example.invalid/Videos/film/master.m3u8?api_key=private'],
  ['outside the installation path', 'https://media.example.invalid/other/master.m3u8?api_key=private'],
  ['backslash', '/Videos\\film/master.m3u8?api_key=private'],
  ['encoded slash', '/Videos%2ffilm/master.m3u8?api_key=private'],
  ['encoded backslash', '/Videos%5cfilm/master.m3u8?api_key=private'],
  ['malformed URL', 'https://[invalid-host]/master.m3u8?api_key=private'],
]) {
  const isSafeResponseError = error => error.code === 'response'
    && error.message === 'Jellyfin 已响应，但返回的数据格式无法解析。'

  test(`valid direct playback survives an unavailable ${kind} HLS fallback`, async t => {
    const plan = await playbackFixture(t, { directUrl: '/Videos/film/stream.mp4', transcodeUrl: path })
    assert.equal(plan.playMethod, 'DirectPlay')
    assertModernMediaUrl(plan.url)
    assert.equal(plan.fallback, undefined)
  })

  test(`required transcoding rejects a ${kind} URL with a fixed safe error`, async t => {
    await assert.rejects(playbackFixture(t, { transcodeUrl: path, forceTranscode: true }), isSafeResponseError)
  })

  test(`direct playback rejects a ${kind} URL with a fixed safe error`, async t => {
    await assert.rejects(playbackFixture(t, { directUrl: path }), isSafeResponseError)
  })
}

test('development login uses standard client identification without a legacy header', async () => {
  const source = await readFile(new URL('../src/runtime.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source.replaceAll('import.meta.env.DEV', 'true'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  let loginCount = 0
  vm.runInNewContext(compiled, {
    window: {}, exports, __APP_VERSION__: '0.0.0-test',
    require: path => path.endsWith('/i18n.mjs') ? i18n : path.endsWith('/theme.mjs') ? themes : subtitles,
    fetch: async (value, init) => {
      if (value === '/__jellyfin-dev-config') return Response.json({ serverUrl: session.serverUrl, username: 'fixture-user', password: 'fixture-password' })
      if (value.endsWith('/System/Info/Public')) return Response.json({ ServerName: 'Fixture', Version: 'fixture', Id: 'fixture-server' })
      assert.equal(value, `${session.serverUrl}/Users/AuthenticateByName`)
      assert.equal(init.method, 'POST')
      assertModernAuthorization(init, false)
      assert.deepEqual(JSON.parse(init.body), { Username: 'fixture-user', Pw: 'fixture-password' })
      loginCount++
      return Response.json({ AccessToken: session.accessToken, User: { Id: session.userId, Name: 'Fixture' } })
    },
  })
  const runtime = await exports.discoverRuntime()
  assert.equal(loginCount, 1)
  assert.equal(runtime.session?.accessToken, session.accessToken)
})
