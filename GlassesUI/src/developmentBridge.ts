import { parseSeekCommand, parseScrubCommand } from '../../SharedUI/seekCommand.mjs'
const channel = 'jellyfin-rayneo-dual-ui-v1'
const maximumMessageLength = 16_384
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
const glassesMessageTypes = new Set([
  'manage_login',
  'logout',
  'unauthorized',
  'playback_state',
  'runtime_state',
  'search_state',
  'set_ui_theme',
  'set_subtitle_size',
  'set_language',
])

type BridgeMessage = {
  channel?: unknown
  role?: unknown
  target?: unknown
  type?: unknown
  payload?: unknown
}

const initialBootstrap = {
  source: 'android',
  displayMode: 'mirror_2d',
  uiTheme: 'liquid-glass',
  subtitleSize: 'normal',
  language: 'system',
  systemLanguage: navigator.language,
  glassesConnected: true,
  catalogGeneration: 0,
  session: null,
}

function boundedText(value: unknown, maximumLength: number) {
  return typeof value === 'string' ? value.slice(0, maximumLength) : ''
}

function developmentParentOrigin() {
  if (!import.meta.env.DEV || window.parent === window) return ''
  const parameters = new URLSearchParams(window.location.search)
  if (parameters.get('rayneo-dev-role') !== 'glasses') return ''

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

function isBounded(value: unknown) {
  try {
    return JSON.stringify(value).length <= maximumMessageLength
  } catch {
    return false
  }
}

export function installDevelopmentBridge() {
  const parentOrigin = developmentParentOrigin()
  if (!parentOrigin || window.RayNeoGlasses) return false

  let bootstrap: object = initialBootstrap
  const post = (type: string, payload: object = {}) => {
    const message = { channel, role: 'glasses', type, payload }
    if (!isBounded(message)) return
    try {
      window.parent.postMessage(message, parentOrigin)
    } catch {
      // The harness and this frame can hot-reload independently.
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return
    const message = event.data as BridgeMessage
    if (!message || typeof message !== 'object' || message.channel !== channel) return
    if (message.role !== 'harness' || message.target !== 'glasses') return

    if (message.type === 'bootstrap' && message.payload && typeof message.payload === 'object') {
      if (!isBounded(message.payload)) return
      bootstrap = message.payload
      window.LucentNative?.receiveBootstrapState?.(message.payload as never)
      return
    }

    if (message.type === 'remote-command') {
      const requestedCommand = boundedText(
        (message.payload as { command?: unknown } | null)?.command,
        64,
      ).toLowerCase()
      const validSearchText = /^search-text:[a-z0-9 ]{0,48}$/.test(requestedCommand)
      if (!remoteCommands.has(requestedCommand)
        && parseSeekCommand(requestedCommand) === null
        && parseScrubCommand(requestedCommand) === null
        && !validSearchText
        && !/^volume:(?:100|[1-9]?\d)$/.test(requestedCommand)) return
      const command = requestedCommand === 'submit' ? 'enter' : requestedCommand
      window.dispatchEvent(new CustomEvent('rayneo-remote-command', { detail: command }))
      const keys: Record<string, string | undefined> = {
        up: 'ArrowUp',
        down: 'ArrowDown',
        left: 'ArrowLeft',
        right: 'ArrowRight',
        enter: 'Enter',
        back: 'Escape',
      }
      const key = keys[command]
      const target = document.activeElement instanceof Element
        ? document.activeElement
        : document.body
      if (key && target instanceof Element) {
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key,
          bubbles: true,
          cancelable: true,
        }))
      }
    }
  })

  window.RayNeoGlasses = Object.freeze({
    getBootstrapState: () => JSON.stringify(bootstrap),
    getHardwareVideoCodecs: () => JSON.stringify(['h264']),
    ready: () => post('ready'),
    postMessage: (value: string) => {
      if (typeof value !== 'string' || value.length > 8_192) return
      try {
        const message = JSON.parse(value) as Record<string, unknown>
        const type = boundedText(message.type, 32).toLowerCase()
        if (glassesMessageTypes.has(type) && isBounded(message)) post('message', message)
      } catch {
        // Android also ignores malformed glasses messages.
      }
    },
  })

  post('ready')
  return true
}
