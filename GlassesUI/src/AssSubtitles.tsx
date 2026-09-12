import { useEffect, useRef, type RefObject } from 'react'
import { bindAssVideo } from './assVideo'
import type { PlaybackSurface } from './nativePlayback'
import type { AssRenderer } from './assRenderer'

export default function AssSubtitles({ videoRef, url, fontUrls, onError }: {
  videoRef: RefObject<PlaybackSurface | null>
  url: string
  fontUrls?: string[]
  onError: (failed: boolean) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    const controller = new AbortController()
    let renderer: AssRenderer | undefined
    let unbind: (() => void) | undefined
    let disposed = false
    onError(false)
    const fail = () => {
      if (disposed) return
      unbind?.()
      renderer?.dispose()
      onError(true)
    }
    void import('./assRenderer').then(async ({ createAssRenderer, loadSubtitleAsset }) => {
      if (disposed) return
      const source = new TextDecoder().decode(await loadSubtitleAsset(url, 16 * 1024 * 1024, controller.signal))
      if (disposed) return
      // libass owns all ASS parsing; reject unrelated responses without logging them.
      if (!/^\s*\[Events\]/im.test(source)) throw new Error('Invalid ASS subtitle')
      renderer = await createAssRenderer(canvas, source, fontUrls ?? [], controller.signal, fail)
      if (disposed) { renderer.dispose(); return }
      unbind = bindAssVideo(video, canvas, renderer)
    }).catch(() => { if (!disposed) fail() })
    return () => {
      disposed = true
      unbind?.()
      controller.abort()
      renderer?.dispose()
    }
  }, [videoRef, url, fontUrls, onError])
  return <canvas ref={canvasRef} className="ass-subtitle-canvas" aria-hidden="true" />
}
