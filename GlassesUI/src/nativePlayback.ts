import type { PlaybackPlan } from './jellyfin'
import { subscribeRuntime } from './runtime'

/** Media clock/control contract shared by the browser preview and native Android player. */
export type PlaybackSurface = Pick<HTMLVideoElement, 'currentTime' | 'duration' | 'paused' | 'ended'
  | 'seeking' | 'readyState' | 'playbackRate' | 'videoWidth' | 'videoHeight' | 'clientWidth' | 'clientHeight'
  | 'play' | 'pause' | 'addEventListener' | 'removeEventListener'>
export type NativeSnapshot = {
  token: string; generation: number; status: string; position: number; duration: number; buffered?: number
  width?: number; height?: number; pixelRatio?: number; firstFrame?: boolean; seekable?: boolean; rate?: number
  decoder?: string; videoCodec?: string; audioCodec?: string; audioChannels?: number; audioSampleRate?: number
  droppedFrames?: number; decodedFrames?: number; frameRate?: number; errorCode?: number; httpStatus?: number; seekId?: number
  depth?: { state: string; render?: { valid: boolean; ageMs: number; uploads: number }; worker?: { inference?: { meanMs: number } } }
}

export function hasNativePlayback() {
  try { return window.RayNeoGlasses?.nativePlaybackAvailable?.() === true } catch { return false }
}

// EventTarget, not a hidden HTML media element. No Chromium decoder, texture, or capture loop.
export class NativePlayback extends EventTarget implements PlaybackSurface {
  private token = ''
  private generation = -1
  private position = 0
  private receivedAt = 0
  private state = 'idle'
  private disposed = false
  private seekPending = false
  get canSeek() { return this.snapshot?.seekable === true }
  private seekId = 0
  duration = 0
  readyState = 0
  videoWidth = 0
  videoHeight = 0
  playbackRate = 1
  snapshot: NativeSnapshot | null = null
  private unsubscribe: () => void
  constructor(private element: () => HTMLElement | null) {
    super()
    this.unsubscribe = subscribeRuntime(runtime => {
      if (this.generation !== -1 && (runtime.catalogGeneration !== this.generation || !runtime.session)) this.stop()
      this.generation = runtime.catalogGeneration
    })
    window.addEventListener('tachi-native-playback', this.receive)
  }
  get clientWidth() { return this.element()?.clientWidth ?? 0 }
  get clientHeight() { return this.element()?.clientHeight ?? 0 }
  get paused() { return this.state !== 'playing' && this.state !== 'buffering' }
  get ended() { return this.state === 'ended' }
  get seeking() { return this.seekPending }
  get currentTime() {
    const elapsed = this.state === 'playing' && !this.seekPending ? Math.min(.25, (performance.now() - this.receivedAt) / 1000) * this.playbackRate : 0
    return Math.min(this.duration || Infinity, this.position + elapsed)
  }
  set currentTime(value: number) {
    if (!Number.isFinite(value)) return
    this.position = Math.max(0, Math.min(this.duration || Infinity, value))
    this.seekPending = true
    this.emit('seeking')
    this.command('seek', { position: this.position, seekId: ++this.seekId })
  }
  private emit(name: string) { this.dispatchEvent(new Event(name)) }
  private command(operation: string, fields: Record<string, unknown> = {}) {
    if (!this.token || this.disposed) return
    window.RayNeoGlasses?.nativePlaybackCommand?.(JSON.stringify({ operation, token: this.token, generation: this.generation, ...fields }))
  }
  open(plan: PlaybackPlan, playing: boolean) {
    this.stop()
    this.token = crypto.randomUUID()
    this.state = 'buffering'
    this.position = plan.startPositionTicks / 10_000_000
    this.duration = plan.durationTicks / 10_000_000
    this.videoWidth = plan.width ?? 0
    this.videoHeight = plan.height ?? 0
    this.readyState = 0
    this.snapshot = null
    this.seekId = 0
    this.seekPending = false
    this.command('open', { url: plan.url, position: this.position, playing, hls: plan.transcoding || /\.m3u8(?:$|\?)/i.test(plan.url),
      subtitleKind: plan.subtitleBurnedIn ? 'burned' : plan.subtitleFormat ?? 'off',
      audioOrdinal: plan.transcoding ? -1 : plan.audioTracks.findIndex(track => track.index === plan.audioStreamIndex) })
  }
  diagnose(event: 'prepare' | 'prepare_error' | 'plan_ready' | 'fallback' | 'playback_error', fields: {
    failureCode?: string; httpStatus?: number; hls?: boolean; fallbackAvailable?: boolean; duration?: number
  } = {}) {
    try { window.RayNeoGlasses?.playbackDiagnostic?.(JSON.stringify({ event, generation: this.generation, ...fields })) } catch { /* Diagnostics cannot block playback. */ }
  }
  play() { this.command('play'); return Promise.resolve() }
  pause() { this.command('pause') }
  setSubtitleError(failed: boolean) { this.command('subtitle', { subtitleError: failed }) }
  setDepth(enabled: boolean, debug: boolean) { this.command('depth', { depth: enabled, debug }) }
  stop() {
    this.command('stop')
    this.token = ''
    this.state = 'idle'
    this.readyState = 0
    this.seekPending = false
    this.emit('emptied')
  }
  dispose() { this.stop(); this.disposed = true; this.unsubscribe(); window.removeEventListener('tachi-native-playback', this.receive) }
  private receive = (event: Event) => {
    const next = (event as CustomEvent<NativeSnapshot>).detail
    if (!next || next.token !== this.token || next.generation !== this.generation || this.disposed) return
    if (!Number.isFinite(next.position) || !Number.isFinite(next.duration)) return
    this.snapshot = next
    const previous = this.state, wasReady = this.readyState, width = this.videoWidth, height = this.videoHeight
    if (this.seekPending && (next.seekId ?? 0) < this.seekId && next.status !== 'error') return
    this.position = next.position
    this.receivedAt = performance.now()
    if (next.duration > 0 && next.duration !== this.duration) { this.duration = next.duration; this.emit('durationchange') }
    this.videoWidth = (next.width ?? this.videoWidth) * (next.pixelRatio ?? 1)
    this.videoHeight = next.height ?? this.videoHeight
    this.playbackRate = next.rate ?? 1
    this.state = next.status
    this.readyState = next.firstFrame ? 2 : 0
    if (width !== this.videoWidth || height !== this.videoHeight) this.emit('resize')
    if (!wasReady && this.readyState >= 2) { this.emit('loadedmetadata'); this.emit('loadeddata') }
    if (this.seekPending && next.status !== 'buffering') { this.seekPending = false; this.emit('seeked') }
    if (previous !== next.status) {
      const names: Record<string, string> = { playing: 'playing', paused: 'pause', buffering: 'waiting', ended: 'ended', error: 'error' }
      if (names[next.status]) this.emit(names[next.status])
    }
    this.emit('timeupdate')
  }
}
