import { useLanguage } from './useLanguage'
import { applyLanguage, getLanguage, isLanguage, savePreviewLanguage, nativeMessage, t } from '../../SharedUI/i18n.mjs'
import { CircularSeekGesture } from './circularSeek.mjs'
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { applyUiTheme, normalizeUiTheme, readPreviewTheme, savePreviewTheme } from '../../SharedUI/theme.mjs'
import { suspendHiddenAnimations } from '../../SharedUI/hiddenAnimations.mjs'
import { SUBTITLE_SIZES, isSubtitleSize, normalizeSubtitleSize, readPreviewSubtitleSize, savePreviewSubtitleSize } from '../../SharedUI/subtitles.mjs'
import { Toast, usePresence } from './feedback'
import { usePhoneBackground } from './phoneBackground'
import BackgroundEditor, { BackgroundArtwork } from './BackgroundEditor'
import { useWallpaperContrast } from './useWallpaperContrast'
import { DEFAULT_GLASS_TRANSPARENCY, validGlassTransparency, normalizeGlassTransparency, liquidSurfaceStyle, readPreviewGlassTransparency, savePreviewGlassTransparency } from './liquidAppearance.mjs'
import { isTouchpadBackground, normalizeTouchpadBackground, readPreviewTouchpadBackground, savePreviewTouchpadBackground } from './touchpadBackground'
import {
  ArrowLeft,
  ArrowRight,
  Box,
  BookOpen,
  Check,
  ChevronRight,
  ChevronDown,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Glasses,
  Github,
  ImagePlus,
  KeyRound,
  Link2,
  LoaderCircle,
  Info,
  LockKeyhole,
  Monitor,
  MessageSquare,
  Languages,
  MoreHorizontal,
  Plus,
  Palette,
  Radar,
  Radio,
  RefreshCw,
  RotateCcw,
  Router,
  Search,
  Server,
  Settings2,
  Share2,
  ShieldCheck,
  UserRound,
  Trash2,
  Touchpad,
  Vibrate,
  Wifi,
  X,
  Zap,
} from 'lucide-react'

const DEMO_SERVERS = [
  {
    id: 'jellyfin-home',
    get name() { return t("家庭媒体库") },
    host: 'jellyfin.local:8096',
    detail: 'Jellyfin 10.10',
    latency: '8 ms',
    strength: 3,
  },
  {
    id: 'media-nas',
    name: 'Media NAS',
    host: 'media.local:8096',
    detail: 'Jellyfin 10.10',
    latency: '21 ms',
    strength: 2,
  },
]

const DEFAULT_STEREO_SCREEN = { depthLevel: 1, sizePercent: 90 }
const DEPTH_LABELS = ["基准", "轻微", "适中", "较近"]

function validStereoScreen(value) {
  return value && Number.isInteger(value.depthLevel) && value.depthLevel >= 0 && value.depthLevel <= 3
    && Number.isInteger(value.sizePercent) && value.sizePercent >= 80 && value.sizePercent <= 95
}

function sameStereoScreen(first, second) {
  return first?.depthLevel === second?.depthLevel && first?.sizePercent === second?.sizePercent
}

const assetUrl = (name) => `${import.meta.env.BASE_URL}art/${name}`

function hasNativeBridge() {
  return typeof window !== 'undefined' && typeof window.JellyfinNative === 'object'
}

function callNative(method, ...args) {
  if (!hasNativeBridge() || typeof window.JellyfinNative[method] !== 'function') return undefined
  try {
    return window.JellyfinNative[method](...args)
  } catch {
    return undefined
  }
}

function parseNativePayload(payload) {
  if (!payload) return null
  if (typeof payload === 'object') return payload
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

function serverFromNative(state) {
  if (!state?.serverUrl) return null
  return {
    id: state.serverId || state.serverUrl,
    name: state.serverName || t("Jellyfin 媒体库"),
    host: state.serverUrl,
    detail: state.serverVersion ? `Jellyfin ${state.serverVersion}` : t("Jellyfin 服务器"),
    get latency() { return t("已保存") },
    strength: 3,
  }
}

function sameServer(server, account) {
  if (server.id && server.id !== 'manual' && server.id === account.serverId) return true
  const normalize = (value) => {
    try {
      const address = /^https?:\/\//i.test(value) ? value : `http://${value}`
      return new URL(address).href.replace(/\/+$/, '')
    } catch {
      return ''
    }
  }
  const address = normalize(server.host)
  return Boolean(address) && address === normalize(account.serverUrl)
}

function profileInitials(username) {
  const normalized = (username || 'Jellyfin').trim()
  if (!normalized) return 'JF'
  return normalized.slice(0, 2).toUpperCase()
}

function formatQuickCode(value) {
  const compact = (value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  if (compact.length <= 3) return compact
  return `${compact.slice(0, 3)} · ${compact.slice(3)}`
}

function formatPlaybackTime(ticks) {
  const seconds = Math.max(0, Math.floor(Number(ticks || 0) / 10_000_000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remaining = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`
}

function normalizeRemoteSearchQuery(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/ {2,}/g, ' ')
    .slice(0, 48)
}

function useStoredState(key, initialValue, enabled = true) {
  const [value, setValue] = useState(() => {
    try {
      const stored = enabled ? localStorage.getItem(key) : null
      return stored ? JSON.parse(stored) : initialValue
    } catch {
      return initialValue
    }
  })

  useEffect(() => {
    if (enabled && value?.saved !== false) localStorage.setItem(key, JSON.stringify(value))
    else localStorage.removeItem(key)
  }, [key, value, enabled])

  return [value, setValue]
}

function App() {
  useLanguage()
  const isNative = useMemo(() => hasNativeBridge(), [])
  const [screenAspect, setScreenAspect] = useState(() => phoneScreenAspect(isNative))
  useEffect(() => {
    const resize = () => setScreenAspect(phoneScreenAspect(isNative))
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [isNative])
  const [uiTheme, setUiTheme] = useState(() => isNative
    ? normalizeUiTheme(parseNativePayload(callNative('getState'))?.uiTheme)
    : readPreviewTheme())
  const simpleUi = uiTheme === 'simpleUI'
  const [touchpadPreference, setTouchpadPreference] = useState(() => isNative
    ? parseNativePayload(callNative('getState'))?.touchpadBackground
    : readPreviewTouchpadBackground())
  const touchpadBackground = normalizeTouchpadBackground(touchpadPreference, uiTheme)
  const [glassTransparency, setGlassTransparency] = useState(() => isNative
    ? normalizeGlassTransparency(parseNativePayload(callNative('getState'))?.companionGlassTransparency)
    : readPreviewGlassTransparency())
  const pendingGlassTransparency = useRef(null)
  const [subtitleSize, setSubtitleSize] = useState(() => isNative
    ? normalizeSubtitleSize(parseNativePayload(callNative('getState'))?.subtitleSize)
    : readPreviewSubtitleSize())
  useLayoutEffect(() => { applyUiTheme(uiTheme) }, [uiTheme])
  const [session, setSession] = useStoredState('jellyfin-rayneo-session', null, !isNative)
  const [demoAccounts, setDemoAccounts] = useState(() => {
    if (isNative) return []
    try {
      const stored = JSON.parse(localStorage.getItem('jellyfin-rayneo-accounts') || '[]')
      if (Array.isArray(stored) && stored.length) return stored.slice(0, 12)
    } catch { /* A missing preview history starts empty. */ }
    return session ? [{ ...session, id: session.id || 'demo-restored', saved: true }] : []
  })
  const [pendingRemoval, setPendingRemoval] = useState(null)
  const pendingRemovalRef = useRef(null)
  pendingRemovalRef.current = pendingRemoval
  const activeSessionIdRef = useRef('')
  const accountsAvailableRef = useRef(false)
  const authReturnRef = useRef('connect')
  const demoLoginTimer = useRef(null)
  const [displayMode, setDisplayMode] = useStoredState('jellyfin-rayneo-display', 'stereo')
  const [haptics, setHaptics] = useStoredState('jellyfin-rayneo-haptics', true)
  const [screen, setScreen] = useState(() => (!isNative && session ? 'home' : 'connect'))
  const blackTouchpad = screen === 'touchpad' && touchpadBackground === 'black'
  useLayoutEffect(() => {
    const root = document.documentElement
    if (screen === 'touchpad') root.dataset.touchpadBackground = touchpadBackground
    else delete root.dataset.touchpadBackground
    return () => { delete root.dataset.touchpadBackground }
  }, [screen, touchpadBackground])
  const [selectedServer, setSelectedServer] = useState(DEMO_SERVERS[0])
  const [servers, setServers] = useState(() => (isNative ? [] : DEMO_SERVERS))
  const [authMode, setAuthMode] = useState('password')
  const [manualOpen, setManualOpen] = useState(false)
  const manualMounted = usePresence(manualOpen)
  const manualOpenRef = useRef(false)
  const [toast, setToast] = useState('')
  const [nativeState, setNativeState] = useState(null)
  const [stereoScreen, setStereoScreen] = useState(DEFAULT_STEREO_SCREEN)
  const [demoStereoTestPattern, setDemoStereoTestPattern] = useState(false)
  const stereoScreenRef = useRef(DEFAULT_STEREO_SCREEN)
  const pendingStereoRef = useRef(null)
  const toastTimer = useRef(null)
  const screenRef = useRef(screen)
  const touchpadReadyRef = useRef(false)
  const searchInputActiveRef = useRef(false)
  const lastNativeErrorRef = useRef('')
  const lastNativePayloadRef = useRef('')
  const opticsFrameRef = useRef(0)
  const opticsSampleRef = useRef(null)
  const opticsButtonRef = useRef(null)
  const opticsRectRef = useRef(null)

  useEffect(() => {
    if (!simpleUi) return
    if (opticsFrameRef.current) window.cancelAnimationFrame(opticsFrameRef.current)
    opticsFrameRef.current = 0
    opticsSampleRef.current = null
    opticsButtonRef.current = null
    opticsRectRef.current = null
  }, [simpleUi])

  const accounts = isNative ? nativeState?.accounts || [] : demoAccounts.map((account) => ({
    id: account.id,
    serverUrl: account.server.host,
    serverName: account.server.name,
    serverId: account.server.id,
    username: account.username,
    saved: account.saved !== false,
    active: session?.id === account.id || (!session?.id && session?.username === account.username
      && session?.server.host === account.server.host),
  }))
  accountsAvailableRef.current = accounts.length > 0

  useEffect(() => {
    if (isNative) localStorage.removeItem('jellyfin-rayneo-accounts')
    else localStorage.setItem('jellyfin-rayneo-accounts', JSON.stringify(demoAccounts.filter((account) => account.saved !== false)))
  }, [isNative, demoAccounts])

  const notify = (message, tone = 'info') => {
    window.clearTimeout(toastTimer.current)
    setToast({ text: message, tone })
    toastTimer.current = window.setTimeout(() => setToast(''), tone === 'error' ? 4000 : 2400)
  }

  const background = usePhoneBackground(nativeState, notify)
  const wallpaperScope = useRef(null)
  useWallpaperContrast(wallpaperScope, background, background.layout, screenAspect,
    !simpleUi && Boolean(background.url) && screen !== 'touchpad', '.ambient--custom', glassTransparency)

  const go = (next) => {
    if (next !== 'settings') background.closeEditor()
    window.scrollTo({ top: 0, behavior: 'instant' })
    if (next === 'touchpad') setToast('')
    if (next !== 'settings') setDemoStereoTestPattern(false)
    screenRef.current = next
    setScreen(next)
  }

  useEffect(() => {
    manualOpenRef.current = manualOpen
  }, [manualOpen])

  useEffect(() => () => {
    window.clearTimeout(toastTimer.current)
    window.clearTimeout(demoLoginTimer.current)
  }, [])

  useEffect(() => {
    screenRef.current = screen
    if (isNative) callNative('screenChanged', screen)
  }, [isNative, screen])

  useEffect(() => {
    const invalidateOpticsRect = () => {
      opticsRectRef.current = null
    }

    window.addEventListener('scroll', invalidateOpticsRect, true)
    window.addEventListener('resize', invalidateOpticsRect)
    return () => {
      window.removeEventListener('scroll', invalidateOpticsRect, true)
      window.removeEventListener('resize', invalidateOpticsRect)
      if (opticsFrameRef.current) {
        window.cancelAnimationFrame(opticsFrameRef.current)
        opticsFrameRef.current = 0
      }
    }
  }, [])

  useEffect(() => {
    if (!isNative) return undefined

    const receiveState = (payload) => {
      const next = parseNativePayload(payload)
      if (!next) return
      const signature = typeof payload === 'string' ? payload : JSON.stringify(next)
      if (signature === lastNativePayloadRef.current) return
      lastNativePayloadRef.current = signature

      setNativeState(next)
      setUiTheme(normalizeUiTheme(next.uiTheme))
      setTouchpadPreference(next.touchpadBackground)
      const nextTransparency = normalizeGlassTransparency(next.companionGlassTransparency)
      if (pendingGlassTransparency.current === null || nextTransparency === pendingGlassTransparency.current) {
        pendingGlassTransparency.current = null
        setGlassTransparency(nextTransparency)
      }
      setSubtitleSize(normalizeSubtitleSize(next.subtitleSize))
      applyLanguage(next.language, next.systemLanguage)
      setDisplayMode(next.displayMode === 'stereo_screen' ? 'stereo' : 'mirror')
      // Ignore an older acknowledgement while the latest slider/button edit is still in flight.
      if (validStereoScreen(next.stereoScreen)
        && (!pendingStereoRef.current || sameStereoScreen(next.stereoScreen, pendingStereoRef.current))) {
        pendingStereoRef.current = null
        stereoScreenRef.current = next.stereoScreen
        setStereoScreen(next.stereoScreen)
      }
      setServers(Array.isArray(next.servers) ? next.servers : [])

      const stateServer = serverFromNative(next)
      const loginServer = serverFromNative({
        serverUrl: next.loginServerUrl,
        serverName: next.loginServerName,
      })
      if (loginServer) setSelectedServer(loginServer)
      const previousSessionId = activeSessionIdRef.current
      activeSessionIdRef.current = next.sessionAvailable ? next.activeSessionId : ''

      if (next.sessionAvailable) {
        const activeServer = stateServer || selectedServer
        setSession({
          id: next.activeSessionId,
          username: next.username || 'Jellyfin',
          server: activeServer,
          restored: true,
          saved: Boolean(next.sessionSaved),
        })
        if (!previousSessionId && (screenRef.current === 'connect' || screenRef.current === 'auth')) go('home')
      } else {
        setSession(null)
        if (['home', 'settings', 'touchpad'].includes(screenRef.current)) {
          go(next.accounts?.length ? 'accounts' : 'connect')
        }
      }

      if (next.state === 'quick_connect_waiting') {
        setAuthMode('quick')
        if (screenRef.current !== 'touchpad') go('auth')
      }

      if (next.isError && next.message && next.message !== lastNativeErrorRef.current) {
        lastNativeErrorRef.current = next.message
        notify(nativeMessage(next.message), 'error')
      } else if (!next.isError) {
        lastNativeErrorRef.current = ''
      }

      const touchpadBecameReady = Boolean(next.touchpadReady) && !touchpadReadyRef.current
      touchpadReadyRef.current = Boolean(next.touchpadReady)
      if (touchpadBecameReady && !background.editingRef.current && (screenRef.current === 'home' || screenRef.current === 'settings')) {
        go('touchpad')
      }

      const searchInputBecameActive = Boolean(next.searchInputActive) && !searchInputActiveRef.current
      searchInputActiveRef.current = Boolean(next.searchInputActive)
      if (searchInputBecameActive && (screenRef.current === 'home' || screenRef.current === 'settings')) {
        go('touchpad')
      }
    }

    const nativeApi = {
      receiveState,
      openScreen: (requestedScreen) => {
        if (!['home', 'settings', 'accounts', 'connect', 'auth'].includes(requestedScreen)) return
        setManualOpen(false)
        setPendingRemoval(null)
        setAuthMode('password')
        go(requestedScreen)
      },
      handleBack: () => {
        if (background.editingRef.current) {
          background.cancelEditor()
          return
        }
        if (pendingRemovalRef.current) {
          setPendingRemoval(null)
          return
        }
        if (manualOpenRef.current) {
          setManualOpen(false)
          return
        }
        if (screenRef.current === 'touchpad' || screenRef.current === 'settings') {
          go('home')
        } else if (screenRef.current === 'auth') {
          callNative('cancelQuickConnect')
          setAuthMode('password')
          go(authReturnRef.current)
        } else if (screenRef.current === 'accounts') {
          go(activeSessionIdRef.current ? 'settings' : 'connect')
        } else if (screenRef.current === 'connect' && accountsAvailableRef.current) {
          go('accounts')
        }
      },
    }
    window.LumaNative = nativeApi

    receiveState(callNative('getState'))
    callNative('ready')

    return () => {
      if (window.LumaNative === nativeApi) delete window.LumaNative
    }
  }, [isNative])

  const openLogin = (server, returnScreen = 'connect') => {
    authReturnRef.current = returnScreen
    setSelectedServer(server)
    if (isNative) callNative('selectServer', server.host, server.name)
    setAuthMode('password')
    go('auth')
  }

  const chooseServer = (server) => {
    const matching = accounts.some((account) => sameServer(server, account))
    if (matching) go('accounts')
    else openLogin(server)
  }

  const finishLogin = (username = 'demo', remember = true) => {
    const existing = demoAccounts.find((account) => account.server.host === selectedServer.host && account.username === username)
    if (!existing && demoAccounts.length >= 12) {
      notify(t("最多保留 12 个账号，请先移除一个不再使用的账号"), 'error')
      return
    }
    const nextSession = {
      id: existing?.id || crypto.randomUUID().replaceAll('-', ''),
      username,
      server: selectedServer,
      restored: false,
      saved: remember,
    }
    setDemoAccounts((current) => [...current.filter((account) => account.id !== nextSession.id), nextSession])
    setSession(nextSession)
    go('home')
    notify(remember ? t("连接就绪，账号已保存") : t("连接就绪，仅本次运行保留"), 'success')
  }

  const activateAccount = (account) => {
    if (isNative) callNative('activateSession', account.id)
    else {
      const saved = demoAccounts.find((entry) => entry.id === account.id)
      if (saved) {
        setSession(saved)
        setSelectedServer(saved.server)
        go('home')
      }
    }
  }

  const removeAccount = () => {
    if (!pendingRemoval) return
    if (isNative) callNative('removeSession', pendingRemoval.id)
    else {
      setDemoAccounts((current) => current.filter((account) => account.id !== pendingRemoval.id))
      if (pendingRemoval.active) setSession(null)
    }
    setPendingRemoval(null)
  }

  const leaveLogin = () => {
    window.clearTimeout(demoLoginTimer.current)
    if (isNative) callNative('cancelQuickConnect')
    setAuthMode('password')
    go(authReturnRef.current)
  }

  const login = (username, password, remember) => {
    if (!isNative) {
      demoLoginTimer.current = window.setTimeout(() => finishLogin(username, remember), 820)
      return
    }
    callNative('login', selectedServer.host, username, password, remember)
  }

  const beginQuickConnect = () => {
    if (isNative) callNative('startQuickConnect', selectedServer.host)
  }

  const cancelQuickConnect = () => {
    if (isNative) callNative('cancelQuickConnect')
    setAuthMode('password')
  }

  const changeDisplayMode = (mode) => {
    setDisplayMode(mode)
    if (mode !== 'stereo') setDemoStereoTestPattern(false)
    if (isNative) {
      callNative('selectDisplayMode', mode === 'stereo' ? 'stereo_screen' : 'mirror_2d')
    }
  }

  const changeUiTheme = (theme) => {
    if (theme !== 'liquid-glass' && theme !== 'simpleUI') return
    if (isNative) callNative('selectUiTheme', theme)
    else {
      setUiTheme(theme)
      savePreviewTheme(theme)
    }
  }

  const changeTouchpadBackground = (value) => {
    if (!isTouchpadBackground(value)) return
    if (isNative) callNative('selectTouchpadBackground', value)
    else {
      setTouchpadPreference(value)
      savePreviewTouchpadBackground(value)
    }
  }

  const changeGlassTransparency = (value) => {
    if (!validGlassTransparency(value)) return
    setGlassTransparency(value)
    if (isNative) {
      pendingGlassTransparency.current = value
      callNative('setCompanionGlassTransparency', String(value))
    } else savePreviewGlassTransparency(value)
  }

  const changeLanguage = (language) => {
    if (!isLanguage(language)) return
    if (isNative) callNative('selectLanguage', language)
    else {
      savePreviewLanguage(language)
      applyLanguage(language)
    }
  }

  const changeSubtitleSize = (size) => {
    if (!isSubtitleSize(size)) return
    if (isNative) callNative('selectSubtitleSize', size)
    else {
      setSubtitleSize(size)
      savePreviewSubtitleSize(size)
    }
  }

  const changeStereoScreen = (patch) => {
    const next = { ...stereoScreenRef.current, ...patch }
    if (!validStereoScreen(next) || sameStereoScreen(next, stereoScreenRef.current)) return
    stereoScreenRef.current = next
    setStereoScreen(next)
    if (isNative) {
      pendingStereoRef.current = next
      callNative('setStereoScreen', JSON.stringify(next))
    }
  }

  const changeStereoTestPattern = (enabled) => {
    if (isNative) callNative('setStereoTestPattern', enabled ? 'on' : 'off')
    else setDemoStereoTestPattern(enabled)
  }

  const openTouchpad = () => {
    if (isNative && !nativeState?.touchpadReady) {
      notify(nativeState?.glassesRuntimeState === 'error'
        ? nativeMessage(nativeState.message) || t("眼镜端媒体库连接失败，请先检查服务器地址和网络")
        : nativeState?.glassesConnected
          ? t("眼镜画面或媒体库仍在启动，请稍候")
          : t("连接 RayNeo Air 后即可使用触控板"))
      return
    }
    go('touchpad')
  }

  const resetPreferences = async () => {
    changeLanguage('system')
    if (background.busy || !(await background.clear())) return
    changeUiTheme('liquid-glass')
    changeTouchpadBackground('texture')
    changeGlassTransparency(DEFAULT_GLASS_TRANSPARENCY)
    changeSubtitleSize('normal')
    changeStereoTestPattern(false)
    changeStereoScreen(DEFAULT_STEREO_SCREEN)
    changeDisplayMode('mirror')
    setHaptics(true)
    notify(t("偏好已恢复默认"), 'success')
  }

  const moveButtonOptics = (event) => {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest('button')
    if (!button || button.classList.contains('sheet-scrim')) return

    const sample = opticsSampleRef.current || {}
    sample.button = button
    sample.clientX = event.clientX
    sample.clientY = event.clientY
    opticsSampleRef.current = sample
    if (opticsFrameRef.current) return

    opticsFrameRef.current = window.requestAnimationFrame(() => {
      opticsFrameRef.current = 0
      const latest = opticsSampleRef.current
      if (!latest?.button?.isConnected) return

      if (opticsButtonRef.current !== latest.button) {
        opticsButtonRef.current = latest.button
        opticsRectRef.current = null
      }
      const rect = opticsRectRef.current || latest.button.getBoundingClientRect()
      opticsRectRef.current = rect
      const normalizedX = Math.max(-1, Math.min(1, ((latest.clientX - rect.left) / rect.width - 0.5) * 2))
      const normalizedY = Math.max(-1, Math.min(1, ((latest.clientY - rect.top) / rect.height - 0.5) * 2))
      const angle = 135 + normalizedX * 18 + normalizedY * 8
      const scaleX = 1 + Math.abs(normalizedX) * 0.008 - Math.abs(normalizedY) * 0.004
      const scaleY = 1 + Math.abs(normalizedY) * 0.008 - Math.abs(normalizedX) * 0.004

      latest.button.style.setProperty('--glass-x', `${50 + normalizedX * 31}%`)
      latest.button.style.setProperty('--glass-y', `${48 + normalizedY * 30}%`)
      latest.button.style.setProperty('--glass-angle', `${angle}deg`)
      latest.button.style.setProperty('--glass-shift-x', `${normalizedX * 1.35}px`)
      latest.button.style.setProperty('--glass-shift-y', `${normalizedY * 0.8}px`)
      latest.button.style.setProperty('--glass-scale-x', scaleX.toFixed(4))
      latest.button.style.setProperty('--glass-scale-y', scaleY.toFixed(4))
    })
  }

  const resetButtonOptics = (event) => {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest('button')
    if (!button || (event.relatedTarget && button.contains(event.relatedTarget))) return
    if (opticsSampleRef.current?.button === button) opticsSampleRef.current.button = null
    if (opticsButtonRef.current === button) {
      opticsButtonRef.current = null
      opticsRectRef.current = null
    }
    button.style.setProperty('--glass-x', '50%')
    button.style.setProperty('--glass-y', '48%')
    button.style.setProperty('--glass-angle', '135deg')
    button.style.setProperty('--glass-shift-x', '0px')
    button.style.setProperty('--glass-shift-y', '0px')
    button.style.setProperty('--glass-scale-x', '1')
    button.style.setProperty('--glass-scale-y', '1')
  }

  return (
    <div ref={wallpaperScope} data-wallpaper-scope="phone" style={liquidSurfaceStyle(glassTransparency)} className={`prototype-shell ${screen === 'touchpad' ? 'is-touchpad' : ''} ${isNative ? 'is-native' : ''} ${!simpleUi && background.url && screen !== 'touchpad' ? 'has-custom-background' : ''}`}>
      {!simpleUi && !blackTouchpad && <AmbientBackdrop dark={screen === 'touchpad'} background={background} screenAspect={screenAspect} />}
      <main
        className="phone-stage"
        onPointerMove={simpleUi || blackTouchpad ? undefined : moveButtonOptics}
        onPointerOut={simpleUi || blackTouchpad ? undefined : resetButtonOptics}
      >
        {!simpleUi && !blackTouchpad && <GlassOptics />}
        <input ref={background.input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={background.changeFile} />
        {screen !== 'touchpad' && <StatusBar />}

        <div className="screen-stack" inert={manualOpen || Boolean(pendingRemoval) || background.editing}>
          {screen === 'connect' && (
            <ConnectScreen
              simpleUi={simpleUi}
              session={session}
              servers={servers}
              scanning={Boolean(nativeState?.discoveryScanning)}
              onLanguageChange={changeLanguage}
              discoveryMessage={nativeState?.discoveryMessage || ''}
              onRestore={() => go('home')}
              onBack={accounts.length ? () => go('accounts') : null}
              onAccounts={accounts.length ? () => go('accounts') : null}
              onChoose={chooseServer}
              onManual={() => setManualOpen(true)}
              onScan={isNative ? () => callNative('scan') : null}
              notify={notify}
            />
          )}

          {screen === 'auth' && (
            <AuthScreen
              simpleUi={simpleUi}
              server={selectedServer}
              mode={authMode}
              setMode={setAuthMode}
              onBack={leaveLogin}
              onComplete={finishLogin}
              onLogin={login}
              onQuickStart={beginQuickConnect}
              onQuickCancel={cancelQuickConnect}
              onCopyCode={() => callNative('copyQuickConnectCode')}
              onOpenAuthorization={() => callNative('openQuickConnectAuthorization')}
              nativeState={nativeState}
              isNative={isNative}
              notify={notify}
            />
          )}

          {screen === 'home' && (
            <HomeScreen
              session={session}
              server={selectedServer}
              onTouchpad={openTouchpad}
              onRetry={() => callNative('retryGlasses')}
              onSettings={() => go('settings')}
              onAccounts={() => go('accounts')}
              deviceState={nativeState}
              notify={notify}
            />
          )}

          {screen === 'settings' && (
            <SettingsScreen
              uiTheme={uiTheme}
              background={background}
              screenAspect={screenAspect}
              onUiThemeChange={changeUiTheme}
              glassTransparency={glassTransparency}
              onGlassTransparencyChange={changeGlassTransparency}
              touchpadBackground={touchpadBackground}
              onTouchpadBackgroundChange={changeTouchpadBackground}
              onLanguageChange={changeLanguage}
              subtitleSize={subtitleSize}
              onSubtitleSizeChange={changeSubtitleSize}
              session={session}
              server={selectedServer}
              displayMode={displayMode}
              setDisplayMode={changeDisplayMode}
              stereoScreen={stereoScreen}
              onStereoScreenChange={changeStereoScreen}
              stereoTestPattern={isNative ? Boolean(nativeState?.stereoTestPattern) : demoStereoTestPattern}
              onStereoTestPatternChange={changeStereoTestPattern}
              isNative={isNative}
              haptics={haptics}
              setHaptics={setHaptics}
              onChangeAccount={() => go('accounts')}
              onReset={resetPreferences}
              onShareDiagnostics={() => {
                if (isNative) callNative('shareDiagnostics')
                else notify(t("原生应用会打开系统分享面板"))
              }}
              nativeState={nativeState}
            />
          )}

          {screen === 'accounts' && (
            <AccountsScreen
              accounts={accounts}
              onBack={() => go(session ? 'settings' : 'connect')}
              onAddServer={() => go('connect')}
              onAddAccount={(account) => openLogin(serverFromNative(account), 'accounts')}
              onActivate={activateAccount}
              onRemove={setPendingRemoval}
            />
          )}

          {screen === 'touchpad' && (
            <TouchpadScreen
              simpleUi={simpleUi}
              pureBlack={blackTouchpad}
              displayMode={displayMode}
              haptics={haptics}
              playback={nativeState?.playback}
              searchActive={Boolean(nativeState?.searchInputActive)}
              searchQuery={nativeState?.searchQuery || ''}
              onExit={() => go('home')}
              onCommand={(command, useHaptics = haptics) => callNative('remoteCommand', command, useHaptics)}
              onSearchAction={(command) => callNative('remoteCommand', command, false)}
              onSearchText={(value) => callNative('searchText', value)}
              native={isNative}
            />
          )}
        </div>

        {(screen === 'home' || screen === 'settings') && (
          <BottomNav
            active={screen}
            onHome={() => go('home')}
            onTouchpad={openTouchpad}
            onSettings={() => go('settings')}
          />
        )}

        {manualMounted && (
          <ManualServerSheet
            open={manualOpen}
            onClose={() => setManualOpen(false)}
            onContinue={(server) => {
              setManualOpen(false)
              chooseServer(server)
            }}
          />
        )}

        {pendingRemoval && (
          <RemoveAccountDialog account={pendingRemoval} onCancel={() => setPendingRemoval(null)} onConfirm={removeAccount} />
        )}
        {background.editing && screen === 'settings' && (
          <BackgroundEditor key={background.url} background={background} screenAspect={screenAspect} glassTransparency={glassTransparency} />
        )}
        <Toast message={toast} />
      </main>
    </div>
  )
}

function GlassOptics() {
  return (
    <svg className="glass-optics" aria-hidden="true">
      <defs>
        <filter id="luma-edge-refraction" x="-25%" y="-25%" width="150%" height="150%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.045" numOctaves="1" seed="7" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="2.3" xChannelSelector="R" yChannelSelector="B" result="warped" />
          <feColorMatrix in="warped" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red" />
          <feOffset in="red" dx="-0.5" dy="0" result="redShift" />
          <feColorMatrix in="warped" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green" />
          <feColorMatrix in="warped" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue" />
          <feOffset in="blue" dx="0.65" dy="0.15" result="blueShift" />
          <feBlend in="green" in2="blueShift" mode="screen" result="greenBlue" />
          <feBlend in="redShift" in2="greenBlue" mode="screen" />
        </filter>
        <filter id="luma-surface-refraction" x="-12%" y="-18%" width="124%" height="136%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.009 0.028" numOctaves="1" seed="11" result="surfaceNoise" />
          <feDisplacementMap in="SourceGraphic" in2="surfaceNoise" scale="4.5" xChannelSelector="R" yChannelSelector="B" />
        </filter>
      </defs>
    </svg>
  )
}

function phoneScreenAspect(native) {
  if (native || window.innerWidth < 680) return (native ? window.innerWidth : Math.min(430, window.innerWidth)) / window.innerHeight
  return 414 / Math.max(1, Math.min(900, window.innerHeight - 52) - 16)
}

function AmbientBackdrop({ dark, background, screenAspect }) {
  if (background.url && !dark) {
    return (
      <div className="ambient ambient--custom" aria-hidden="true">
        <BackgroundArtwork background={background} screenAspect={screenAspect} />
      </div>
    )
  }
  return (
    <div className={`ambient ${dark ? 'ambient--dark' : ''}`} aria-hidden="true">
      <div className="ambient__wash" />
      <div className="ambient__orb ambient__orb--one" />
      <div className="ambient__orb ambient__orb--two" />
      <div className="ambient__grain" />
    </div>
  )
}

function StatusBar() {
  return (
    <div className="status-bar" aria-hidden="true">
      <span data-wallpaper-text="">09:41</span>
      <div className="status-icons" data-wallpaper-text="">
        <span className="signal-bars"><i /><i /><i /><i /></span>
        <Wifi size={14} strokeWidth={2.3} />
        <span className="battery"><i /></span>
      </div>
    </div>
  )
}

function Brand({ compact = false }) {
  return (
    <div className={`brand ${compact ? 'brand--compact' : ''}`}>
      <span className="brand-mark" aria-hidden="true">
        <i className="brand-mark__ring" />
        <i className="brand-mark__drop" />
      </span>
      <span data-wallpaper-text="">
        <strong>tachi</strong>
        <small>{t("塔奇")}</small>
      </span>
    </div>
  )
}

function ConnectScreen({
  simpleUi,
  session,
  servers,
  scanning: nativeScanning,
  discoveryMessage,
  onLanguageChange,
  onRestore,
  onBack,
  onAccounts,
  onChoose,
  onManual,
  onScan,
  notify,
}) {
  const [demoScanning, setDemoScanning] = useState(false)
  const [scanRound, setScanRound] = useState(0)
  const scanning = onScan ? nativeScanning : demoScanning

  const scan = () => {
    if (scanning) return
    if (onScan) {
      onScan()
      return
    }
    setDemoScanning(true)
    window.setTimeout(() => {
      setDemoScanning(false)
      setScanRound((round) => round + 1)
      notify(t("扫描完成，找到 2 台服务器"), 'success')
    }, 1350)
  }

  return (
    <section className="screen connect-screen">
      <header className="top-row">
        {onBack ? <button className="icon-button glass-soft" onClick={onBack} aria-label={t("返回服务器与账号")}><ArrowLeft size={20} /></button> : <Brand />}
        <select className="language-select" aria-label={t('语言')} value={getLanguage()} onChange={event => onLanguageChange(event.target.value)}>
          <option value="system">{t('跟随系统')}</option><option value="zh-CN">简体中文</option><option value="en">English</option>
        </select>
        <button className="icon-button glass-soft" aria-label={t("更多选项")} onClick={() => notify(t("tachi（塔奇） · 手机伴侣"))}>
          <MoreHorizontal size={20} />
        </button>
      </header>

      <div className="art-hero glass-panel">
        {!simpleUi && <img src={assetUrl('liquid-blue.png')} alt={t("冰蓝色流体抽象艺术")} />}
        <div className="art-hero__refraction" />
        <div className="art-hero__copy">
          <span className="eyebrow light">tachi COMPANION</span>
          <h1>{simpleUi ? <>{t("随身影院")}<br />{t("静享光影")}</> : <>{t("让影像")}<br />{t("穿过玻璃")}</>}</h1>
          <p>Jellyfin × RayNeo Air</p>
        </div>
        <div className="art-hero__glint" />
      </div>

      {onAccounts && (
        <button className="saved-accounts-link glass-panel" onClick={onAccounts}>
          <UserRound size={18} /><span>{t("已登录的服务器与账号")}</span><ChevronRight size={18} />
        </button>
      )}

      {session && (
        <button className="restore-card glass-panel pressable" onClick={onRestore}>
          <span className="server-orb server-orb--ready"><Zap size={18} /></span>
          <span className="restore-card__copy">
            <small>{t("当前连接")}</small>
            <strong>{session.server?.name ?? t("Jellyfin 媒体库")}</strong>
            <em>{session.username}  {t("· 继续使用，无需登录")}</em>
          </span>
          <ChevronRight size={20} />
        </button>
      )}

      <div className="section-heading" data-wallpaper-text="">
        <div>
          <span className="eyebrow">LOCAL NETWORK</span>
          <h2>{t("选择媒体服务器")}</h2>
        </div>
        <button className={`scan-button ${scanning ? 'is-scanning' : ''}`} onClick={scan} disabled={scanning} aria-busy={scanning}>
          <RefreshCw size={15} />
          {scanning ? t("发现中") : t("重新扫描")}
        </button>
      </div>

      <div className="radar-line" aria-hidden="true">
        <span className={scanning ? 'is-active' : ''} />
      </div>

      <div className="server-list" key={scanRound}>
        {servers.map((server, index) => (
          <button
            className="server-card glass-panel pressable stagger-in"
            style={{ '--delay': `${index * 90}ms` }}
            key={server.id}
            onClick={() => onChoose(server)}
          >
            <span className="server-orb">
              <Server size={20} strokeWidth={1.8} />
              <i />
            </span>
            <span className="server-card__body">
              <span className="server-card__title">
                <strong>{server.name}</strong>
                <small><Radio size={11} /> {nativeMessage(server.latency) || t("局域网")}</small>
              </span>
              <span className="server-card__host">{server.host}</span>
              <span className="server-card__meta">{nativeMessage(server.detail) || t("Jellyfin 服务器")}  {t("· 局域网")}</span>
            </span>
            <ChevronRight className="muted-icon" size={20} />
          </button>
        ))}
        {servers.length === 0 && (
          <div className={`scan-empty glass-panel ${scanning ? 'is-scanning' : ''}`} role="status">
            <span className="server-orb"><Radar size={20} /></span>
            <span>
              <strong>{scanning ? t("正在发现 Jellyfin") : t("尚未发现服务器")}</strong>
              <small>{nativeMessage(discoveryMessage) || t("确认手机与服务器处于同一 Wi-Fi，或手动填写地址。")}</small>
            </span>
          </div>
        )}
      </div>

      {servers.length > 0 && discoveryMessage && (
        <p className="discovery-message">{nativeMessage(discoveryMessage)}</p>
      )}

      <button className="manual-card pressable" onClick={onManual}>
        <span className="manual-card__icon"><Plus size={20} /></span>
        <span>
          <strong>{t("手动填写地址")}</strong>
          <small>{t("使用域名、IP 或反向代理地址")}</small>
        </span>
        <ArrowRight size={18} />
      </button>

      <div className="privacy-note" data-wallpaper-text="">
        <ShieldCheck size={15} />
         {t("发现过程仅在当前局域网内进行")} </div>
    </section>
  )
}

function AuthScreen({
  simpleUi,
  server,
  mode,
  setMode,
  onBack,
  onComplete,
  onLogin,
  onQuickStart,
  onQuickCancel,
  onCopyCode,
  onOpenAuthorization,
  nativeState,
  isNative,
  notify,
}) {
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [loading, setLoading] = useState(false)

  const login = () => {
    if (loading || nativeState?.busy) return
    if (!username.trim()) {
      notify(t("请填写 Jellyfin 用户名"), 'error')
      return
    }
    if (!isNative) setLoading(true)
    onLogin(username.trim(), password, remember)
    setPassword('')
  }

  const busy = loading || Boolean(nativeState?.busy)

  return (
    <section className="screen auth-screen">
      <header className="subpage-header">
        <button className="icon-button glass-soft" onClick={onBack} aria-label={t("返回")}>
          <ArrowLeft size={20} />
        </button>
        <div className="subpage-header__title" data-wallpaper-text="">
          <strong>{t("连接 Jellyfin")}</strong>
          <span>{server.host}</span>
        </div>
        <span className="secure-pill"><LockKeyhole size={12} />  {t("安全")}</span>
      </header>

      <div className="auth-art glass-panel">
        {!simpleUi && <img src={assetUrl('liquid-blue.png')} alt="" />}
        <div className="auth-art__glass">
          <span className="server-orb server-orb--light"><Link2 size={21} /></span>
          <div>
            <small>{t("正在登录")}</small>
            <strong>{server.name}</strong>
          </div>
          <i className="connection-wave" />
        </div>
      </div>

      <div className="auth-tabs glass-soft" role="group" aria-label={t("登录方式")}>
        <button aria-pressed={mode === 'password'} className={mode === 'password' ? 'is-active' : ''} disabled={busy} onClick={() => setMode('password')}>
           {t("账号密码")} </button>
        <button aria-pressed={mode === 'quick'} className={mode === 'quick' ? 'is-active' : ''} disabled={busy} onClick={() => setMode('quick')}>
          Quick Connect
        </button>
        <span className={`auth-tabs__indicator auth-tabs__indicator--${mode}`} />
      </div>

      {mode === 'password' ? (
        <form className="auth-content mode-enter" key="password" onSubmit={(event) => { event.preventDefault(); login() }}>
          <div className="form-heading" data-wallpaper-text="">
            <span className="eyebrow">WELCOME BACK</span>
            <h2>{t("登录你的媒体库")}</h2>
            <p>{t("凭据只会发送至你选择的 Jellyfin 服务器。")}</p>
          </div>

          <label className="field glass-panel">
            <UserRound size={19} />
            <span>
              <small>{t("用户名")}</small>
              <input value={username} onChange={(event) => setUsername(event.target.value)} aria-label={t("用户名")} autoComplete="username" />
            </span>
          </label>

          <label className="field glass-panel">
            <KeyRound size={19} />
            <span>
              <small>{t("密码")}</small>
              <input
                type={passwordVisible ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-label={t("密码")} autoComplete="current-password"
              />
            </span>
            <button type="button" onClick={() => setPasswordVisible((visible) => !visible)} aria-label={passwordVisible ? t("隐藏密码") : t("显示密码")} aria-pressed={passwordVisible}>
              {passwordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </label>

          <button type="button" role="switch" aria-checked={remember} className="remember-row" data-wallpaper-text="" onClick={() => setRemember((value) => !value)}>
            <span className={`check-box ${remember ? 'is-checked' : ''}`}>
              {remember && <Check size={13} strokeWidth={3} />}
            </span>
            <span>
              <strong>{t("保存登录会话")}</strong>
              <small>{t("下次自动恢复，无需重新输入")}</small>
            </span>
          </button>

          <button className={`primary-button pressable ${busy ? 'is-loading' : ''}`} type="submit" disabled={busy} aria-busy={busy}>
            <span>{busy ? t("正在建立安全连接") : t("登录并连接")}</span>
            {busy ? <i className="button-loader" /> : <ArrowRight size={19} />}
          </button>
          {isNative && nativeState?.message && (
            <p className={`native-status ${nativeState.isError ? 'is-error' : ''}`} role="status">{nativeMessage(nativeState.message)}</p>
          )}
        </form>
      ) : (
        <QuickConnect
          onComplete={() => onComplete('demo')}
          onStart={onQuickStart}
          onCancel={onQuickCancel}
          onCopy={onCopyCode}
          onOpenAuthorization={onOpenAuthorization}
          nativeState={nativeState}
          isNative={isNative}
          notify={notify}
        />
      )}
    </section>
  )
}

function QuickConnect({
  onComplete,
  onStart,
  onCancel,
  onCopy,
  onOpenAuthorization,
  nativeState,
  isNative,
  notify,
}) {
  const [copied, setCopied] = useState(false)
  const code = isNative ? formatQuickCode(nativeState?.quickConnectCode) : '7RV · 4DP'
  const waitingForCode = isNative && !code

  useEffect(() => {
    if (isNative && !nativeState?.busy && !nativeState?.quickConnectCode) onStart()
  }, [])

  const copyCode = async () => {
    if (!code) return
    if (isNative) {
      onCopy()
    }
    try {
      if (!isNative) await navigator.clipboard.writeText(code.replace(/\s|·/g, ''))
    } catch {
      // Clipboard access can be restricted in embedded previews; visual feedback still demonstrates the action.
    }
    setCopied(true)
    notify(t("登录码已复制"), 'success')
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="quick-content mode-enter" key="quick">
      <div className="form-heading" data-wallpaper-text="">
        <span className="eyebrow">PASSWORDLESS</span>
        <h2>{t("在已登录设备上确认")}</h2>
        <p>{t("打开 Jellyfin 授权页面，然后输入这组一次性登录码。")}</p>
      </div>

      <div className="quick-code glass-panel">
        <div className="quick-code__label">
          <span><Radar size={15} />  {t("登录码")}</span>
          <i>{waitingForCode ? t("正在申请") : t("等待确认")}</i>
        </div>
        <button className="quick-code__value" onClick={copyCode} aria-label={t("复制登录码")}>
          {waitingForCode ? <i className="button-loader dark" /> : code}
        </button>
        <button className="copy-button" onClick={copyCode} disabled={waitingForCode}>
          {copied ? <Check size={17} /> : <Copy size={17} />}
          {copied ? t("已复制") : t("复制登录码")}
        </button>
        <div className="quick-code__halo" />
      </div>

      <ol className="quick-steps" data-wallpaper-text="">
        <li><i>1</i><span>{t("在手机或电脑上打开 Jellyfin")}</span></li>
        <li><i>2</i><span>{t("进入 Quick Connect 并输入上方代码")}</span></li>
      </ol>

      <button
        className="primary-button pressable"
        onClick={() => {
          if (isNative) {
            onOpenAuthorization()
            notify(t("已打开 Jellyfin 授权页面"))
          } else {
            notify(t("授权页已打开 · 浏览器预览中模拟确认成功"))
            window.setTimeout(onComplete, 900)
          }
        }}
        disabled={waitingForCode}
      >
        <span>{t("打开授权页面")}</span>
        <ExternalLink size={18} />
      </button>

      <button className="text-button" onClick={onCancel}>
        <X size={16} />  {t("取消快速登录")} </button>
      {isNative && nativeState?.message && (
        <p className={`native-status ${nativeState.isError ? 'is-error' : ''}`} role="status">{nativeMessage(nativeState.message)}</p>
      )}
    </div>
  )
}

function HomeScreen({
  session,
  server,
  onTouchpad,
  onRetry,
  onSettings,
  onAccounts,
  deviceState,
  notify,
}) {
  const activeServer = session?.server ?? server
  const username = session?.username ?? 'Jellyfin'
  const connected = deviceState ? Boolean(deviceState.glassesConnected) : true
  const displayReady = deviceState ? Boolean(deviceState.glassesPresentationReady) : true
  const mediaReady = deviceState ? Boolean(deviceState.mediaReady) : true
  const runtimeState = deviceState?.glassesRuntimeState || (mediaReady ? 'ready' : displayReady ? 'loading' : 'booting')
  const mediaError = runtimeState === 'error'
  const runtimeErrorLabel = {
    network: 'NETWORK',
    http: 'HTTP',
    response: 'RESPONSE',
    unknown: 'UNKNOWN',
  }[deviceState?.glassesRuntimeErrorCode] || 'UNKNOWN'
  let welcomeTitle = t("等待连接 RayNeo Air")
  if (connected) welcomeTitle = t("正在准备眼镜画面")
  if (displayReady) welcomeTitle = t("画面已启动，正在连接媒体库")
  if (mediaError) welcomeTitle = t("媒体库连接失败，请重试连接")
  if (mediaReady) welcomeTitle = t("一切就绪，开始你的观影时光")

  return (
    <section className={`screen home-screen with-nav ${mediaError ? 'has-runtime-error' : ''}`}>
      <header className="top-row home-top">
        <Brand compact />
        <button className="profile-button glass-soft" onClick={onSettings} aria-label={t("账户与设置")}>
          <span>{profileInitials(username)}</span>
          <i />
        </button>
      </header>

      <div className="welcome-line">
        <div>
          <span className="eyebrow" data-wallpaper-text="">MY DEVICES</span>
          <h1 data-wallpaper-text="">{t("我的设备")}</h1>
          <p data-wallpaper-text="">{welcomeTitle}</p>
        </div>
      </div>

      <div className="device-hero glass-panel" data-liquid-surface="">
        <div className="device-hero__head">
          <span className={`connected-pill ${connected ? '' : 'is-offline'}`}><i /> {connected ? t("眼镜已连接") : t("等待连接眼镜")}</span>
          <button data-wallpaper-text="glass" onClick={() => notify(nativeMessage(deviceState?.displayMessage) || t("RayNeo Air 3S · USB-C 空间显示"))} aria-label={t("设备详情")}><MoreHorizontal size={19} /></button>
        </div>
        <img className="device-hero__product" src={assetUrl('rayneo-air-3s.webp')} alt={t("RayNeo Air 3S，深色一体式镜片与白色镜腿")} />
        <div className="device-hero__info" data-wallpaper-text="glass">
          <strong>RayNeo Air 3S</strong>
          <span><Zap size={13} /> {connected ? t("USB-C 已连接") : t("通过 USB-C 连接眼镜")}</span>
        </div>
      </div>

      {mediaError && (
        <div className="runtime-status-card is-error" role="alert">
          <span className="runtime-status-card__copy">
            <strong>{t("眼镜端诊断 ·")} {runtimeErrorLabel}</strong>
            <span>{nativeMessage(deviceState?.message) || t("眼镜端加载媒体库失败，请检查服务器地址和当前网络。")}</span>
          </span>
          <button className="runtime-status-card__retry" onClick={onRetry}>
            <RefreshCw size={12} />  {t("重试")} </button>
        </div>
      )}

      <button className="touchpad-launch pressable" onClick={onTouchpad}>
        <span className="touchpad-launch__orb"><span /></span>
        <span className="touchpad-launch__copy">
          <small>REMOTE SURFACE</small>
          <strong>{t("进入触控板")}</strong>
          <em>{t("滑动 · 点击 · 双击")}</em>
        </span>
        <span className="touchpad-launch__arrow"><ArrowRight size={19} /></span>
        <i className="touchpad-launch__glow" />
      </button>

      <button className="connection-card glass-panel pressable" data-liquid-surface="" onClick={onAccounts} aria-label={t("管理服务器与账号")}>
        <span className="server-orb server-orb--small"><Server size={17} /></span>
        <span data-wallpaper-text="glass">
          <small>{t("当前媒体库")}</small>
          <strong>{activeServer?.name ?? t("Jellyfin 媒体库")}</strong>
          <em>{username}  {t("· 当前账号")}</em>
        </span>
        <span className="connection-card__action" data-wallpaper-text="glass">{t("管理")} <ChevronRight size={16} /></span>
      </button>
    </section>
  )
}

function ModeSelector({ value, onChange }) {
  return (
    <div className="mode-selector" role="group" aria-label={t("画面输出模式")}>
      <button data-liquid-surface="" aria-pressed={value === 'mirror'} className={value === 'mirror' ? 'is-active' : ''} onClick={() => onChange('mirror')}>
        <span><Monitor size={19} /></span>
        <div data-wallpaper-text="glass"><strong>{t("镜像 2D")}</strong><small>{t("双眼相同画面")}</small></div>
        <i className="radio-check">{value === 'mirror' && <Check size={11} />}</i>
      </button>
      <button data-liquid-surface="" aria-pressed={value === 'stereo'} className={value === 'stereo' ? 'is-active' : ''} onClick={() => onChange('stereo')}>
        <span><Box size={19} /></span>
        <div data-wallpaper-text="glass"><strong>{t("虚拟银幕")}</strong><small>{t("可调远近与大小")}</small></div>
        <i className="radio-check">{value === 'stereo' && <Check size={11} />}</i>
      </button>
    </div>
  )
}

function DisplayModeStatus({ value, state, onRetry }) {
  const transitioning = Boolean(state?.displayModeTransitioning)
  const displayDisabled = Boolean(state?.glassesDisplayDisabled)
  const active = Boolean(state?.displayModeApplied && !transitioning)
  const stereoActive = active && state?.activeDisplayMode === 'stereo_screen'
  const waiting = value === 'stereo' && !stereoActive
  const pending = transitioning || waiting || displayDisabled
  const Icon = transitioning ? LoaderCircle : active && !displayDisabled ? Check : Info
  return (
    <div className={`display-mode-status ${pending ? 'is-pending' : active ? 'is-ready' : 'is-idle'}`} role="status">
      <strong><Icon size={16} className={transitioning ? 'is-spinning' : ''} aria-hidden="true" />{displayDisabled ? t("系统尚未启用眼镜输出") : transitioning ? t("正在切换眼镜输出…") : stereoActive ? t("当前：虚拟银幕已启用") : state?.glassesConnected ? t("当前：镜像 2D") : t("等待眼镜输出")}</strong>
      <p>{displayDisabled ? t("眼镜已连接。请在手机系统中开启“屏幕镜像”，允许眼镜显示画面。HyperOS 在连接或切换模式后可能需要再次手动开启。") : nativeMessage(state?.displayMessage) || t("等待眼镜连接。")}</p>
      {waiting && !transitioning && <p>{t("虚拟银幕尚未启用，远近与大小设置目前只会保存。")}</p>}
      {waiting && !transitioning && state?.glassesConnected && (
        <div className="display-mode-actions">
          <button type="button" onClick={onRetry}>{t("重新启用")}</button>
        </div>
      )}
    </div>
  )
}

function ThemeSelector({ value, onChange }) {
  return (
    <fieldset className="theme-selector">
      <legend className="theme-selector__intro" data-wallpaper-text="glass">{t("为手机与眼镜，选择同一种氛围")}</legend>
      <div className="theme-selector__options">
        {[
          { id: 'liquid-glass', get name() { return t("液态玻璃") }, get tag() { return t("默认") }, get detail() { return t("通透光影 · 流动质感") } },
          { id: 'simpleUI', name: 'simpleUI', get tag() { return t("轻简") }, get detail() { return t("静谧展厅 · 轻盈省电") } },
        ].map((theme) => (
          <label data-liquid-surface="" className={`theme-option ${value === theme.id ? 'is-selected' : ''}`} key={theme.id}>
            <input type="radio" name="ui-theme" value={theme.id} checked={value === theme.id}
              onChange={() => onChange(theme.id)} />
            <span className={`theme-preview theme-preview--${theme.id}`} aria-hidden="true">
              <span className="theme-preview__arch" />
              <span className="theme-preview__caption" />
              <span className="theme-preview__tiles"><i /><i /><i /></span>
            </span>
            <span className="theme-option__title" data-wallpaper-text="glass"><strong>{theme.name}</strong><small>{theme.tag}</small></span>
            <span className="theme-option__detail" data-wallpaper-text="glass">{theme.detail}</span>
            <span className="theme-option__check" aria-hidden="true">{value === theme.id && <Check size={12} />}</span>
          </label>
        ))}
      </div>
      <p className="theme-selector__note" data-wallpaper-text="glass">{t("自动保存，两端同步生效；眼镜重新连接后沿用。")}</p>
    </fieldset>
  )
}

function SettingsScreen({
  onLanguageChange,
  uiTheme,
  background,
  screenAspect,
  onUiThemeChange,
  glassTransparency,
  onGlassTransparencyChange,
  touchpadBackground,
  onTouchpadBackgroundChange,
  subtitleSize,
  onSubtitleSizeChange,
  session,
  server,
  displayMode,
  setDisplayMode,
  stereoScreen,
  onStereoScreenChange,
  stereoTestPattern,
  onStereoTestPatternChange,
  isNative,
  haptics,
  setHaptics,
  onChangeAccount,
  onReset,
  onShareDiagnostics,
  nativeState,
}) {
  const activeServer = session?.server ?? server
  const username = session?.username ?? nativeState?.username ?? 'Jellyfin'
  const sessionSaved = session?.saved ?? nativeState?.sessionSaved ?? true
  const version = nativeState?.appVersionName || __APP_VERSION__
  const versionCode = nativeState?.appVersionCode || __APP_VERSION_CODE__

  return (
    <section className="screen settings-screen with-nav">
      <header className="settings-header">
        <div data-wallpaper-text="">
          <span className="eyebrow">MAKE IT YOURS</span>
          <h1>{t("设置")}</h1>
          <p>{t("你的设备，你的观影方式。")}</p>
        </div>
        <span className="settings-header__mark glass-soft" aria-hidden="true"><Settings2 size={23} /></span>
      </header>

      <button className="account-card glass-panel settings-account" data-liquid-surface="" onClick={onChangeAccount} aria-label={t("管理服务器与账号")}>
        <div className="account-avatar">{profileInitials(username)}<i /></div>
        <div className="account-card__copy" data-wallpaper-text="glass">
          <small>{t("服务器与账号")}</small>
          <strong>{username}</strong>
          <span>{activeServer?.name ?? t("Jellyfin 媒体库")} · {sessionSaved ? t("登录已保存") : t("仅本次运行")}</span>
        </div>
        <ChevronRight size={18} className="settings-account__arrow" data-wallpaper-text="glass" />
      </button>

      <SettingsGroup title={t("外观与交互")}>
        <SettingsDisclosure icon={Languages} title={t('语言')} detail={t('两端同步，自动保存。')} value={getLanguage() === 'system' ? t('跟随系统') : getLanguage() === 'zh-CN' ? '简体中文' : 'English'}>
          <div className="stereo-depth-options language-options" role="group" aria-label={t('语言')}>
            {['system', 'zh-CN', 'en'].map(language => <button key={language} type="button"
              aria-pressed={getLanguage() === language} onClick={() => onLanguageChange(language)}>
              {language === 'system' ? t('跟随系统') : language === 'zh-CN' ? '简体中文' : 'English'}
            </button>)}
          </div>
        </SettingsDisclosure>
        <SettingsDisclosure icon={Palette} title={t("界面外观")} detail={t("主题风格与手机背景")} value={uiTheme === 'simpleUI' ? 'simpleUI' : 'Liquid UI'}>
          <ThemeSelector value={uiTheme} onChange={onUiThemeChange} />
          {uiTheme === 'liquid-glass' && <>
            <GlassTransparencyControl value={glassTransparency} onChange={onGlassTransparencyChange} />
            <BackgroundPicker background={background} screenAspect={screenAspect} />
          </>}
        </SettingsDisclosure>
        <SettingsDisclosure icon={Touchpad} title={t("遥控器背景")} detail={t("纹理氛围或 OLED 纯黑")}
          value={touchpadBackground === 'black' ? t("纯黑") : t("纹理")}>
          <TouchpadBackgroundSelector value={touchpadBackground} onChange={onTouchpadBackgroundChange} />
        </SettingsDisclosure>
        <button className="setting-row" role="switch" aria-checked={haptics} onClick={() => {
          const next = !haptics
          setHaptics(next)
          if (next) callNative('previewHaptic')
        }}>
          <span className="setting-row__icon mint"><Vibrate size={19} /></span>
          <span className="setting-row__copy" data-wallpaper-text="glass"><strong>{t("轻触震动")}</strong><small>{t("触控板手势完成时的短促反馈")}</small></span>
          <Toggle checked={haptics} />
        </button>
      </SettingsGroup>

      <SettingsGroup title={t("字幕大小")}>
        <div className="settings-mode-wrap">
          <div className="stereo-depth-options" role="group" aria-label={t("字幕大小")}>
            {SUBTITLE_SIZES.map(option => <button key={option.value} type="button" data-liquid-surface="" data-wallpaper-text="glass"
              aria-pressed={subtitleSize === option.value} onClick={() => onSubtitleSizeChange(option.value)}>{t(option.label)}</button>)}
          </div>
          <p className="stereo-help" data-wallpaper-text="glass">{t("与眼镜同步，自动保存。适用于普通文字字幕；ASS/SSA 保留原有字号和排版，烧录字幕不受影响。")}</p>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("眼镜显示")}>
        <SettingsDisclosure icon={Glasses} title={t("画面输出")} detail={t("显示模式、银幕远近与大小")}
          value={displayMode === 'stereo' ? t("虚拟银幕") : t("镜像 2D")} onClose={() => onStereoTestPatternChange(false)}>
        <div className="settings-mode-wrap">
          <ModeSelector value={displayMode} onChange={setDisplayMode} />
          {isNative
            ? <DisplayModeStatus value={displayMode} state={nativeState} onRetry={() => setDisplayMode(displayMode)} />
            : <p className="stereo-status" data-wallpaper-text="glass">{t("演示预览：连接眼镜后可体验虚拟银幕。")}</p>}
          {displayMode === 'stereo' && (
            <div className="stereo-settings">
              <div className="stereo-setting-label" data-wallpaper-text="glass" id="stereo-depth-label">
                <strong>{t("靠近程度")}</strong><span>{t(DEPTH_LABELS[stereoScreen.depthLevel])}</span>
              </div>
              <div className="stereo-depth-options" role="group" aria-labelledby="stereo-depth-label">
                {DEPTH_LABELS.map((label, depthLevel) => (
                  <button key={label} type="button" data-liquid-surface="" data-wallpaper-text="glass" aria-pressed={stereoScreen.depthLevel === depthLevel}
                    onClick={() => onStereoScreenChange({ depthLevel })}>{t(label)}</button>
                ))}
              </div>
              <p className="stereo-help" data-wallpaper-text="glass">{t("从「轻微」开始，让整块银幕更靠近。片中物体仍保持原有的 2D 画面。")}</p>
              <label className="stereo-setting-label" data-wallpaper-text="glass" htmlFor="stereo-size">
                <strong>{t("银幕大小")}</strong><output htmlFor="stereo-size">{stereoScreen.sizePercent}%</output>
              </label>
              <input id="stereo-size" className="stereo-size-range" type="range" min="80" max="95" step="1"
                value={stereoScreen.sizePercent} aria-valuetext={`${stereoScreen.sizePercent}%`}
                onChange={(event) => onStereoScreenChange({ sizePercent: Number(event.target.value) })} />
              <div className="stereo-range-labels" data-wallpaper-text="glass"><span>{t("80% · 较小")}</span><span>{t("95% · 较大")}</span></div>
              <p className="stereo-help" data-wallpaper-text="glass">{t("大小与远近感独立调整。若有重影或不适，先选「基准」或切回镜像 2D。")}</p>
              <button type="button" className="stereo-test-button" data-liquid-surface="" data-wallpaper-text="glass" aria-pressed={stereoTestPattern}
                disabled={isNative && !(nativeState?.displayModeApplied && !nativeState?.displayModeTransitioning
                  && nativeState?.activeDisplayMode === 'stereo_screen' && nativeState?.stereoOutput?.stereoReady
                  && nativeState?.glassesPresentationReady)}
                onClick={() => onStereoTestPatternChange(!stereoTestPattern)}>
                <Eye size={16} /> {stereoTestPattern ? t("结束左右眼检查") : t("检查左右眼")}
              </button>
              {stereoTestPattern && (
                <p className="stereo-help" data-wallpaper-text="glass" role="status">
                  {isNative ? t("交替闭眼：左眼应看到 L，右眼应看到 R。白框是基准，青色框随银幕移动；逐档靠近时应更靠前。离开设置会结束检查。")
                    : t("此处仅预览设置。眼镜上的检查图会显示 L / R、白色基准框与随银幕移动的青色框。")}
                </p>
              )}
            </div>
          )}
        </div>
        </SettingsDisclosure>
      </SettingsGroup>

      <SettingsGroup title={t("关于与帮助")}>
        <div className="setting-row setting-row--static">
          <span className="setting-row__icon pearl"><Info size={19} /></span>
          <span className="setting-row__copy" data-wallpaper-text="glass">
            <strong>{t("当前版本")}</strong>
            <small>{t("tachi（塔奇）")}{nativeState?.appVersionName ? '' : t(" · 浏览器预览")}</small>
          </span>
          <span className="app-version" data-wallpaper-text="glass"><strong>{version}</strong><small>Build {versionCode}</small></span>
        </div>
        <ProjectSettingLink page="project" icon={Github} title={t("项目地址")} detail={t("GitHub · 源码与最新动态")} />
        <ProjectSettingLink page="issues" icon={MessageSquare} title={t("反馈问题")} detail={t("提交 Issue，或查看已有反馈")} />
        <ProjectSettingLink page="guide" icon={BookOpen} title={t("使用指南")} detail={t("连接、操作与常见问题")} />
        <button className="setting-row" onClick={onShareDiagnostics}>
          <span className="setting-row__icon blue"><Share2 size={19} /></span>
          <span className="setting-row__copy" data-wallpaper-text="glass">
            <strong>{t("分享诊断日志")}</strong>
            <small>{t("导出脱敏日志，帮助排查问题")}</small>
          </span>
          <ChevronRight size={16} className="setting-chevron" data-wallpaper-text="glass" />
        </button>
      </SettingsGroup>

      <button className="reset-button" data-wallpaper-text="" disabled={background.busy} onClick={onReset}>
        <RotateCcw size={16} />  {t("恢复默认偏好")} </button>

      <p className="settings-footer" data-wallpaper-text="">{t("tachi（塔奇）")}<span>{t("开源第三方客户端 · MIT License")}</span></p>
    </section>
  )
}

function SettingsDisclosure({ icon: Icon, title, detail, value, onClose, children }) {
  return (
    <details className="settings-disclosure" onToggle={(event) => { if (!event.currentTarget.open) onClose?.() }}>
      <summary className="setting-row">
        <span className="setting-row__icon blue"><Icon size={19} /></span>
        <span className="setting-row__copy" data-wallpaper-text="glass"><strong>{title}</strong><small>{detail}</small></span>
        <span className="setting-current" data-wallpaper-text="glass">{value}<ChevronDown size={16} /></span>
      </summary>
      <div className="settings-disclosure__content">{children}</div>
    </details>
  )
}

function TouchpadBackgroundSelector({ value, onChange }) {
  return (
    <div className="touchpad-background-selector">
      <div className="touchpad-background-options" role="group" aria-label={t("遥控器背景")}>
        {[
          { id: 'texture', get title() { return t("纹理") }, get detail() { return t("柔和暗纹与触摸微光") } },
          { id: 'black', get title() { return t("纯黑") }, get detail() { return t("适合 OLED 屏幕") } },
        ].map((option) => (
          <button key={option.id} type="button" data-liquid-surface="" aria-pressed={value === option.id} onClick={() => onChange(option.id)}>
            <span className={`touchpad-background-preview is-${option.id}`} aria-hidden="true"><i /><span>{t("轻触 · 滑动")}</span></span>
            <span className="touchpad-background-option__title"><span data-wallpaper-text="glass">{option.title}</span><span className="radio-check">{value === option.id && <Check size={10} />}</span></span>
            <small data-wallpaper-text="glass">{option.detail}</small>
          </button>
        ))}
      </div>
      <p data-wallpaper-text="glass">{t("纯黑关闭背景纹理与触摸光晕，保留操作提示和震动反馈。")}</p>
    </div>
  )
}

function GlassTransparencyControl({ value, onChange }) {
  return (
    <div className="glass-transparency-control">
      <label htmlFor="glass-transparency" data-wallpaper-text="glass"><strong>{t("玻璃透明度")}</strong><output htmlFor="glass-transparency">{value}%</output></label>
      <input id="glass-transparency" type="range" min="0" max="100" step="1" value={value}
        aria-valuetext={`${value}%`} aria-describedby="glass-transparency-help" onChange={(event) => onChange(Number(event.target.value))} />
      <div className="glass-transparency-ends"><span data-wallpaper-text="glass">{t("0% · 实底")}</span><span data-wallpaper-text="glass">{t("100% · 最通透")}</span></div>
      <p id="glass-transparency-help" data-wallpaper-text="glass">{t("统一调整手机卡片与底栏，文字保持清晰，中央触控键保持实心。")}</p>
    </div>
  )
}

function BackgroundPicker({ background, screenAspect }) {
  return (
    <div className="background-picker" aria-busy={background.busy}>
      <div className="background-picker__heading" data-wallpaper-text="glass"><strong>{t("手机背景")}</strong><span>LIQUID UI</span></div>
      <div className="background-picker__body">
        <div className={`background-preview ${background.url ? 'has-image' : ''}`} aria-hidden="true">
          {background.url && <BackgroundArtwork background={background} screenAspect={screenAspect} />}
          <i /><i /><i />
        </div>
        <div className="background-picker__copy">
          <strong data-wallpaper-text="glass">{background.url ? t("自定义背景") : t("默认冰蓝")}</strong>
          <p data-wallpaper-text="glass">{background.url ? t("透明度 {0}% · 可调整裁切与位置", { 0: background.layout.transparency }) : t("换一张喜欢的图片，让玻璃映出你的色彩。")}</p>
          <button className="background-choose" data-liquid-surface="" data-wallpaper-text="glass" disabled={background.busy} onClick={background.choose}>
            {background.busy ? <LoaderCircle className="is-spinning" size={15} /> : <ImagePlus size={15} />}
            {background.busy ? t("正在处理…") : background.url ? t("更换图片") : t("选择图片")}
          </button>
          {background.url && <button className="background-adjust" data-wallpaper-text="glass" disabled={background.busy || !background.dimensions} onClick={background.edit}>{t("调整背景")}</button>}
        </div>
      </div>
      <div className="background-picker__footer">
        <p data-wallpaper-text="glass">{t("图片仅保存在本机，用于 Liquid 手机界面。")}</p>
        {background.url && <button data-wallpaper-text="glass" disabled={background.busy} onClick={background.clear}>{t("恢复默认背景")}</button>}
      </div>
    </div>
  )
}

function ProjectSettingLink({ page, icon: Icon, title, detail }) {
  const root = 'https://github.com/buggzd/tachi'
  const url = { project: root, issues: `${root}/issues`, guide: `${root}/blob/main/docs/USER_GUIDE.md` }[page]
  return (
    <a className="setting-row" href={url} target="_blank" rel="noopener noreferrer" onClick={(event) => {
      if (typeof window.JellyfinNative?.openProjectPage === 'function') {
        event.preventDefault()
        callNative('openProjectPage', page)
      }
    }}>
      <span className="setting-row__icon pearl"><Icon size={19} /></span>
      <span className="setting-row__copy" data-wallpaper-text="glass"><strong>{title}</strong><small>{detail}</small></span>
      <ExternalLink size={15} className="setting-chevron" data-wallpaper-text="glass" />
    </a>
  )
}

function AccountsScreen({ accounts, onBack, onAddServer, onAddAccount, onActivate, onRemove }) {
  const groups = Object.values(accounts.reduce((result, account) => {
    const key = account.serverUrl
    if (!result[key]) result[key] = { server: account, accounts: [] }
    result[key].accounts.push(account)
    return result
  }, Object.create(null)))

  return (
    <section className="screen accounts-screen">
      <header className="subpage-header">
        <button className="icon-button glass-soft" onClick={onBack} aria-label={t("返回")}><ArrowLeft size={20} /></button>
        <div className="subpage-header__title" data-wallpaper-text=""><strong>{t("服务器与账号")}</strong><span>{groups.length}  {t("台服务器 ·")} {accounts.length}  {t("个账号")}</span></div>
        <span className="account-header-icon"><Router size={22} /></span>
      </header>
      <div className="accounts-intro" data-wallpaper-text="">
        <h1>{t("连接你的媒体库")}</h1>
        <p>{t("切换已登录账号，无需重复输入密码。添加服务器或账号时，当前连接会保留到登录成功。")}</p>
      </div>
      {groups.map((group) => (
        <section className="account-server-card glass-panel" data-liquid-surface="" key={group.server.serverUrl}>
          <header>
            <span className="server-orb server-orb--small"><Server size={18} /></span>
            <div data-wallpaper-text="glass"><h2>{group.server.serverName || t("Jellyfin 媒体库")}</h2><p>{group.server.serverUrl}</p></div>
          </header>
          <div className="saved-account-list">
            {group.accounts.map((account) => (
              <div className={`saved-account-row ${account.active ? 'is-active' : ''}`} key={account.id}>
                <button className="saved-account-select" onClick={() => onActivate(account)} aria-label={`${account.active ? t("继续使用") : t("切换到")} ${account.username}`}>
                  <span className="saved-account-avatar">{profileInitials(account.username)}</span>
                  <span className="saved-account-copy" data-wallpaper-text="glass"><strong>{account.username || t("Jellyfin 用户")}</strong><small>{account.saved ? t("登录已保存") : t("仅本次运行")}</small></span>
                  <span className="saved-account-state" data-wallpaper-text="glass">{account.active ? <><Check size={13} />  {t("使用中")}</> : <>{t("切换")} <ChevronRight size={14} /></>}</span>
                </button>
                <button className="remove-account-button" data-wallpaper-text="glass" onClick={() => onRemove(account)} aria-label={t("移除 {0} 的登录", { 0: account.username })}><Trash2 size={17} /></button>
              </div>
            ))}
          </div>
          <button className="add-account-button" data-wallpaper-text="glass" onClick={() => onAddAccount(group.server)}><Plus size={16} />  {t("添加账号")}</button>
        </section>
      ))}
      {!accounts.length && <div className="accounts-empty glass-panel" data-liquid-surface="" data-wallpaper-text="glass"><UserRound size={28} /><strong>{t("还没有已登录账号")}</strong><p>{t("登录服务器后，账号会显示在这里。")}</p></div>}
      <button className="primary-button pressable" onClick={onAddServer}><Plus size={18} /><span>{t("添加服务器")}</span></button>
      {accounts.length >= 12 && <p className="accounts-limit" data-wallpaper-text="glass" role="status">{t("已达到 12 个账号的上限，添加前请先移除不再使用的账号。")}</p>}
    </section>
  )
}

function RemoveAccountDialog({ account, onCancel, onConfirm }) {
  const dialogRef = useRef(null)
  useEffect(() => {
    const dialog = dialogRef.current
    const opener = document.activeElement
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.showModal()
    return () => {
      dialog.close()
      document.body.style.overflow = overflow
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  return (
    <dialog ref={dialogRef} className="account-dialog" aria-labelledby="remove-account-title" aria-describedby="remove-account-description" onCancel={(event) => { event.preventDefault(); onCancel() }}>
      <h2 id="remove-account-title">{t("移除这个登录账号？")}</h2>
      <p className="remove-account-name">{account.username} · {account.serverName || 'Jellyfin'}</p>
      <p id="remove-account-description">{t("移除本机保存的登录状态，重新使用需要登录。")}{account.active ? t("当前连接也会断开。") : ''}</p>
      <div className="account-dialog-actions"><button className="secondary-button" autoFocus onClick={onCancel}>{t("取消")}</button><button className="remove-account-confirm" onClick={onConfirm}>{t("移除登录")}</button></div>
    </dialog>
  )
}

function SettingsGroup({ title, children }) {
  return (
    <section className="settings-group">
      <h2 data-wallpaper-text="">{title}</h2>
      <div className="settings-group__body glass-panel" data-liquid-surface="">{children}</div>
    </section>
  )
}

function Toggle({ checked }) {
  return <span className={`toggle ${checked ? 'is-on' : ''}`}><i /></span>
}

function BottomNav({ active, onHome, onTouchpad, onSettings }) {
  return (
    <nav className="bottom-nav glass-panel" data-liquid-surface="" aria-label={t("手机导航")}>
      <button data-wallpaper-text="navigation" aria-current={active === 'home' ? 'page' : undefined} className={active === 'home' ? 'is-active' : ''} onClick={onHome}>
        <span><Glasses size={20} /></span>
        <small>{t("设备")}</small>
      </button>
      <button data-wallpaper-text="navigation" className="nav-primary" onClick={onTouchpad}>
        <span><i /></span>
        <small>{t("触控")}</small>
      </button>
      <button data-wallpaper-text="navigation" aria-current={active === 'settings' ? 'page' : undefined} className={active === 'settings' ? 'is-active' : ''} onClick={onSettings}>
        <span><Settings2 size={20} /></span>
        <small>{t("设置")}</small>
      </button>
    </nav>
  )
}

function TouchpadScreen({
  simpleUi,
  pureBlack,
  displayMode,
  haptics,
  playback,
  searchActive,
  searchQuery,
  onExit,
  onCommand,
  onSearchAction,
  onSearchText,
  native,
}) {
  const surfaceRef = useRef(null)
  const introRef = useRef(null)
  const searchInputRef = useRef(null)
  const glowRef = useRef(null)
  const point = useRef({ x: 50, y: 50, tx: 50, ty: 50, vx: 0, vy: 0 })
  const glowFrameRef = useRef(0)
  const surfaceRectRef = useRef(null)
  const pointerStart = useRef(null)
  const seekRingRef = useRef(null)
  const circularGesture = useRef(null)
  const circularEnabled = playback?.seekEnabled === true && !searchActive
  const lastTap = useRef(0)
  const tapTimer = useRef(null)
  const feedbackTimer = useRef(null)
  const hideTimer = useRef(null)
  const [pressed, setPressed] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [introVisible, setIntroVisible] = useState(true)
  useLayoutEffect(() => suspendHiddenAnimations(introRef.current, !introVisible || searchActive), [introVisible, searchActive])
  const [searchValue, setSearchValue] = useState(() => normalizeRemoteSearchQuery(searchQuery))

  const animateGlow = () => {
    glowFrameRef.current = 0
    const p = point.current
    p.vx = (p.vx + (p.tx - p.x) * 0.075) * 0.72
    p.vy = (p.vy + (p.ty - p.y) * 0.075) * 0.72
    p.x += p.vx
    p.y += p.vy

    const settled = Math.abs(p.tx - p.x) < 0.002
      && Math.abs(p.ty - p.y) < 0.002
      && Math.abs(p.vx) < 0.002
      && Math.abs(p.vy) < 0.002
    if (settled) {
      p.x = p.tx
      p.y = p.ty
      p.vx = 0
      p.vy = 0
    }
    if (glowRef.current) {
      glowRef.current.style.transform = `translate3d(${p.x}vw, ${p.y}vh, 0) translate(-50%, -50%)`
    }
    if (!settled) glowFrameRef.current = window.requestAnimationFrame(animateGlow)
  }

  const requestGlowAnimation = () => {
    if (pureBlack) return
    if (!glowFrameRef.current) {
      glowFrameRef.current = window.requestAnimationFrame(animateGlow)
    }
  }

  useEffect(() => {
    const invalidateSurfaceRect = () => {
      surfaceRectRef.current = null
    }

    requestGlowAnimation()
    window.addEventListener('resize', invalidateSurfaceRect)
    hideTimer.current = window.setTimeout(() => setIntroVisible(false), 4200)
    return () => {
      window.removeEventListener('resize', invalidateSurfaceRect)
      if (glowFrameRef.current) {
        window.cancelAnimationFrame(glowFrameRef.current)
        glowFrameRef.current = 0
      }
      window.clearTimeout(feedbackTimer.current)
      window.clearTimeout(hideTimer.current)
      window.clearTimeout(tapTimer.current)
    }
  }, [pureBlack])

  useEffect(() => {
    setSearchValue(searchActive ? normalizeRemoteSearchQuery(searchQuery) : '')
  }, [searchActive, searchQuery])

  useEffect(() => {
    if (!searchActive) return undefined
    setIntroVisible(false)
    const timer = window.setTimeout(() => {
      try {
        searchInputRef.current?.focus({ preventScroll: true })
      } catch {
        searchInputRef.current?.focus()
      }
    }, 120)
    return () => window.clearTimeout(timer)
  }, [searchActive])

  const vibrate = (pattern = 8) => {
    if (haptics && navigator.vibrate) navigator.vibrate(pattern)
  }

  const emitCommand = (command, pattern = 8) => {
    if (native) {
      onCommand(command)
    } else {
      vibrate(pattern)
    }
  }

  const updateTarget = (event) => {
    if (pureBlack) return
    const rect = surfaceRectRef.current || surfaceRef.current.getBoundingClientRect()
    surfaceRectRef.current = rect
    point.current.tx = ((event.clientX - rect.left) / rect.width) * 100
    point.current.ty = ((event.clientY - rect.top) / rect.height) * 100
    requestGlowAnimation()
  }

  const showFeedback = (value) => {
    window.clearTimeout(feedbackTimer.current)
    setFeedback(value)
    feedbackTimer.current = window.setTimeout(() => setFeedback(''), 520)
  }

  const cancelPointer = () => {
    pointerStart.current = null
    circularGesture.current = null
    surfaceRectRef.current = null
    window.clearTimeout(tapTimer.current)
    lastTap.current = 0
    setPressed(false)
  }

  useEffect(() => {
    cancelPointer()
    const hide = () => { if (document.hidden) cancelPointer() }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('blur', cancelPointer)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('blur', cancelPointer)
      window.clearTimeout(tapTimer.current)
    }
  }, [circularEnabled, playback?.itemId])

  const emitSeek = (seconds) => {
    if (!seconds || !circularEnabled) return
    showFeedback(`seek:${seconds}`)
    // Continuous seeking has no repeated vibration.
    if (native) onCommand(`seek:${seconds}`, false)
  }

  const onPointerDown = (event) => {
    if (!event.isPrimary || pointerStart.current) { cancelPointer(); return }
    window.clearTimeout(tapTimer.current)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    surfaceRectRef.current = null
    updateTarget(event)
    pointerStart.current = { x: event.clientX, y: event.clientY, time: Date.now(), id: event.pointerId }
    const ring = circularEnabled ? seekRingRef.current?.getBoundingClientRect() : null
    circularGesture.current = ring ? new CircularSeekGesture(ring.left + ring.width / 2, ring.top + ring.height / 2, ring.width / 2) : null
    circularGesture.current?.move(event.clientX, event.clientY, event.timeStamp)
    setPressed(true)
    setIntroVisible(false)
  }

  const onPointerMove = (event) => {
    if (pointerStart.current?.id !== event.pointerId) return
    updateTarget(event)
    emitSeek(circularGesture.current?.move(event.clientX, event.clientY, event.timeStamp) ?? 0)
    if (circularGesture.current?.active) {
      window.clearTimeout(tapTimer.current)
      lastTap.current = 0
    }
  }

  const onPointerUp = (event) => {
    if (pointerStart.current?.id !== event.pointerId) return
    const gesture = circularGesture.current
    emitSeek(gesture?.move(event.clientX, event.clientY, event.timeStamp) ?? 0)
    if (gesture?.active) {
      emitSeek(gesture.flush())
      cancelPointer()
      return
    }
    circularGesture.current = null
    updateTarget(event)
    setPressed(false)
    const dx = event.clientX - pointerStart.current.x
    const dy = event.clientY - pointerStart.current.y
    const distance = Math.hypot(dx, dy)
    pointerStart.current = null
    surfaceRectRef.current = null

    if (distance > 46) {
      const horizontal = Math.abs(dx) > Math.abs(dy)
      const direction = horizontal ? (dx > 0 ? 'RIGHT' : 'LEFT') : (dy > 0 ? 'DOWN' : 'UP')
      showFeedback(direction)
      emitCommand(direction.toLowerCase(), 10)
      return
    }

    const now = Date.now()
    if (now - lastTap.current < 330) {
      window.clearTimeout(tapTimer.current)
      lastTap.current = 0
      showFeedback('BACK')
      emitCommand('back', [8, 35, 8])
      return
    }

    lastTap.current = now
    tapTimer.current = window.setTimeout(() => {
      showFeedback('CONFIRM')
      emitCommand('submit', 8)
      lastTap.current = 0
    }, 335)
  }

  const feedbackGlyph = useMemo(() => {
    const glyphs = { UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→', BACK: '↩', CONFIRM: '·' }
    return glyphs[feedback] ?? feedback
  }, [feedback])

  const playbackState = [
    'preparing',
    'buffering',
    'playing',
    'paused',
    'ended',
    'error',
  ].includes(playback?.state)
    ? playback.state
    : 'stopped'
  const playbackLabels = {
    get preparing() { return t("正在准备") },
    get buffering() { return t("正在缓冲") },
    get playing() { return t("正在播放") },
    get paused() { return t("已暂停") },
    get ended() { return t("播放结束") },
    get error() { return t("播放出错") },
    get stopped() { return t("未在播放") },
  }
  const durationTicks = Math.max(0, Number(playback?.durationTicks || 0))
  const positionTicks = Math.max(0, Number(playback?.positionTicks || 0))
  const playbackProgress = durationTicks > 0
    ? Math.min(100, positionTicks / durationTicks * 100)
    : 0
  const showPlayback = playbackState !== 'stopped'
    && Boolean(playback?.title || playback?.itemId)

  return (
    <section
      ref={surfaceRef}
      className={`touchpad-screen ${pressed ? 'is-pressed' : ''} ${searchActive ? 'is-search-input' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancelPointer}
      onLostPointerCapture={() => { if (pointerStart.current) cancelPointer() }}
    >
      {!pureBlack && <img className="touchpad-texture" src={assetUrl('luma-touchpad-void.png')} alt="" draggable="false" />}
      {!pureBlack && <div ref={glowRef} className="finger-glow"><i /></div>}
      {!simpleUi && !pureBlack && <div className="touchpad-grain" />}

      <header className="touchpad-top">
        <button
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onExit}
          aria-label={t("退出触控板")}
        >
          <X size={15} />
        </button>
        <span><i /> RAYNEO AIR 3S</span>
        <em>{displayMode === 'stereo' ? '3D' : '2D'}</em>
      </header>

      {searchActive && (
        <aside
          className="touchpad-search-input"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
        >
          <span className="touchpad-search-input__status"><i />  {t("眼镜搜索已连接")}</span>
          <label>
            <Search size={18} />
            <input
              ref={searchInputRef}
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck="false"
              maxLength={48}
              value={searchValue}
              placeholder={t("输入拼音首字母、完整拼音或英文")}
              aria-label={t("眼镜端剧集搜索")}
              onFocus={() => onSearchAction('search-keyboard-visible')}
              onBlur={() => onSearchAction('search-keyboard-hidden')}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                onSearchAction('search-submit')
                event.currentTarget.blur()
              }}
              onChange={(event) => {
                const next = normalizeRemoteSearchQuery(event.target.value)
                setSearchValue(next)
                onSearchText(next)
              }}
            />
            {searchValue && (
              <button
                type="button"
                aria-label={t("清空搜索")}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  setSearchValue('')
                  onSearchText('')
                  searchInputRef.current?.focus()
                }}
              >
                <X size={15} />
              </button>
            )}
          </label>
          <small>{t("手机键盘输入会实时显示在眼镜中")}</small>
        </aside>
      )}

      {circularEnabled && (
        <div ref={seekRingRef} className="touchpad-seek-ring" aria-label={t("环形调节播放进度")}>
          <span>↶　　↷</span><strong>{feedback.startsWith('seek:') ? t("{0} {1} 秒", { 0: Number(feedback.slice(5)) > 0 ? t("快进") : t("快退"), 1: Math.abs(Number(feedback.slice(5))) }) : t("转动调节进度")}</strong><small>{t("顺时针快进 · 逆时针快退")}<br />{t("转得越快，调整越多")}</small>
        </div>
      )}

      {showPlayback && !searchActive && (
        <aside
          className={`touchpad-playback is-${playbackState}`}
          style={{ '--playback-progress': `${playbackProgress}%` }}
          aria-live="polite"
        >
          <span className="touchpad-playback__status">
            <i /> {playbackLabels[playbackState]}
          </span>
          <strong>{playback.title}</strong>
          {playback.subtitle && <small>{playback.subtitle}</small>}
          <div className="touchpad-playback__timeline"><i /></div>
          <div className="touchpad-playback__meta">
            <span>{formatPlaybackTime(positionTicks)} / {formatPlaybackTime(durationTicks)}</span>
            <em>{playback.playMethod === 'Transcode' ? t("服务器转码") : t("直接播放")}</em>
          </div>
        </aside>
      )}

      <div className={`touch-feedback ${feedback && !feedback.startsWith('seek:') ? 'is-visible' : ''}`}>
        <span>{feedbackGlyph}</span>
        <small>{feedback === 'CONFIRM' ? t("确认") : feedback === 'BACK' ? t("返回") : feedback.startsWith('seek:') ? t("环形调节") : feedback ? t("向{0}", { 0: { get UP() { return t("上") }, get DOWN() { return t("下") }, get LEFT() { return t("左") }, get RIGHT() { return t("右") } }[feedback] }) : ''}</small>
      </div>

      <div ref={introRef} className={`touchpad-intro ${introVisible && !searchActive ? 'is-visible' : ''}`}>
        {!pureBlack && <span className="touchpad-intro__mark"><i /></span>}
        <strong>{t("触控已就绪")}</strong>
        <small>{t("在任意位置开始")}</small>
      </div>

      <footer className={introVisible || searchActive ? 'is-visible' : ''}>
        {searchActive
          ? t("输入完成后点键盘“搜索”，焦点会进入眼镜端结果")
          : t("滑动移动 · 单击确认 · 双击返回")}
      </footer>
    </section>
  )
}

function ManualServerSheet({ open, onClose, onContinue }) {
  const [address, setAddress] = useState('')
  const sheetRef = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const opener = document.querySelector('.manual-card')
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const keydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
      }
      if (event.key !== 'Tab') return
      const targets = [...sheetRef.current.querySelectorAll('button:not(:disabled), input')]
      const first = targets[0]
      const last = targets.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.body.style.overflow = overflow
      document.removeEventListener('keydown', keydown)
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [open])

  const submit = () => {
    const clean = address.trim()
    if (!clean) return
    const host = clean.replace(/\/+$/, '')
    onContinue({
      id: 'manual',
      name: host.replace(/^https?:\/\//i, '') || t("自定义媒体库"),
      host,
      get detail() { return t("手动地址") },
      latency: '--',
      strength: 3,
    })
  }

  return (
    <div className={`sheet-layer${open ? '' : ' is-leaving'}`} inert={!open} role="dialog" aria-modal="true" aria-hidden={!open} aria-label={t("手动添加服务器")}>
      <button className="sheet-scrim" onClick={onClose} aria-label={t("关闭")} tabIndex={-1} />
      <form ref={sheetRef} className="bottom-sheet" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <div className="sheet-handle" />
        <div className="sheet-title">
          <div>
            <span className="eyebrow">MANUAL CONNECTION</span>
            <h2>{t("添加服务器地址")}</h2>
          </div>
          <button type="button" className="icon-button glass-soft" onClick={onClose} aria-label={t("关闭添加服务器")}><X size={18} /></button>
        </div>
        <p>{t("支持域名、IPv4 和 IPv6；IPv6 带端口时需要使用方括号。")}</p>
        <label className="address-field">
          <Link2 size={18} />
          <span>
            <small>{t("Jellyfin 地址")}</small>
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="jellyfin.local:8096"
              inputMode="url"
              enterKeyHint="go"
              autoComplete="url"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
            />
          </span>
        </label>
        <div className="address-example">{t("例如：jellyfin.local:8096 或 http://[2001:db8::20]:8096")}</div>
        <button className="primary-button pressable" type="submit" disabled={!address.trim()}>
          <span>{t("继续登录")}</span><ArrowRight size={19} />
        </button>
      </form>
    </div>
  )
}

export default App
