import { useEffect, useState, type RefObject } from 'react'
import { NativePlayback, type PlaybackSurface } from './nativePlayback'
import { subscribeRuntime } from './runtime'
import type { RealtimeStatus } from './useRealtimeSbs'

export function useNativeSbs(videoRef: RefObject<PlaybackSurface | null>, sourceKey: string, debug: boolean) {
  const [enabled, setEnabled] = useState(false)
  const [stereo, setStereo] = useState(false)
  const [status, setStatus] = useState<RealtimeStatus>('off')
  let available = false
  try { available = window.RayNeoGlasses?.realtimeSbsAvailable?.() === true } catch { /* Standard build. */ }
  useEffect(() => {
    const unsubscribe = subscribeRuntime(runtime => setStereo(runtime.displayMode === 'stereo_screen'
      && runtime.displayModeApplied === true && !runtime.displayModeTransitioning))
    return () => { unsubscribe() }
  }, [])
  useEffect(() => {
    const video = videoRef.current
    if (!(video instanceof NativePlayback)) return
    video.setDepth(enabled, debug)
    const refresh = () => {
      const depth = video.snapshot?.depth
      setStatus(!enabled ? 'off' : !stereo ? 'needs-stereo' : depth?.state === 'error' ? 'error'
        : depth?.state === 'initializing' ? 'loading' : depth?.render?.valid
          ? depth.render.ageMs > 500 ? 'stale' : 'frame' : 'ready')
    }
    refresh()
    video.addEventListener('timeupdate', refresh)
    return () => video.removeEventListener('timeupdate', refresh)
  }, [enabled, stereo, debug, sourceKey, videoRef])
  return { available, enabled, toggle: () => setEnabled(value => !value), status,
    metrics: { nativeMs: 0, roundTripMs: 0, updates: 0 }, depth: null }
}
