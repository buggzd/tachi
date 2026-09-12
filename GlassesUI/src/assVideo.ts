import type { PlaybackSurface } from './nativePlayback'
import type { AssRenderer } from './assRenderer'

// Match object-fit: contain, so ASS PlayRes/positioning follows the image, not
// the control chrome or the outer letterbox. Native stereo copies this once.
export function assVideoRect(width: number, height: number, videoWidth: number, videoHeight: number) {
  if (![width, height, videoWidth, videoHeight].every((value) => Number.isFinite(value) && value > 0)) return null
  const scale = Math.min(width / videoWidth, height / videoHeight)
  const w = videoWidth * scale
  const h = videoHeight * scale
  return { width: w, height: h, left: (width - w) / 2, top: (height - h) / 2 }
}

export function bindAssVideo(video: PlaybackSurface, canvas: HTMLCanvasElement, renderer: AssRenderer) {
  let disposed = false
  let callback = 0
  let lastTime = -1
  const browser = 'requestVideoFrameCallback' in video ? video as HTMLVideoElement : null
  const frameCallbacks = typeof browser?.requestVideoFrameCallback === 'function'
  const render = (time: number, force = false) => {
    if (disposed || document.hidden || video.seeking || video.readyState < 2) return
    if (force || time !== lastTime) { lastTime = time; renderer.render(time) }
  }
  const cancel = () => {
    if (!callback) return
    if (frameCallbacks) browser!.cancelVideoFrameCallback(callback)
    else cancelAnimationFrame(callback)
    callback = 0
  }
  const schedule = () => {
    if (disposed || callback || document.hidden || video.paused || video.seeking || video.readyState < 2) return
    if (frameCallbacks) callback = browser!.requestVideoFrameCallback((_now, metadata) => {
      callback = 0
      render(metadata.mediaTime)
      schedule()
    })
    else callback = requestAnimationFrame(() => { callback = 0; render(video.currentTime); schedule() })
  }
  const resize = () => {
    const rect = assVideoRect(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight)
    if (!rect) { canvas.style.visibility = 'hidden'; return }
    Object.assign(canvas.style, { width: `${rect.width}px`, height: `${rect.height}px`, left: `${rect.left}px`, top: `${rect.top}px` })
    // Cap backing pixels per eye without changing ASS script geometry.
    const scale = Math.min(window.devicePixelRatio || 1, 1920 / rect.width, 1080 / rect.height)
    const width = Math.max(1, Math.round(rect.width * scale))
    const height = Math.max(1, Math.round(rect.height * scale))
    if (canvas.width !== width || canvas.height !== height) renderer.resize(width, height)
    render(video.currentTime, true)
  }
  const update = () => {
    cancel()
    canvas.style.visibility = document.hidden || video.seeking || video.readyState < 2 ? 'hidden' : 'visible'
    if (!document.hidden) { resize(); render(video.currentTime, true); schedule() }
  }
  const events = ['loadedmetadata', 'loadeddata', 'resize', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ratechange', 'ended', 'emptied']
  events.forEach((event) => video.addEventListener(event, update))
  const timeupdate = () => { render(video.currentTime); schedule() }
  video.addEventListener('timeupdate', timeupdate)
  document.addEventListener('visibilitychange', update)
  window.addEventListener('resize', update)
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
  if (typeof Element !== 'undefined' && video instanceof Element) observer?.observe(video)
  update()
  return () => {
    disposed = true
    cancel()
    observer?.disconnect()
    events.forEach((event) => video.removeEventListener(event, update))
    video.removeEventListener('timeupdate', timeupdate)
    document.removeEventListener('visibilitychange', update)
    window.removeEventListener('resize', update)
  }
}
