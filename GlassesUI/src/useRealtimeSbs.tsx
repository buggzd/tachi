import { useEffect, useRef, useState, type RefObject } from 'react'
import { subscribeRuntime } from './runtime'
import { assVideoRect } from './assVideo'

export type RealtimeStatus = 'off' | 'needs-stereo' | 'subtitles' | 'loading' | 'ready' | 'frame' | 'stale' | 'flat' | 'error'
type DepthMessage = { token: string; status: string; sequence: number; nativeMs?: number; depth?: string }
const WIDTH = 266, HEIGHT = 154
const maskSelector = '.player-topbar,.player-chrome--bottom,.playback-info,.player-volume,.seek-feedback,.seek-preview,.player-state,.player-error,.realtime-sbs-debug'

function base64(bytes: Uint8ClampedArray) {
  let text = ''
  for (let start = 0; start < bytes.length; start += 8192) text += String.fromCharCode(...bytes.subarray(start, start + 8192))
  return btoa(text)
}

export function useRealtimeSbs(videoRef: RefObject<HTMLVideoElement | null>, sourceKey: string,
  playable: boolean, subtitles: boolean, debug: boolean) {
  const [enabled, setEnabled] = useState(false)
  const [stereo, setStereo] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const [status, setStatus] = useState<RealtimeStatus>('off')
  const [metrics, setMetrics] = useState({ nativeMs: 0, roundTripMs: 0, updates: 0 })
  const [depth, setDepth] = useState<string | null>(null)
  const failed = useRef(false)
  const debugRef = useRef(debug)
  debugRef.current = debug
  let available = false
  try { available = window.RayNeoGlasses?.realtimeSbsAvailable?.() === true } catch { /* No native capability. */ }

  useEffect(() => {
    const unsubscribe = subscribeRuntime(runtime => setStereo(runtime.displayMode === 'stereo_screen'
      && runtime.displayModeApplied === true && runtime.displayModeTransitioning !== true))
    return () => { unsubscribe() }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const reset = () => { setDepth(null); setEpoch(value => value + 1) }
    const visibility = () => { reset() }
    const events = ['seeking', 'seeked', 'pause', 'playing', 'emptied', 'resize']
    events.forEach(event => video.addEventListener(event, reset))
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('resize', reset)
    return () => {
      events.forEach(event => video.removeEventListener(event, reset))
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('resize', reset)
    }
  }, [videoRef])

  useEffect(() => {
    setDepth(null)
    const video = videoRef.current, bridge = window.RayNeoGlasses
    if (!enabled) { setStatus('off'); return }
    if (failed.current) { setStatus('error'); return }
    if (!stereo) { setStatus('needs-stereo'); return }
    if (subtitles) { setStatus('subtitles'); return }
    if (!available || !video || !bridge?.startRealtimeSbs || !bridge.submitRealtimeFrame || !bridge.stopRealtimeSbs) {
      setStatus('error'); return
    }
    if (!playable || document.hidden || video.paused || video.seeking) { setStatus('ready'); return }
    let token: string
    try { token = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('') }
    catch { setStatus('error'); return }
    const canvas = document.createElement('canvas')
    canvas.width = WIDTH; canvas.height = HEIGHT
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context || typeof video.requestVideoFrameCallback !== 'function') { setStatus('error'); return }
    let disposed = false, busy = false, ready = false, callback = 0, sequence = 0, started = 0
    let updates = 0, lastPublish = 0
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      disposed = true
      if (callback) video.cancelVideoFrameCallback(callback)
      clearTimeout(watchdog)
      bridge.stopRealtimeSbs?.(token)
    }
    const fail = () => { failed.current = true; stop(); setStatus('error'); setDepth(null) }
    const schedule = () => {
      if (disposed || callback) return
      callback = video.requestVideoFrameCallback(() => {
        callback = 0
        if (disposed) return
        schedule()
        if (!ready || busy || video.seeking || video.paused || document.hidden || video.readyState < 2) return
        try {
          const bounds = video.getBoundingClientRect()
          const content = assVideoRect(bounds.width, bounds.height, video.videoWidth, video.videoHeight)
          if (!content || !innerWidth || !innerHeight) return
          const rect = [
            (bounds.left + content.left) / innerWidth, (bounds.top + content.top) / innerHeight,
            (bounds.left + content.left + content.width) / innerWidth,
            (bounds.top + content.top + content.height) / innerHeight,
          ]
          if (rect.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return
          const masks: number[][] = []
          for (const element of document.querySelectorAll<HTMLElement>(maskSelector)) {
            if (element.closest('[aria-hidden="true"],.is-hidden') || getComputedStyle(element).display === 'none') continue
            const r = element.getBoundingClientRect()
            if (r.width <= 0 || r.height <= 0) continue
            const mask = [Math.max(0, r.left / innerWidth), Math.max(0, r.top / innerHeight),
              Math.min(1, r.right / innerWidth), Math.min(1, r.bottom / innerHeight)]
            if (mask[2] > mask[0] && mask[3] > mask[1]) masks.push(mask)
          }
          if (masks.length > 8) { fail(); return }
          const capturedAt = Date.now()
          started = performance.now()
          context.drawImage(video, 0, 0, WIDTH, HEIGHT)
          const rgba = base64(context.getImageData(0, 0, WIDTH, HEIGHT).data)
          busy = true
          const accepted = bridge.submitRealtimeFrame?.(JSON.stringify({ token, sequence: ++sequence,
            capturedAt, rgba, rect, masks, debug: debugRef.current }))
          if (!accepted) { fail(); return }
          watchdog = setTimeout(() => setStatus('stale'), 2000)
        } catch { fail() }
      })
    }
    const receive = (event: Event) => {
      if (disposed) return
      const message = (event as CustomEvent<DepthMessage>).detail
      if (!message || message.token !== token) return
      if (message.status === 'error') { fail(); return }
      if (message.status === 'ready') { clearTimeout(watchdog); ready = true; setStatus('ready'); schedule(); return }
      if ((message.status !== 'frame' && message.status !== 'stale' && message.status !== 'flat') || message.sequence !== sequence) return
      clearTimeout(watchdog)
      busy = false
      updates++
      if (performance.now() - lastPublish > 500) {
        lastPublish = performance.now()
        setStatus(message.status)
        setMetrics({ nativeMs: Number(message.nativeMs) || 0, roundTripMs: performance.now() - started, updates })
        if (debugRef.current && typeof message.depth === 'string' && message.depth.length === 54620) setDepth(message.depth)
      }
    }
    window.addEventListener('tachi-depth', receive)
    setStatus('loading')
    watchdog = setTimeout(fail, 15000)
    bridge.startRealtimeSbs(token)
    return () => { stop(); window.removeEventListener('tachi-depth', receive) }
  }, [enabled, stereo, subtitles, available, playable, sourceKey, epoch, videoRef])

  return { available, enabled, toggle: () => { failed.current = false; setEnabled(value => !value) }, status, metrics, depth }
}

export function DepthPreview({ value }: { value: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const context = ref.current?.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, WIDTH, HEIGHT)
    if (!value) return
    try {
      const bytes = atob(value)
      if (bytes.length !== WIDTH * HEIGHT) return
      const image = context.createImageData(WIDTH, HEIGHT)
      for (let i = 0; i < bytes.length; i++) {
        image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = bytes.charCodeAt(i)
        image.data[i * 4 + 3] = 255
      }
      context.putImageData(image, 0, 0)
    } catch { /* Ignore an invalid diagnostic frame. */ }
  }, [value])
  return <canvas ref={ref} width={WIDTH} height={HEIGHT} aria-hidden="true" />
}
