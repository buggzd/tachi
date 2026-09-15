import { parseSeekCommand } from '../SharedUI/seekCommand.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import test from 'node:test'

const source = (await readFile(new URL('./harness.js', import.meta.url), 'utf8')).replace(/^import .*seekCommand.*\n/, '')
const settle = () => new Promise(resolve => setImmediate(resolve))

async function harness(storedTheme = null, storedBackground = null, storedTransparency = null, storedSubtitleSize = null, search = '') {
  const storage = new Map([
    ['jellyfin-rayneo-preview-theme', storedTheme],
    ['jellyfin-rayneo-preview-touchpad-background', storedBackground],
    ['jellyfin-rayneo-preview-glass-transparency', storedTransparency],
    ['jellyfin-rayneo-preview-subtitle-size', storedSubtitleSize],
  ])
  const messages = []
  const elements = new Map()
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '393x852', clientWidth: 600, clientHeight: 900, lastChild: {},
      style: { setProperty() {} }, addEventListener() {}, src: '',
      contentWindow: { postMessage(message) { messages.push(JSON.parse(JSON.stringify(message))) } },
    })
    return elements.get(selector)
  }
  const context = vm.createContext({
    parseSeekCommand, URL, URLSearchParams, Blob, crypto: { randomUUID },
    document: { querySelector: element },
    window: {
      location: { hostname: '127.0.0.1', origin: 'http://127.0.0.1:4177', search },
      localStorage: { getItem(key) { return storage.get(key) ?? null }, setItem(key, value) { storage.set(key, value) } },
      addEventListener() {}, setTimeout() {}, clearTimeout() {},
    },
    ResizeObserver: class { observe() {} },
    fetch: async () => ({ ok: false, json: async () => ({ error: '测试登录失败。', code: 'missing_config' }) }),
  })
  vm.runInContext(source, context)
  await settle()
  const call = (name, payload) => {
    context.input = payload
    return vm.runInContext(`${name}(input)`, context)
  }
  return {
    call,
    remoteCommands: () => messages.filter(message => message.type === 'remote-command').map(message => message.payload.command),
    command: (method, ...args) => call('handleCompanionCall', { method, args }),
    state: () => messages.filter(message => message.target === 'companion' && message.type === 'state').at(-1).payload,
    generation: () => messages.filter(message => message.type === 'bootstrap').at(-1).payload.catalogGeneration,
    bootstrap: () => messages.filter(message => message.type === 'bootstrap').at(-1).payload,
    frameUrls: () => [elements.get('#companion-frame').src, elements.get('#glasses-ui-frame').src],
    savedTheme: () => storage.get('jellyfin-rayneo-preview-theme'),
    savedBackground: () => storage.get('jellyfin-rayneo-preview-touchpad-background'),
    savedTransparency: () => storage.get('jellyfin-rayneo-preview-glass-transparency'),
    bootstrapCount: () => messages.filter(message => message.type === 'bootstrap').length,
  }
}

const account = (serverUrl = 'https://home.example.test', userId = 'first-user') => ({
  serverUrl, serverName: 'Demo library', serverVersion: '10.10', serverId: serverUrl,
  accessToken: 'test-token-do-not-publish-to-phone', userId, userName: userId, deviceId: 'demo-device',
})

test('startup reload marker is forwarded to both UI frames', async () => {
  const app = await harness(null, null, null, null, '?reload=run-123')
  const [companion, glasses] = app.frameUrls().map((value) => new URL(value))
  assert.equal(companion.searchParams.get('rayneo-dev-role'), 'companion')
  assert.equal(glasses.searchParams.get('rayneo-dev-role'), 'glasses')
  assert.equal(companion.searchParams.get('reload'), 'run-123')
  assert.equal(glasses.searchParams.get('reload'), 'run-123')
})

test('glasses and phone appearance edits share persistent values without restarting playback', async () => {
  const app = await harness('simpleUI', null, '23', 'large')
  app.call('applySession', account())
  app.call('handlePlaybackState', { state: 'playing', itemId: 'demo', positionTicks: 100000000 })
  const generation = app.generation()
  const playback = app.state().playback
  const session = app.bootstrap().session
  assert.equal(app.bootstrap().subtitleSize, 'large')
  assert.equal(app.state().touchpadBackground, 'black')
  app.call('handleGlassesMessage', { type: 'set_ui_theme', value: 'liquid-glass' })
  assert.equal(app.state().touchpadBackground, 'texture')
  app.command('selectTouchpadBackground', 'black')
  app.call('handleGlassesMessage', { type: 'set_ui_theme', value: 'simpleUI' })
  app.call('handleGlassesMessage', { type: 'set_ui_theme', value: 'liquid-glass' })
  assert.equal(app.state().touchpadBackground, 'black')
  assert.equal(app.state().companionGlassTransparency, 23)
  app.call('handleGlassesMessage', { type: 'set_subtitle_size', value: 'extra-large' })
  assert.equal(app.state().uiTheme, 'liquid-glass')
  assert.equal(app.state().subtitleSize, 'extra-large')
  assert.equal(app.bootstrap().subtitleSize, 'extra-large')
  for (const value of [null, {}, 125, '', 'normal ', 'LARGE', 'x'.repeat(8193)]) {
    app.call('handleGlassesMessage', { type: 'set_subtitle_size', value })
    app.command('selectSubtitleSize', value)
    assert.equal(app.bootstrap().subtitleSize, 'extra-large')
  }
  app.command('selectSubtitleSize', 'small')
  assert.equal(app.bootstrap().subtitleSize, 'small')
  assert.equal(app.generation(), generation)
  assert.deepEqual(app.state().playback, playback)
  assert.deepEqual(app.bootstrap().session, session)
  app.command('clearSession')
  assert.equal(app.bootstrap().subtitleSize, 'small')
})

test('theme selection reaches both surfaces without interrupting playback or changing the catalog generation', async () => {
  const app = await harness()
  app.call('applySession', account())
  app.call('handlePlaybackState', { state: 'playing', itemId: 'demo-film', positionTicks: 100000000, durationTicks: 600000000, playMethod: 'DirectPlay' })
  const playback = app.state().playback
  const generation = app.generation()
  const activeId = app.state().activeSessionId
  const session = app.bootstrap().session
  assert.equal(app.state().uiTheme, 'liquid-glass')
  app.command('selectUiTheme', 'simpleUI')
  assert.equal(app.state().uiTheme, 'simpleUI')
  assert.equal(app.bootstrap().uiTheme, 'simpleUI')
  assert.equal(app.savedTheme(), 'simpleUI')
  assert.equal(app.state().activeSessionId, activeId)
  assert.deepEqual(app.state().playback, playback)
  assert.equal(app.generation(), generation)
  assert.deepEqual(app.bootstrap().session, session)
  for (const invalid of [null, '', 'simpleui', ' simpleUI', {}, 'x'.repeat(65536)]) {
    app.command('selectUiTheme', invalid)
    assert.equal(app.bootstrap().uiTheme, 'simpleUI')
  }
  app.command('selectUiTheme', 'liquid-glass')
  assert.equal(app.state().uiTheme, 'liquid-glass')
  assert.equal(app.bootstrap().uiTheme, 'liquid-glass')
  assert.equal(app.generation(), generation)
})

test('theme restores after reload and remains selected after logout', async () => {
  const app = await harness('simpleUI')
  app.call('applySession', account())
  assert.equal(app.state().uiTheme, 'simpleUI')
  app.command('clearSession')
  assert.equal(app.state().sessionAvailable, false)
  assert.equal(app.bootstrap().session, null)
  assert.equal(app.bootstrap().uiTheme, 'simpleUI')
  const corrupt = await harness('future-theme')
  corrupt.call('publishGlassesBootstrap')
  assert.equal(corrupt.bootstrap().uiTheme, 'liquid-glass')
})

test('remote background persists across themes, reload and logout without republishing the glasses', async () => {
  const app = await harness()
  app.call('applySession', account())
  app.call('handlePlaybackState', { state: 'playing', itemId: 'demo-film', positionTicks: 100000000, durationTicks: 600000000 })
  const activeId = app.state().activeSessionId
  const playback = app.state().playback
  const bootstrapCount = app.bootstrapCount()
  assert.equal(app.state().touchpadBackground, 'texture')
  app.command('selectTouchpadBackground', 'black')
  assert.equal(app.state().touchpadBackground, 'black')
  assert.equal(app.savedBackground(), 'black')
  assert.equal(app.bootstrapCount(), bootstrapCount)
  assert.equal(app.state().activeSessionId, activeId)
  assert.deepEqual(app.state().playback, playback)
  assert.equal('touchpadBackground' in app.bootstrap(), false)
  for (const invalid of [null, '', 'BLACK', ' black', {}, 'x'.repeat(65536)]) {
    app.command('selectTouchpadBackground', invalid)
    assert.equal(app.state().touchpadBackground, 'black')
  }
  app.command('selectUiTheme', 'simpleUI')
  app.command('selectTouchpadBackground', 'texture')
  app.command('selectUiTheme', 'liquid-glass')
  assert.equal(app.state().touchpadBackground, 'texture')
  app.command('clearSession')
  assert.equal(app.state().touchpadBackground, 'texture')
  const restored = await harness('simpleUI', app.savedBackground())
  assert.equal(restored.state().touchpadBackground, 'texture')
})

test('glass edits save from settings only and leave the account, playback and glasses bootstrap intact', async () => {
  const app = await harness()
  app.call('applySession', account())
  app.call('handlePlaybackState', { state: 'playing', itemId: 'demo-film', positionTicks: 100000000, durationTicks: 600000000 })
  const before = app.state()
  const bootstraps = app.bootstrapCount()
  app.command('screenChanged', 'home')
  app.command('setCompanionGlassTransparency', '0')
  assert.equal(app.state().companionGlassTransparency, 88)
  app.command('screenChanged', 'settings')
  app.command('setCompanionGlassTransparency', '70')
  assert.equal(app.state().companionGlassTransparency, 70)
  assert.equal(app.savedTransparency(), '70')
  assert.equal(app.bootstrapCount(), bootstraps)
  assert.equal(app.state().activeSessionId, before.activeSessionId)
  assert.deepEqual(app.state().playback, before.playback)
  assert.equal('companionGlassTransparency' in app.bootstrap(), false)
  for (const invalid of [null, 50, '', ' 50', '50\n', '01', '0.5', '-1', '101', '1e2', 'x'.repeat(65536)]) {
    app.command('setCompanionGlassTransparency', invalid)
    assert.equal(app.state().companionGlassTransparency, 70)
  }
  app.command('selectUiTheme', 'simpleUI')
  app.command('clearSession')
  const restored = await harness('simpleUI', null, app.savedTransparency())
  assert.equal(restored.state().companionGlassTransparency, 70)
  const corrupt = await harness(null, null, 'NaN')
  assert.equal(corrupt.state().companionGlassTransparency, 88)
})

test('missing or corrupt remote preference preserves each theme default until explicitly chosen', async () => {
  const app = await harness('simpleUI', 'invalid')
  assert.equal(app.state().touchpadBackground, 'black')
  app.command('selectUiTheme', 'liquid-glass')
  assert.equal(app.state().touchpadBackground, 'texture')
  app.command('selectTouchpadBackground', 'black')
  app.command('selectUiTheme', 'simpleUI')
  app.command('selectUiTheme', 'liquid-glass')
  assert.equal(app.state().touchpadBackground, 'black')
})

test('switches between two servers and multiple users with only metadata on the phone', async () => {
  const app = await harness()
  app.call('applySession', account())
  const first = app.state().activeSessionId
  app.call('applySession', account(undefined, 'second-user'))
  app.call('applySession', account('https://cinema.example.test', 'first-user'))
  assert.equal(app.state().accounts.length, 3)
  app.command('activateSession', first)
  assert.equal(app.state().activeSessionId, first)
  assert.equal(app.state().serverUrl, 'https://home.example.test')
  assert.equal(app.state().username, 'first-user')
  assert.equal(JSON.stringify(app.state()).includes('test-token-do-not-publish-to-phone'), false)
  assert.equal(JSON.stringify(app.state()).includes('accessToken'), false)
  assert.equal(app.state().accounts.filter(entry => entry.active).length, 1)
})

test('browsing servers, failed login and cancelling login preserve the active connection', async () => {
  const app = await harness()
  app.call('applySession', account())
  const first = app.state().activeSessionId
  app.command('selectServer', 'https://another.example.test', 'Another library')
  assert.equal(app.state().serverUrl, 'https://home.example.test')
  assert.equal(app.state().loginServerUrl, 'https://another.example.test')
  app.command('login', 'https://another.example.test', 'new-user', 'test-password', true)
  await settle()
  assert.equal(app.state().activeSessionId, first)
  assert.equal(app.state().sessionAvailable, true)
  assert.equal(app.state().isError, true)
  app.command('cancelQuickConnect')
  assert.equal(app.state().activeSessionId, first)
  assert.equal(app.state().accounts.length, 1)
})

test('removing an inactive account leaves playback and the current account intact', async () => {
  const app = await harness()
  app.call('applySession', account())
  const first = app.state().activeSessionId
  app.call('applySession', account('https://cinema.example.test'))
  const second = app.state().activeSessionId
  app.call('handleGlassesMessage', { type: 'playback_state', state: 'playing', title: 'Demo film' })
  app.command('removeSession', first)
  assert.equal(app.state().activeSessionId, second)
  assert.equal(app.state().playback.state, 'playing')
  assert.equal(app.state().accounts.length, 1)
  app.command('activateSession', first)
  assert.equal(app.state().activeSessionId, second)
})

test('late unauthorized response from the previous account cannot remove a newly activated account', async () => {
  const app = await harness()
  app.call('applySession', account())
  const first = app.state().activeSessionId
  const previousGeneration = app.generation()
  app.call('applySession', account('https://cinema.example.test'))
  const second = app.state().activeSessionId
  app.call('handleGlassesMessage', { type: 'unauthorized', catalogGeneration: previousGeneration })
  assert.equal(app.state().activeSessionId, second)
  assert.equal(app.state().accounts.length, 2)
  app.call('handleGlassesMessage', { type: 'unauthorized', catalogGeneration: app.generation() })
  assert.equal(app.state().sessionAvailable, false)
  assert.equal(app.state().accounts.length, 1)
  app.command('activateSession', first)
  assert.equal(app.state().sessionAvailable, true)
  assert.equal(app.state().activeSessionId, first)
})

test('successful account switch clears the previous playback and search state', async () => {
  const app = await harness()
  app.call('applySession', account())
  const first = app.state().activeSessionId
  app.call('applySession', account('https://cinema.example.test'))
  app.call('handleGlassesMessage', { type: 'playback_state', state: 'playing', title: 'Demo film' })
  app.call('handleGlassesMessage', { type: 'search_state', state: 'active', query: 'demo' })
  app.command('activateSession', first)
  assert.equal(app.state().playback.state, 'stopped')
  assert.equal(app.state().searchInputActive, false)
  assert.equal(app.state().searchQuery, '')
})


test('circular seeking forwards only bounded deltas while progress focus is enabled', async () => {
  const app = await harness()
  app.call('applySession', account())
  app.command('remoteCommand', 'seek:15')
  assert.equal(app.remoteCommands().length, 0)
  app.call('handleGlassesMessage', { type: 'playback_state', state: 'paused', seekEnabled: true })
  app.command('remoteCommand', 'seek:-60')
  app.command('remoteCommand', 'seek:61')
  assert.deepEqual(app.remoteCommands(), ['seek:-60'])
  app.call('handleGlassesMessage', { type: 'playback_state', state: 'playing', seekEnabled: 'true' })
  app.command('remoteCommand', 'seek:15')
  assert.equal(app.remoteCommands().length, 1)
  app.call('handleGlassesMessage', { type: 'playback_state', state: 'stopped', seekEnabled: true })
  assert.equal(app.state().playback.seekEnabled, false)
})

test('language persists and synchronizes both surfaces without replacing catalog or session', async () => {
  const app = await harness()
  app.command('selectLanguage', 'en')
  const generation = app.bootstrap().catalogGeneration
  assert.equal(app.state().language, 'en')
  assert.equal(app.bootstrap().language, 'en')
  app.call('handleGlassesMessage', { type: 'set_language', value: 'zh-CN' })
  assert.equal(app.state().language, 'zh-CN')
  assert.equal(app.bootstrap().language, 'zh-CN')
  for (const value of [null, {}, 5, ' en', 'EN', 'zh-TW']) {
    app.command('selectLanguage', value)
    app.call('handleGlassesMessage', { type: 'set_language', value })
    assert.equal(app.state().language, 'zh-CN')
  }
  if (generation !== undefined) assert.equal(app.bootstrap().catalogGeneration, generation)
})
