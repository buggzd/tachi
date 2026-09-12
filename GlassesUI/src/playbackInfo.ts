import { t } from '../../SharedUI/i18n.mjs'
import type Hls from 'hls.js'
import type { PlaybackPlan } from './jellyfin'

export type PlaybackStats = {
  decoder?: string
  width?: number
  height?: number
  videoCodec?: string
  audioCodec?: string
  frameRate?: number
  bitrate?: number
  bufferSeconds?: number
  droppedFrames?: number
  totalFrames?: number
}

export type PlaybackInfoRow = { label: string; value: string }
export type PlaybackInfoSource = { plan: PlaybackPlan | null; codecs: Pick<PlaybackStats, 'videoCodec' | 'audioCodec'> }

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

// Display technical tokens only, never a URL, file path, or arbitrary server text.
function token(value: unknown) {
  return typeof value === 'string' && /^[a-z\d ._+()-]{1,48}$/i.test(value) ? value.trim() : ''
}

export function codecFamily(value: unknown) {
  const codec = token(value).toLowerCase()
  const family = codec.split('.')[0]
  if (['h264', 'avc', 'avc1', 'avc3'].includes(family)) return 'h264'
  if (['hevc', 'h265', 'hev1', 'hvc1'].includes(family)) return 'hevc'
  if (['av1', 'av01'].includes(family)) return 'av1'
  if (['vp9', 'vp09'].includes(family)) return 'vp9'
  if (['vp8', 'vp08'].includes(family)) return 'vp8'
  if (/^mp4a\.40\./.test(codec)) return 'aac'
  if (codec === 'ac-3') return 'ac3'
  if (codec === 'ec-3') return 'eac3'
  return codec
}

function codecLabel(value: unknown) {
  const codec = codecFamily(value)
  if (codec === 'h264') return 'H.264'
  if (codec === 'eac3') return 'E-AC-3'
  if (codec === 'ac3') return 'AC-3'
  return codec.toUpperCase()
}

function decimal(value: number, digits = 2) {
  return String(Number(value.toFixed(digits)))
}

function bitrate(value: unknown) {
  const number = positive(value)
  if (!number) return ''
  return number >= 1_000_000 ? `${decimal(number / 1_000_000)} Mbps` : `${decimal(number / 1_000)} kbps`
}

function frameRate(value: unknown) {
  const number = positive(value)
  return number ? `${decimal(number, 3)} fps` : ''
}

function resolution(width: unknown, height: unknown) {
  return positive(width) && positive(height) ? `${Math.round(Number(width))} × ${Math.round(Number(height))}` : ''
}

function fileSize(value: unknown) {
  const size = positive(value)
  if (!size) return ''
  return size >= 1024 ** 3 ? `${decimal(size / 1024 ** 3)} GiB` : `${decimal(size / 1024 ** 2)} MiB`
}

const joined = (...values: (string | undefined)[]) => values.filter(Boolean).join(' · ')
const row = (label: string, value: string): PlaybackInfoRow => ({ label, value: value || t("未提供") })

const transcodeReasons: Record<string, string> = {
  get ContainerNotSupported() { return t("封装不兼容") },
  get VideoCodecNotSupported() { return t("视频编码不兼容") },
  get AudioCodecNotSupported() { return t("音频编码不兼容") },
  get SubtitleCodecNotSupported() { return t("字幕需要烧录") },
  get VideoProfileNotSupported() { return t("视频规格不兼容") },
  get VideoLevelNotSupported() { return t("视频级别不兼容") },
  get VideoBitDepthNotSupported() { return t("视频位深不兼容") },
  get VideoRangeTypeNotSupported() { return t("动态范围不兼容") },
  get VideoResolutionNotSupported() { return t("分辨率超出支持范围") },
  get VideoBitrateNotSupported() { return t("视频码率超出限制") },
  get AudioBitrateNotSupported() { return t("音频码率超出限制") },
  get ContainerBitrateExceedsLimit() { return t("总码率超出限制") },
  get AudioChannelsNotSupported() { return t("声道数不兼容") },
  get AudioSampleRateNotSupported() { return t("采样率不兼容") },
  get DirectPlayError() { return t("直放失败") },
}

function streamParameters(plan: PlaybackPlan) {
  const params = new Map<string, string>()
  try {
    new URL(plan.url).searchParams.forEach((value, key) => params.set(key.toLowerCase(), value))
  } catch { /* An unavailable URL must not prevent the passive overlay from rendering. */ }
  return params
}

export function playbackMethodLabel(plan: PlaybackPlan | null) {
  if (!plan) return t("正在准备")
  if (plan.playMethod === 'Transcode') return t("服务器转码")
  if (plan.playMethod === 'DirectStream') return t("直接串流")
  return t("直接播放")
}

export function samplePlaybackStats(video: HTMLVideoElement, hls: Hls | null): PlaybackStats {
  // A new source can temporarily retain dimensions/counters from the previous one.
  if (video.readyState < 1) return {}
  const level = hls?.levels[hls.currentLevel]
  const audioTrack = hls?.audioTracks[hls.audioTrack]
  const stats: PlaybackStats = {
    width: positive(video.videoWidth),
    height: positive(video.videoHeight),
    videoCodec: token(level?.videoCodec),
    audioCodec: token(audioTrack?.audioCodec) || token(level?.audioCodec),
    frameRate: positive(level?.frameRate),
    bitrate: positive(level?.averageBitrate) ?? positive(level?.bitrate),
    bufferSeconds: 0,
  }
  // Count only the range containing the playhead; a seek may leave disjoint ranges.
  try {
    for (let index = 0; index < video.buffered.length; index += 1) {
      if (video.buffered.start(index) <= video.currentTime && video.buffered.end(index) >= video.currentTime) {
        stats.bufferSeconds = Math.max(0, video.buffered.end(index) - video.currentTime)
        break
      }
    }
    const quality = video.getVideoPlaybackQuality?.()
    if (quality && Number.isFinite(quality.totalVideoFrames) && Number.isFinite(quality.droppedVideoFrames)
      && quality.totalVideoFrames >= 0 && quality.droppedVideoFrames >= 0) {
      stats.totalFrames = Math.floor(quality.totalVideoFrames)
      stats.droppedFrames = Math.min(stats.totalFrames, Math.floor(quality.droppedVideoFrames))
    }
  } catch { /* Older WebViews may omit playback quality or invalidate a buffered range. */ }
  return stats
}

export function playbackInfoRows(plan: PlaybackPlan, stats: PlaybackStats, hardwareCodecs: readonly string[] | null) {
  const source = plan.mediaInfo
  const originalStream = !plan.transcoding && plan.playMethod === 'DirectPlay'
  const params = streamParameters(plan)
  // Manifest codecs describe the current rendition. Source codecs are only valid for direct play.
  const videoCodec = stats.videoCodec || (originalStream ? plan.videoCodec : '')
  const audioCodec = stats.audioCodec || (originalStream ? plan.audioCodec : '')
  const videoFamily = codecFamily(videoCodec)
  const hardware = !videoFamily ? t("等待播放格式")
    : hardwareCodecs === null ? t("未提供能力信息")
      : hardwareCodecs.includes(videoFamily) ? t("支持 {0}", { 0: codecLabel(videoCodec) }) : t("未报告 {0} 支持", { 0: codecLabel(videoCodec) })
  const outputFrameRate = stats.frameRate ?? (originalStream ? source.frameRate : undefined)
  const outputBitrate = stats.bitrate ?? (originalStream ? source.bitrate : undefined)
  const selectedSubtitle = plan.subtitleTracks.find((track) => track.index === plan.subtitleStreamIndex)
  const subtitle = plan.subtitleStreamIndex < 0 ? t("关闭")
    : joined(codecLabel(selectedSubtitle?.codec), plan.subtitleBurnedIn ? t("烧录到视频") : plan.subtitleFormat === 'ass' ? t("本地样式字幕") : t("文字字幕"))
  const frames = stats.totalFrames === undefined ? t("当前 WebView 未提供")
    : t("{0} / {1} 帧{2}", { 0: stats.droppedFrames ?? 0, 1: stats.totalFrames, 2: stats.totalFrames > 0 ? ` · ${decimal((stats.droppedFrames ?? 0) / stats.totalFrames * 100)}%` : '' })
  const current = [
    row(t("播放视频"), joined(codecLabel(videoCodec), resolution(stats.width, stats.height)) || t("等待媒体数据")),
    row(t("帧率 / 码率"), joined(frameRate(outputFrameRate) || t("帧率未提供"), bitrate(outputBitrate) || t("码率未提供"))),
    row(t("音频 / 字幕"), joined(codecLabel(audioCodec) || t("编码待确认"), subtitle)),
    row(t("向前缓冲"), stats.bufferSeconds === undefined ? t("等待媒体数据") : t("{0} 秒", { 0: decimal(stats.bufferSeconds, 1) })),
    row(t("丢帧 / 总帧"), frames),
    row(t("解码方式"), stats.decoder ? `Media3 · ${token(stats.decoder)}` : t("系统自动（WebView）")),
    row(t("硬解能力"), hardware),
  ]
  if (!originalStream) {
    const target = joined(codecLabel(params.get('videocodec')), codecLabel(params.get('audiocodec')))
    if (target) current.push(row(t("请求编码"), target))
    const reasons = (params.get('transcodereasons') ?? '').slice(0, 1024).split(',').slice(0, 12)
    const knownReasons = [...new Set(reasons.map((reason) => Object.hasOwn(transcodeReasons, reason) ? transcodeReasons[reason] : '').filter(Boolean))]
    if (knownReasons.length) current.push(row(t("转码原因"), knownReasons.slice(0, 2).join(' · ')
      + (knownReasons.length > 2 ? t(" 等 {0} 项", { 0: knownReasons.length }) : '')))
  }
  const original = [
    row(t("封装 / 大小"), joined(token(plan.container), fileSize(source.size))),
    row(t("源视频"), joined(codecLabel(plan.videoCodec), resolution(plan.width, plan.height))),
    row(t("帧率 / 码率"), joined(frameRate(source.frameRate), bitrate(source.videoBitrate))),
    row(t("视频格式"), joined(token(source.profile), positive(source.bitDepth) ? `${source.bitDepth} bit` : '', token(source.videoRange))),
    row(t("像素 / 色彩"), joined(token(source.pixelFormat), token(source.colorSpace))),
    row(t("源音频"), joined(codecLabel(plan.audioCodec), positive(source.audioChannels) ? t("{0} 声道", { 0: source.audioChannels }) : '',
      positive(source.audioSampleRate) ? `${decimal(Number(source.audioSampleRate) / 1000)} kHz` : '', bitrate(source.audioBitrate))),
  ].filter((entry) => entry.value !== t("未提供"))
  return { current, original }
}
