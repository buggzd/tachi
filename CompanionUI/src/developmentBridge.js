import { parseSeekCommand, parseScrubCommand } from '../../SharedUI/seekCommand.mjs'
const CHANNEL = 'jellyfin-rayneo-dual-ui-v1'
const MAX_MESSAGE_LENGTH = 65_536
const allowedScreens = new Set(['connect', 'auth', 'home', 'settings', 'accounts', 'touchpad'])
const allowedRemoteCommands = new Set([
  'up',
  'down',
  'left',
  'right',
  'submit',
  'back',
  'search-submit',
  'search-keyboard-visible',
  'search-keyboard-hidden',
])

const initialState = {
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
  uiTheme: 'liquid-glass',
  touchpadBackground: 'texture',
  companionGlassTransparency: 88,
  subtitleSize: 'normal',
  language: 'system',
  systemLanguage: navigator.language,
  activeDisplayMode: 'mirror_2d',
  displayModeApplied: true,
  displayModeTransitioning: false,
  displayMessage: '浏览器双端联调模式',
  discoveryMessage: '',
  discoveryError: false,
  discoveryScanning: false,
  playback: {
    state: 'stopped',
    itemId: '',
    title: '',
    subtitle: '',
    playMethod: '',
    positionTicks: 0,
    durationTicks: 0,
    seekEnabled: false,
  },
  servers: [],
}

function boundedText(value, maximumLength) {
  return typeof value === 'string' ? value.slice(0, maximumLength) : ''
}

function developmentParentOrigin() {
  if (!import.meta.env.DEV || window.parent === window) return ''
  const parameters = new URLSearchParams(window.location.search)
  if (parameters.get('rayneo-dev-role') !== 'companion') return ''

  try {
    const value = parameters.get('rayneo-dev-parent') || ''
    const url = new URL(value)
    const loopback = url.hostname === '127.0.0.1'
      || url.hostname === 'localhost'
      || url.hostname === '[::1]'
    return loopback && (url.protocol === 'http:' || url.protocol === 'https:')
      ? url.origin
      : ''
  } catch {
    return ''
  }
}

function safePost(parentOrigin, type, payload = {}) {
  const message = { channel: CHANNEL, role: 'companion', type, payload }
  try {
    if (JSON.stringify(message).length > MAX_MESSAGE_LENGTH) return
    window.parent.postMessage(message, parentOrigin)
  } catch {
    // The harness can be refreshed independently; calls are best effort during reloads.
  }
}

export function installDevelopmentBridge() {
  const parentOrigin = developmentParentOrigin()
  if (!parentOrigin || window.JellyfinNative) return false

  let state = initialState

  const call = (method, args = []) => safePost(parentOrigin, 'call', { method, args })
  const receiveState = (next) => {
    if (!next || typeof next !== 'object') return
    try {
      if (JSON.stringify(next).length > MAX_MESSAGE_LENGTH) return
    } catch {
      return
    }
    state = next
    window.LumaNative?.receiveState?.(JSON.stringify(next))
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return
    const message = event.data
    if (!message || typeof message !== 'object' || message.channel !== CHANNEL) return
    if (message.role !== 'harness' || message.target !== 'companion') return

    if (message.type === 'state') {
      receiveState(message.payload)
      return
    }
    if (message.type === 'open-screen') {
      const screen = boundedText(message.payload?.screen, 24).toLowerCase()
      if (allowedScreens.has(screen)) window.LumaNative?.openScreen?.(screen)
      return
    }
    if (message.type === 'handle-back') window.LumaNative?.handleBack?.()
  })

  window.JellyfinNative = Object.freeze({
    getState: () => JSON.stringify(state),
    ready: () => safePost(parentOrigin, 'ready'),
    scan: () => call('scan'),
    selectServer: (serverUrl, serverName) => call('selectServer', [
      boundedText(serverUrl, 2_048),
      boundedText(serverName, 512),
    ]),
    login: (serverUrl, username, password, rememberSession) => call('login', [
      boundedText(serverUrl, 2_048),
      boundedText(username, 512),
      boundedText(password, 4_096),
      Boolean(rememberSession),
    ]),
    startQuickConnect: (serverUrl) => call('startQuickConnect', [boundedText(serverUrl, 2_048)]),
    cancelQuickConnect: () => call('cancelQuickConnect'),
    clearSession: () => call('clearSession'),
    activateSession: (id) => { if (typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) call('activateSession', [id]) },
    removeSession: (id) => { if (typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) call('removeSession', [id]) },
    retryGlasses: () => call('retryGlasses'),
    shareDiagnostics: () => call('shareDiagnostics'),
    selectDisplayMode: (mode) => call('selectDisplayMode', [boundedText(mode, 32)]),
    selectUiTheme: (theme) => {
      if (theme === 'liquid-glass' || theme === 'simpleUI') call('selectUiTheme', [theme])
    },
    selectTouchpadBackground: (background) => {
      if (background === 'texture' || background === 'black') call('selectTouchpadBackground', [background])
    },
    setCompanionGlassTransparency: (value) => {
      if (typeof value === 'string' && value.length <= 3 && /^(0|[1-9][0-9]?|100)$/.test(value) && String(Number(value)) === value) call('setCompanionGlassTransparency', [value])
    },
    selectLanguage: (language) => {
      if (['system', 'zh-CN', 'en'].includes(language)) call('selectLanguage', [language])
    },
    selectSubtitleSize: (size) => {
      if (['small', 'normal', 'large', 'extra-large'].includes(size)) call('selectSubtitleSize', [size])
    },
    copyQuickConnectCode: () => {
      const code = boundedText(state.quickConnectCode, 32)
      if (code) void navigator.clipboard?.writeText(code)
    },
    openQuickConnectAuthorization: () => call('openQuickConnectAuthorization'),
    remoteCommand: (value, haptic) => {
      const command = boundedText(value, 32).toLowerCase()
      if (allowedRemoteCommands.has(command) || parseSeekCommand(command) !== null || parseScrubCommand(command) !== null) call('remoteCommand', [command, Boolean(haptic)])
    },
    searchText: (value) => {
      const query = boundedText(value, 49).toLowerCase()
      if (query.length <= 48 && /^[a-z0-9 ]*$/.test(query)) call('searchText', [query])
    },
    previewHaptic: () => navigator.vibrate?.(8),
    screenChanged: (value) => {
      const screen = boundedText(value, 24).toLowerCase()
      if (allowedScreens.has(screen)) call('screenChanged', [screen])
    },
  })

  safePost(parentOrigin, 'ready')
  return true
}
