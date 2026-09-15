import { parseSeekCommand, parseScrubCommand } from './seekCommand.mjs'
const channel = 'jellyfin-rayneo-dual-ui-v1'
const maximumMessageLength = 65_536
const host = window.location.hostname === 'localhost' ? 'localhost' : '127.0.0.1'
const origins = {
  companion: `http://${host}:4176`,
  glasses: `http://${host}:4175`,
}

const companionFrame = document.querySelector('#companion-frame')
const glassesFrame = document.querySelector('#glasses-ui-frame')
const phoneCanvas = document.querySelector('#phone-canvas')
const glassesCanvas = document.querySelector('#glasses-canvas')
const phoneScaler = document.querySelector('#phone-frame')
const glassesScaler = document.querySelector('#glasses-frame')
const phonePreset = document.querySelector('#phone-preset')
const phoneSize = document.querySelector('#phone-size')
const phoneStatus = document.querySelector('#phone-status')
const glassesStatus = document.querySelector('#glasses-status')
const sessionStatus = document.querySelector('#session-status')
const activityDot = document.querySelector('#activity-dot')
const activityMessage = document.querySelector('#activity-message')

const frameReady = {
  companion: false,
  glasses: false,
}

const emptyPlayback = () => ({
  state: 'stopped',
  itemId: '',
  title: '',
  subtitle: '',
  playMethod: '',
  positionTicks: 0,
  durationTicks: 0,
    seekEnabled: false,
})

let touchpadBackgroundChoice = readTouchpadBackground()

const companionState = {
  state: 'login_required',
  message: '请选择 Jellyfin 服务器并登录。',
  isError: false,
  serverUrl: '',
  serverName: '',
  serverVersion: '',
  serverId: '',
  username: '',
  quickConnectCode: '',
  sessionAvailable: false,
  sessionSaved: false,
  busy: false,
  webHardwareAccelerated: true,
  glassesConnected: true,
  glassesPresentationReady: false,
  glassesRuntimeState: 'booting',
  glassesRuntimeErrorCode: 'none',
  mediaReady: false,
  touchpadReady: false,
  searchInputActive: false,
  searchQuery: '',
  displayMode: 'mirror_2d',
  uiTheme: readUiTheme(),
  touchpadBackground: touchpadBackgroundChoice || (readUiTheme() === 'simpleUI' ? 'black' : 'texture'),
  companionGlassTransparency: readGlassTransparency(),
  subtitleSize: readSubtitleSize(),
  language: readLanguage(),
  systemLanguage: globalThis.navigator?.language ?? 'en',
  activeDisplayMode: 'mirror_2d',
  displayModeApplied: true,
  displayModeTransitioning: false,
  displayMessage: '浏览器双端联调模式 · 未调用 RayNeo 硬件',
  discoveryMessage: '',
  discoveryError: false,
  discoveryScanning: false,
  playback: emptyPlayback(),
  servers: [],
}

const runtimeStates = new Set(['booting', 'loading', 'ready', 'no-session', 'error'])
const runtimeErrorCodes = new Set(['none', 'network', 'http', 'response', 'unknown'])
const playbackStates = new Set([
  'preparing',
  'buffering',
  'playing',
  'paused',
  'ended',
  'error',
  'stopped',
])
const remoteCommands = new Set([
  'up',
  'down',
  'left',
  'right',
  'submit',
  'enter',
  'back',
  'search-submit',
  'search-keyboard-visible',
  'search-keyboard-hidden',
])
const phonePresets = new Set(['360x800', '393x852', '412x915', '430x932'])

const savedSessions = new Map()
let activeSessionId = ''
let phoneScreen = 'connect'
let session = null
let catalogGeneration = 0
let authenticationGeneration = 0
let quickConnectGeneration = 0
let quickConnectOperation = ''
let quickConnectAuthorizationUrl = ''
let displayTransitionTimer = 0

class ApiError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.details = details
  }
}

function readUiTheme() {
  try {
    return window.localStorage.getItem('jellyfin-rayneo-preview-theme') === 'simpleUI' ? 'simpleUI' : 'liquid-glass'
  } catch {
    return 'liquid-glass'
  }
}

function readTouchpadBackground() {
  try {
    const value = window.localStorage.getItem('jellyfin-rayneo-preview-touchpad-background')
    return value === 'texture' || value === 'black' ? value : null
  } catch { return null }
}

function validGlassTransparency(value) {
  return typeof value === 'string' && value.length <= 3 && /^(0|[1-9][0-9]?|100)$/.test(value) && String(Number(value)) === value
}

function readGlassTransparency() {
  try {
    const value = window.localStorage.getItem('jellyfin-rayneo-preview-glass-transparency')
    return validGlassTransparency(value) ? Number(value) : 88
  } catch { return 88 }
}

function readSubtitleSize() {
  try {
    const value = window.localStorage.getItem('jellyfin-rayneo-preview-subtitle-size')
    return ['small', 'normal', 'large', 'extra-large'].includes(value) ? value : 'normal'
  } catch { return 'normal' }
}

function readLanguage() {
  try {
    const value = window.localStorage.getItem('tachi-preview-language')
    return ['system', 'zh-CN', 'en'].includes(value) ? value : 'system'
  } catch { return 'system' }
}

function setLanguage(value) {
  if (!['system', 'zh-CN', 'en'].includes(value)) return
  companionState.language = value
  try { window.localStorage.setItem('tachi-preview-language', value) } catch { /* Keep preview usable. */ }
  publishCompanionState()
  publishGlassesBootstrap()
}

function setAppearancePreference(kind, value) {
  const theme = kind === 'uiTheme'
  if (theme ? value !== 'liquid-glass' && value !== 'simpleUI'
    : !['small', 'normal', 'large', 'extra-large'].includes(value)) return
  companionState[kind] = value
  if (theme) companionState.touchpadBackground = touchpadBackgroundChoice || (value === 'simpleUI' ? 'black' : 'texture')
  try {
    window.localStorage.setItem(theme ? 'jellyfin-rayneo-preview-theme' : 'jellyfin-rayneo-preview-subtitle-size', value)
  } catch { /* The preview still works without storage. */ }
  publishCompanionState()
  publishGlassesBootstrap()
}

function boundedText(value, maximumLength) {
  return typeof value === 'string' ? value.trim().slice(0, maximumLength) : ''
}

function normalizedSearchQuery(value) {
  if (typeof value !== 'string' || value.length > 48) return null
  const normalized = value.toLowerCase()
  return /^[a-z0-9 ]*$/.test(normalized) ? normalized : null
}

function boundedTicks(value) {
  const number = Number(value)
  const maximum = 10_000_000 * 60 * 60 * 24 * 366
  return Number.isFinite(number) ? Math.max(0, Math.min(maximum, Math.round(number))) : 0
}

function isBoundedMessage(value) {
  try {
    return JSON.stringify(value).length <= maximumMessageLength
  } catch {
    return false
  }
}

function setActivity(message, tone = 'busy') {
  activityMessage.textContent = boundedText(message, 240)
  activityDot.className = `activity-dot is-${tone}`
}

function setPill(element, message, tone) {
  element.lastChild.textContent = ` ${message}`
  element.className = `status-pill${tone ? ` is-${tone}` : ''}`
}

function refreshStatus() {
  setPill(
    phoneStatus,
    frameReady.companion ? '手机桥已连接' : '手机等待中',
    frameReady.companion ? 'ready' : '',
  )

  const runtime = companionState.glassesRuntimeState
  const glassesTone = runtime === 'error'
    ? 'error'
    : runtime === 'ready'
      ? 'ready'
      : frameReady.glasses
        ? 'busy'
        : ''
  const runtimeLabels = {
    booting: '眼镜启动中',
    loading: '媒体库加载中',
    ready: '眼镜媒体已就绪',
    'no-session': '眼镜等待登录',
    error: '眼镜加载失败',
  }
  setPill(
    glassesStatus,
    frameReady.glasses ? runtimeLabels[runtime] || '眼镜桥已连接' : '眼镜等待中',
    glassesTone,
  )
  setPill(
    sessionStatus,
    session ? '开发会话已注入' : '尚未登录',
    session ? 'ready' : '',
  )
}

function postToFrame(target, type, payload = {}) {
  const frame = target === 'companion' ? companionFrame : glassesFrame
  const message = { channel, role: 'harness', target, type, payload }
  if (!frame.contentWindow || !isBoundedMessage(message)) return
  frame.contentWindow.postMessage(message, origins[target])
}

function publishCompanionState() {
  companionState.sessionAvailable = Boolean(session)
  companionState.sessionSaved = false
  companionState.glassesPresentationReady = frameReady.glasses
  companionState.mediaReady = Boolean(session) && companionState.glassesRuntimeState === 'ready'
  companionState.touchpadReady = frameReady.glasses && companionState.mediaReady
  postToFrame('companion', 'state', {
    ...companionState,
    serverUrl: session?.serverUrl || companionState.serverUrl,
    serverName: session?.serverName || companionState.serverName,
    serverVersion: session?.serverVersion || companionState.serverVersion,
    serverId: session?.serverId || companionState.serverId,
    username: session?.userName || companionState.username,
    loginServerUrl: companionState.serverUrl,
    loginServerName: companionState.serverName,
    activeSessionId,
    accountLimit: 12,
    accounts: [...savedSessions].map(([id, entry]) => ({
      id, serverUrl: entry.serverUrl, serverName: entry.serverName, serverId: entry.serverId,
      serverVersion: entry.serverVersion, username: entry.userName, saved: false, active: id === activeSessionId,
    })),
    playback: { ...companionState.playback },
    servers: companionState.servers.map((server) => ({ ...server })),
  })
  refreshStatus()
}

function publishGlassesBootstrap() {
  postToFrame('glasses', 'bootstrap', {
    source: 'android',
    displayMode: companionState.displayMode,
    uiTheme: companionState.uiTheme,
    subtitleSize: companionState.subtitleSize,
    language: companionState.language,
    systemLanguage: companionState.systemLanguage,
    glassesConnected: true,
    catalogGeneration,
    session,
  })
}

function serverEntry(server) {
  if (!server || typeof server !== 'object') return null
  const serverUrl = boundedText(server.serverUrl || server.host, 2_048)
  if (!serverUrl) return null
  const name = boundedText(server.serverName || server.name, 512)
    || serverUrl.replace(/^https?:\/\//i, '')
  const version = boundedText(server.serverVersion, 128)
  return {
    id: boundedText(server.serverId, 512) || serverUrl,
    name,
    host: serverUrl,
    detail: version ? `Jellyfin ${version}` : 'Jellyfin 开发服务器',
    latency: '本机联调',
    strength: 3,
  }
}

function applyServer(server) {
  const entry = serverEntry(server)
  if (!entry) return
  companionState.serverUrl = entry.host
  companionState.serverName = entry.name
  companionState.serverVersion = boundedText(server.serverVersion, 128)
  companionState.serverId = boundedText(server.serverId, 512)
  companionState.servers = [entry]
}

function applySession(nextSession) {
  if (!nextSession || typeof nextSession !== 'object' || !isBoundedMessage(nextSession)) {
    throw new Error('开发服务器没有返回有效会话。')
  }
  const normalized = {
    serverUrl: boundedText(nextSession.serverUrl, 2_048),
    serverName: boundedText(nextSession.serverName, 512),
    serverVersion: boundedText(nextSession.serverVersion, 128),
    serverId: boundedText(nextSession.serverId, 512),
    accessToken: boundedText(nextSession.accessToken, 4_096),
    userId: boundedText(nextSession.userId, 512),
    userName: boundedText(nextSession.userName, 512),
    deviceId: boundedText(nextSession.deviceId, 512),
  }
  if (!normalized.serverUrl || !normalized.accessToken || !normalized.userId || !normalized.deviceId) {
    throw new Error('开发服务器没有返回有效会话。')
  }

  const existing = [...savedSessions].find(([, entry]) => entry.serverUrl === normalized.serverUrl && entry.userId === normalized.userId)
  if (!existing && savedSessions.size >= 12) throw new Error('最多保留 12 个账号，请先移除一个不再使用的账号。')
  authenticationGeneration += 1
  activeSessionId = existing?.[0] || crypto.randomUUID().replaceAll('-', '')
  savedSessions.set(activeSessionId, normalized)
  session = normalized
  applyServer(normalized)
  companionState.username = normalized.userName
  companionState.state = 'session_ready'
  companionState.message = '开发会话已载入，正在同步右侧眼镜媒体库。'
  companionState.isError = false
  companionState.busy = false
  companionState.quickConnectCode = ''
  companionState.glassesRuntimeState = 'loading'
  companionState.glassesRuntimeErrorCode = 'none'
  companionState.searchInputActive = false
  companionState.searchQuery = ''
  companionState.playback = emptyPlayback()
  catalogGeneration += 1
  stopQuickConnect(false)
  publishCompanionState()
  publishGlassesBootstrap()
  postToFrame('companion', 'open-screen', { screen: 'home' })
  setActivity('会话已注入；等待右侧眼镜端完成媒体库加载。', 'ready')
}

function resetSession(unauthorized = false) {
  authenticationGeneration += 1
  savedSessions.delete(activeSessionId)
  activeSessionId = ''
  session = null
  stopQuickConnect(true)
  companionState.state = 'login_required'
  companionState.message = unauthorized
    ? 'Jellyfin 会话已失效，请在手机端重新登录。'
    : 'Jellyfin 会话已清除，请重新选择服务器并登录。'
  companionState.isError = unauthorized
  companionState.busy = false
  companionState.quickConnectCode = ''
  companionState.glassesRuntimeState = 'no-session'
  companionState.glassesRuntimeErrorCode = 'none'
  companionState.searchInputActive = false
  companionState.searchQuery = ''
  companionState.playback = emptyPlayback()
  catalogGeneration += 1
  publishCompanionState()
  publishGlassesBootstrap()
  postToFrame('companion', 'open-screen', { screen: savedSessions.size ? 'accounts' : 'connect' })
  setActivity(
    unauthorized ? '眼镜端报告会话失效，已同时清理两端状态。' : '开发会话已从双端内存中清除。',
    unauthorized ? 'error' : 'busy',
  )
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  let result = {}
  try {
    result = await response.json()
  } catch {
    throw new ApiError('联调服务返回了无法解析的响应。')
  }
  if (!response.ok) throw new ApiError(boundedText(result.error, 240) || '联调请求失败。', result)
  return result
}

async function restoreDevelopmentSession() {
  const operation = ++authenticationGeneration
  companionState.busy = true
  companionState.message = '正在读取 .jellyfin-dev.json 并建立开发会话…'
  companionState.isError = false
  publishCompanionState()
  setActivity('正在从本机开发配置建立 Jellyfin 会话…', 'busy')

  try {
    const result = await api('/api/development-session', {
      method: 'POST',
      body: '{}',
    })
    if (operation !== authenticationGeneration) return
    applyServer(result.server)
    applySession(result.session)
  } catch (error) {
    if (operation !== authenticationGeneration) return
    const details = error instanceof ApiError ? error.details : {}
    applyServer(details.server)
    companionState.busy = false
    companionState.state = 'login_required'
    companionState.message = details.code === 'missing_config'
      ? '请选择开发服务器，或先创建 .jellyfin-dev.json。'
      : error instanceof Error
        ? error.message
        : '无法载入开发会话。'
    companionState.isError = details.code !== 'missing_config'
    publishCompanionState()
    setActivity(
      details.code === 'missing_config'
        ? '未找到 .jellyfin-dev.json；仍可在左侧手动输入服务器并登录。'
        : companionState.message,
      details.code === 'missing_config' ? 'busy' : 'error',
    )
  }
}

async function scanDevelopmentServer() {
  if (companionState.discoveryScanning || companionState.busy) return
  companionState.discoveryScanning = true
  companionState.discoveryError = false
  companionState.discoveryMessage = '正在读取本机 Jellyfin 开发配置…'
  publishCompanionState()

  try {
    const result = await api('/api/development-server', {
      method: 'POST',
      body: '{}',
    })
    applyServer(result.server)
    companionState.discoveryMessage = '发现 1 台开发配置中的 Jellyfin 服务器。'
    companionState.discoveryError = false
  } catch (error) {
    companionState.servers = []
    companionState.discoveryMessage = error instanceof Error
      ? error.message
      : '未找到开发服务器，请手动输入地址。'
    companionState.discoveryError = true
  } finally {
    companionState.discoveryScanning = false
    publishCompanionState()
  }
}

async function loginWithPassword(args) {
  if (companionState.busy) return
  const serverUrl = boundedText(args[0], 2_048)
  const username = boundedText(args[1], 512)
  let password = typeof args[2] === 'string' ? args[2].slice(0, 4_096) : ''
  const operation = ++authenticationGeneration

  companionState.serverUrl = serverUrl
  companionState.username = username
  companionState.state = 'native_connecting'
  companionState.message = '正在通过本机联调服务验证服务器与账户…'
  companionState.busy = true
  companionState.isError = false
  companionState.quickConnectCode = ''
  publishCompanionState()
  setActivity('正在验证左侧输入的 Jellyfin 账户…', 'busy')

  try {
    const result = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ serverUrl, username, password }),
    })
    password = ''
    if (operation !== authenticationGeneration) return
    applyServer(result.server)
    applySession(result.session)
  } catch (error) {
    password = ''
    if (operation !== authenticationGeneration) return
    companionState.busy = false
    companionState.state = 'login_required'
    companionState.message = error instanceof Error ? error.message : 'Jellyfin 登录失败。'
    companionState.isError = true
    publishCompanionState()
    setActivity(companionState.message, 'error')
  }
}

function stopQuickConnect(notifyServer) {
  quickConnectGeneration += 1
  const operationId = quickConnectOperation
  quickConnectOperation = ''
  quickConnectAuthorizationUrl = ''
  if (notifyServer && operationId) {
    void api('/api/quick-connect/cancel', {
      method: 'POST',
      body: JSON.stringify({ operationId }),
    }).catch(() => {})
  }
}

async function pollQuickConnect(generation) {
  if (generation !== quickConnectGeneration || !quickConnectOperation) return
  try {
    const result = await api('/api/quick-connect/poll', {
      method: 'POST',
      body: JSON.stringify({ operationId: quickConnectOperation }),
    })
    if (generation !== quickConnectGeneration) return
    if (result.pending) {
      window.setTimeout(() => void pollQuickConnect(generation), 1_500)
      return
    }
    applyServer(result.server)
    applySession(result.session)
  } catch (error) {
    if (generation !== quickConnectGeneration) return
    stopQuickConnect(false)
    companionState.busy = false
    companionState.state = 'login_required'
    companionState.quickConnectCode = ''
    companionState.message = error instanceof Error ? error.message : 'Quick Connect 失败。'
    companionState.isError = true
    publishCompanionState()
    setActivity(companionState.message, 'error')
  }
}

async function startQuickConnect(args) {
  if (companionState.busy || quickConnectOperation) return
  const serverUrl = boundedText(args[0], 2_048)
  const generation = ++quickConnectGeneration
  companionState.state = 'native_connecting'
  companionState.message = '正在向 Jellyfin 申请快速登录码…'
  companionState.quickConnectCode = ''
  companionState.busy = true
  companionState.isError = false
  publishCompanionState()

  try {
    const result = await api('/api/quick-connect/start', {
      method: 'POST',
      body: JSON.stringify({ serverUrl }),
    })
    if (generation !== quickConnectGeneration) return
    quickConnectOperation = boundedText(result.operationId, 128)
    quickConnectAuthorizationUrl = boundedText(result.authorizationUrl, 2_048)
    applyServer(result.server)
    companionState.state = 'quick_connect_waiting'
    companionState.message = '请在 Jellyfin App 或网页中确认此登录码。'
    companionState.quickConnectCode = boundedText(result.code, 32)
    companionState.busy = true
    companionState.isError = false
    publishCompanionState()
    setActivity('Quick Connect 登录码已生成，等待 Jellyfin 确认。', 'busy')
    void pollQuickConnect(generation)
  } catch (error) {
    if (generation !== quickConnectGeneration) return
    stopQuickConnect(false)
    companionState.busy = false
    companionState.state = 'login_required'
    companionState.message = error instanceof Error ? error.message : '无法启动 Quick Connect。'
    companionState.isError = true
    publishCompanionState()
    setActivity(companionState.message, 'error')
  }
}

function cancelQuickConnect() {
  authenticationGeneration += 1
  stopQuickConnect(true)
  companionState.busy = false
  companionState.state = 'login_required'
  companionState.quickConnectCode = ''
  companionState.message = '已取消快速登录。'
  companionState.isError = false
  publishCompanionState()
  setActivity('Quick Connect 已取消。', 'busy')
}

function selectDisplayMode(value) {
  const requested = boundedText(value, 32).toLowerCase()
  const mode = requested === 'stereo_screen' ? 'stereo_screen' : 'mirror_2d'
  window.clearTimeout(displayTransitionTimer)
  companionState.displayMode = mode
  companionState.displayModeApplied = false
  companionState.displayModeTransitioning = true
  companionState.displayMessage = '联调模式正在模拟显示模式切换…'
  publishCompanionState()
  publishGlassesBootstrap()

  displayTransitionTimer = window.setTimeout(() => {
    companionState.activeDisplayMode = mode
    companionState.displayModeApplied = true
    companionState.displayModeTransitioning = false
    companionState.displayMessage = mode === 'stereo_screen'
      ? '联调模式已切换为 SBS 立体虚拟屏幕。'
      : '联调模式已切换为 Mirror 2D。'
    publishCompanionState()
  }, 180)
}

function shareDiagnostics() {
  const payload = {
    capturedAt: new Date().toISOString(),
    harness: 'dual-ui-v1',
    phoneViewport: phonePreset.value,
    phoneBridgeReady: frameReady.companion,
    glassesBridgeReady: frameReady.glasses,
    sessionAvailable: Boolean(session),
    runtimeState: companionState.glassesRuntimeState,
    runtimeErrorCode: companionState.glassesRuntimeErrorCode,
    displayMode: companionState.displayMode,
    playbackState: companionState.playback.state,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'rayneo-dual-ui-diagnostics.json'
  anchor.click()
  URL.revokeObjectURL(url)
  setActivity('已导出不含地址、凭据或 Token 的联调诊断。', 'ready')
}

function handleCompanionCall(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.args || [])) return
  const method = boundedText(payload.method, 48)
  const args = payload.args || []

  switch (method) {
    case 'scan':
      void scanDevelopmentServer()
      break
    case 'selectServer':
      cancelQuickConnect()
      companionState.username = ''
      companionState.serverUrl = boundedText(args[0], 2_048)
      companionState.serverName = boundedText(args[1], 512)
      publishCompanionState()
      break
    case 'login':
      void loginWithPassword(args)
      break
    case 'startQuickConnect':
      void startQuickConnect(args)
      break
    case 'cancelQuickConnect':
      cancelQuickConnect()
      break
    case 'clearSession':
      resetSession(false)
      break
    case 'activateSession': {
      const id = args[0]
      if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) break
      if (id === activeSessionId) postToFrame('companion', 'open-screen', { screen: 'home' })
      else if (savedSessions.has(id)) applySession(savedSessions.get(id))
      break
    }
    case 'removeSession': {
      const id = args[0]
      if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) break
      if (id === activeSessionId) resetSession(false)
      else if (savedSessions.delete(id)) publishCompanionState()
      break
    }
    case 'retryGlasses':
      if (!session) break
      companionState.glassesRuntimeState = 'loading'
      companionState.glassesRuntimeErrorCode = 'none'
      companionState.state = 'session_ready'
      companionState.message = '正在重新加载右侧眼镜媒体库。'
      companionState.isError = false
      catalogGeneration += 1
      publishCompanionState()
      publishGlassesBootstrap()
      break
    case 'shareDiagnostics':
      shareDiagnostics()
      break
    case 'selectDisplayMode':
      selectDisplayMode(args[0])
      break
    case 'selectUiTheme':
      setAppearancePreference('uiTheme', args[0])
      break
    case 'selectLanguage':
      setLanguage(args[0])
      break
    case 'selectSubtitleSize':
      setAppearancePreference('subtitleSize', args[0])
      break
    case 'selectTouchpadBackground':
      if (args[0] !== 'texture' && args[0] !== 'black') break
      touchpadBackgroundChoice = args[0]
      companionState.touchpadBackground = args[0]
      try {
        window.localStorage.setItem('jellyfin-rayneo-preview-touchpad-background', args[0])
      } catch { /* Retain the selection in memory if storage is unavailable. */ }
      publishCompanionState()
      break
    case 'setCompanionGlassTransparency':
      if (phoneScreen !== 'settings' || !validGlassTransparency(args[0])) break
      companionState.companionGlassTransparency = Number(args[0])
      try {
        window.localStorage.setItem('jellyfin-rayneo-preview-glass-transparency', args[0])
      } catch { /* Retain the appearance in memory if storage is unavailable. */ }
      publishCompanionState()
      break
    case 'openQuickConnectAuthorization': {
      if (!quickConnectAuthorizationUrl) break
      const opened = window.open(quickConnectAuthorizationUrl, '_blank', 'noopener,noreferrer')
      setActivity(
        opened ? '已在新标签页打开 Jellyfin Quick Connect。' : '浏览器拦截了新标签页，请允许弹窗后重试。',
        opened ? 'ready' : 'error',
      )
      break
    }
    case 'remoteCommand': {
      const command = boundedText(args[0], 32).toLowerCase()
      if (!remoteCommands.has(command) && parseSeekCommand(command) === null && parseScrubCommand(command) === null) break
      if ((parseSeekCommand(command) !== null || parseScrubCommand(command) !== null) && !companionState.playback.seekEnabled) break
      postToFrame('glasses', 'remote-command', {
        command: command === 'submit' ? 'enter' : command,
      })
      setActivity(`已转发触控指令：${command.toUpperCase()}`, 'ready')
      break
    }
    case 'searchText': {
      if (!companionState.searchInputActive) break
      const query = normalizedSearchQuery(args[0])
      if (query === null) break
      postToFrame('glasses', 'remote-command', { command: `search-text:${query}` })
      break
    }
    case 'screenChanged':
      phoneScreen = boundedText(args[0], 24)
      setActivity(`手机端当前页面：${boundedText(args[0], 24) || 'unknown'}`, 'ready')
      break
    default:
      break
  }
}

function runtimeFailureMessage(code) {
  const messages = {
    network: '眼镜端无法访问 Jellyfin，请检查开发服务器网络。',
    http: '眼镜端收到 Jellyfin HTTP 错误，请检查服务状态。',
    response: '眼镜端无法解析 Jellyfin 响应。',
    unknown: '眼镜端媒体库加载失败，请查看浏览器控制台。',
  }
  return messages[code] || messages.unknown
}

function handleRuntimeState(message) {
  const nextState = boundedText(message.state, 32).toLowerCase()
  if (!runtimeStates.has(nextState)) return
  const requestedErrorCode = boundedText(message.errorCode, 32).toLowerCase()
  const errorCode = runtimeErrorCodes.has(requestedErrorCode) ? requestedErrorCode : 'unknown'
  companionState.glassesRuntimeState = nextState
  companionState.glassesRuntimeErrorCode = nextState === 'error' ? errorCode : 'none'
  if (phoneScreen === 'auth') { publishCompanionState(); return }

  if (nextState === 'error') {
    companionState.state = 'glasses_error'
    companionState.message = runtimeFailureMessage(errorCode)
    companionState.isError = true
    setActivity(companionState.message, 'error')
  } else if (nextState === 'ready') {
    companionState.state = 'ready'
    companionState.message = 'Jellyfin 已连接，媒体库正在右侧眼镜中显示。'
    companionState.isError = false
    setActivity('双端就绪：现在可从左侧进入触控板控制右侧焦点。', 'ready')
  } else {
    companionState.state = session ? 'session_ready' : 'login_required'
    companionState.message = session
      ? nextState === 'loading'
        ? '眼镜端正在连接 Jellyfin 并加载媒体库。'
        : '眼镜端正在启动，开发会话仍保存在联调页内存中。'
      : '请先在手机端登录 Jellyfin。'
    companionState.isError = false
  }
  publishCompanionState()
}

function handlePlaybackState(message) {
  const state = boundedText(message.state, 32).toLowerCase()
  if (!playbackStates.has(state)) return
  const playMethod = boundedText(message.playMethod, 32).toLowerCase()
  companionState.playback = {
    state,
    itemId: boundedText(message.itemId, 128),
    title: boundedText(message.title, 180),
    subtitle: boundedText(message.subtitle, 240),
    playMethod: playMethod === 'transcode'
      ? 'Transcode'
      : playMethod === 'directstream'
        ? 'DirectStream'
        : playMethod === 'directplay'
          ? 'DirectPlay'
          : '',
    positionTicks: boundedTicks(message.positionTicks),
    durationTicks: boundedTicks(message.durationTicks),
    seekEnabled: message.seekEnabled === true && !['stopped', 'preparing', 'error'].includes(message.state),
  }
  publishCompanionState()
}

function handleSearchState(message) {
  const state = boundedText(message.state, 32).toLowerCase()
  if (state !== 'active' && state !== 'inactive') return
  const query = state === 'active' ? normalizedSearchQuery(message.query ?? '') : ''
  if (query === null) return

  companionState.searchInputActive = state === 'active'
  companionState.searchQuery = query
  publishCompanionState()
  setActivity(
    state === 'active'
      ? '眼镜已进入搜索，手机输入会实时同步。'
      : '眼镜已退出搜索。',
    'ready',
  )
}

function handleGlassesMessage(payload) {
  if (!payload || typeof payload !== 'object') return
  try {
    if (JSON.stringify(payload).length > 8192) return
  } catch { return }
  const type = boundedText(payload.type, 32).toLowerCase()
  if (type === 'set_language') {
    setLanguage(payload.value)
    return
  }
  if (type === 'set_ui_theme' || type === 'set_subtitle_size') {
    setAppearancePreference(type === 'set_ui_theme' ? 'uiTheme' : 'subtitleSize', payload.value)
    return
  }
  if (type === 'runtime_state') {
    handleRuntimeState(payload)
    return
  }
  if (type === 'playback_state') {
    handlePlaybackState(payload)
    return
  }
  if (type === 'search_state') {
    handleSearchState(payload)
    return
  }
  if (type === 'manage_login') {
    postToFrame('companion', 'open-screen', { screen: session ? 'settings' : 'connect' })
    return
  }
  if (type === 'logout') resetSession(false)
  if (type === 'unauthorized' && payload.catalogGeneration === catalogGeneration) resetSession(true)
}

window.addEventListener('message', (event) => {
  const fromCompanion = event.source === companionFrame.contentWindow
    && event.origin === origins.companion
  const fromGlasses = event.source === glassesFrame.contentWindow
    && event.origin === origins.glasses
  if (!fromCompanion && !fromGlasses) return
  const message = event.data
  if (!message || typeof message !== 'object' || message.channel !== channel) return
  if (!isBoundedMessage(message)) return

  if (fromCompanion && message.role === 'companion') {
    if (message.type === 'ready') {
      frameReady.companion = true
      publishCompanionState()
    } else if (message.type === 'call') {
      handleCompanionCall(message.payload)
    }
    return
  }

  if (fromGlasses && message.role === 'glasses') {
    if (message.type === 'ready') {
      frameReady.glasses = true
      publishGlassesBootstrap()
      publishCompanionState()
    } else if (message.type === 'message') {
      handleGlassesMessage(message.payload)
    }
  }
})

function frameUrl(origin, role, reload = '') {
  const url = new URL('/', origin)
  url.searchParams.set('rayneo-dev-role', role)
  url.searchParams.set('rayneo-dev-parent', window.location.origin)
  if (reload) url.searchParams.set('reload', reload)
  return url.toString()
}

function loadFrames(reload = '') {
  frameReady.companion = false
  frameReady.glasses = false
  companionState.glassesPresentationReady = false
  companionState.glassesRuntimeState = session ? 'booting' : 'no-session'
  companionState.searchInputActive = false
  companionState.searchQuery = ''
  companionFrame.src = frameUrl(origins.companion, 'companion', reload)
  glassesFrame.src = frameUrl(origins.glasses, 'glasses', reload)
  publishCompanionState()
  refreshStatus()
  setActivity('正在重载手机端与眼镜端页面…', 'busy')
}

const initialReload = (() => {
  const value = new URLSearchParams(window.location.search || '').get('reload') || ''
  return value.length <= 64 ? value : ''
})()

function updateFrameScale(canvas, scaler, width, height) {
  const inset = 28
  const availableWidth = Math.max(1, canvas.clientWidth - inset * 2)
  const availableHeight = Math.max(1, canvas.clientHeight - inset * 2)
  const scale = Math.min(availableWidth / width, availableHeight / height, 1)
  scaler.style.setProperty('--frame-width', `${width}px`)
  scaler.style.setProperty('--frame-height', `${height}px`)
  scaler.style.setProperty('--frame-scale', String(scale))
}

function updateViewportLayout() {
  const [phoneWidth, phoneHeight] = phonePreset.value.split('x').map(Number)
  phoneSize.textContent = `${phoneWidth} × ${phoneHeight} CSS px`
  updateFrameScale(phoneCanvas, phoneScaler, phoneWidth, phoneHeight)
  updateFrameScale(glassesCanvas, glassesScaler, 1_920, 1_080)
}

const storedPreset = window.localStorage.getItem('rayneo-dual-ui-phone-viewport')
if (phonePresets.has(storedPreset)) phonePreset.value = storedPreset
phonePreset.addEventListener('change', () => {
  if (!phonePresets.has(phonePreset.value)) phonePreset.value = '360x800'
  window.localStorage.setItem('rayneo-dual-ui-phone-viewport', phonePreset.value)
  updateViewportLayout()
  setActivity(`手机 WebView 已切换为 ${phonePreset.value.replace('x', ' × ')} CSS px。`, 'ready')
})

document.querySelector('#load-session').addEventListener('click', () => {
  void restoreDevelopmentSession()
})
document.querySelector('#clear-session').addEventListener('click', () => resetSession(false))
document.querySelector('#reload-frames').addEventListener('click', () => loadFrames(String(Date.now())))

const resizeObserver = new ResizeObserver(updateViewportLayout)
resizeObserver.observe(phoneCanvas)
resizeObserver.observe(glassesCanvas)
window.addEventListener('resize', updateViewportLayout)

loadFrames(initialReload)
updateViewportLayout()
void restoreDevelopmentSession()
