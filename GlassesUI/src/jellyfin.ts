import { t } from '../../SharedUI/i18n.mjs'
import { WatchProgress, latestWatchedEpisode } from './watchProgress'
import type { MediaItem, MediaKind, MediaShelf } from './data'
import { getNativeHardwareVideoCodecs, type JellyfinSession } from './runtime'

type JellyfinUserData = {
  PlaybackPositionTicks?: number
  LastPlayedDate?: string
  PlayedPercentage?: number
  UnplayedItemCount?: number
  IsFavorite?: boolean
  Played?: boolean
}

type JellyfinMediaStream = {
  Type?: string
  Codec?: string
  Profile?: string
  Level?: number
  BitDepth?: number
  PixelFormat?: string
  Title?: string
  DisplayTitle?: string
  Width?: number
  Height?: number
  BitRate?: number
  AverageFrameRate?: number
  RealFrameRate?: number
  VideoRangeType?: string
  ColorSpace?: string
  SampleRate?: number
  Channels?: number
  Language?: string
  IsDefault?: boolean
  IsForced?: boolean
  IsHearingImpaired?: boolean
  IsExternal?: boolean
  SupportsExternalStream?: boolean
  DeliveryUrl?: string
  Index?: number
}

type JellyfinMediaSource = {
  Protocol?: string
  Id?: string
  Name?: string
  Path?: string
  Container?: string
  Bitrate?: number
  Size?: number
  RunTimeTicks?: number
  MediaStreams?: JellyfinMediaStream[]
  MediaAttachments?: { Index?: number; FileName?: string; MimeType?: string }[]
  SupportsTranscoding?: boolean
  SupportsDirectStream?: boolean
  SupportsDirectPlay?: boolean
  DirectStreamUrl?: string
  TranscodingUrl?: string
  TranscodingContainer?: string
  TranscodingSubProtocol?: string
  DefaultAudioStreamIndex?: number
  DefaultSubtitleStreamIndex?: number
}

type JellyfinPlaybackInfoResponse = {
  MediaSources?: JellyfinMediaSource[]
  PlaySessionId?: string
  ErrorCode?: string
}

export type JellyfinItemDto = {
  Id?: string
  Name?: string
  OriginalTitle?: string
  SortName?: string
  ForcedSortName?: string
  Aliases?: string[]
  Type?: string
  MediaType?: string
  CollectionType?: string
  IsFolder?: boolean
  ParentId?: string
  SeriesId?: string
  SeasonId?: string
  SeriesName?: string
  SeasonName?: string
  IndexNumber?: number
  ParentIndexNumber?: number
  ChildCount?: number
  RunTimeTicks?: number
  ProductionYear?: number
  PremiereDate?: string
  DateCreated?: string
  CommunityRating?: number
  OfficialRating?: string
  Overview?: string
  Taglines?: string[]
  Genres?: string[]
  Path?: string
  PrimaryImageAspectRatio?: number
  ImageTags?: Record<string, string>
  BackdropImageTags?: string[]
  SeriesPrimaryImageTag?: string
  UserData?: JellyfinUserData
  Studios?: Array<{ Name?: string }>
  People?: Array<{ Name?: string; Role?: string; Type?: string }>
  MediaSources?: JellyfinMediaSource[]
}

type JellyfinItemsResponse = {
  Items?: JellyfinItemDto[]
  TotalRecordCount?: number
}

export type CatalogSnapshot = {
  featured: MediaItem
  shelves: MediaShelf[]
  libraries: MediaItem[]
  allItems: MediaItem[]
  favorites: MediaItem[]
}

export type DetailSnapshot = {
  item: MediaItem
  seriesId?: string
  selectedSeasonId?: string
  seasons: MediaItem[]
  episodes: MediaItem[]
  similar: MediaItem[]
  extras: MediaItem[]
}

export type PlaybackTrack = {
  index: number
  label: string
  language: string
  codec: string
  channels?: number
  default: boolean
  forced: boolean
  external: boolean
  text: boolean
}

export type PlaybackEndpoint = {
  url: string
  playSessionId: string
  playMethod: 'DirectPlay' | 'DirectStream' | 'Transcode'
  transcoding: boolean
  subtitleBurnedIn: boolean
}

export type PlaybackPlan = PlaybackEndpoint & {
  itemId: string
  mediaSourceId: string
  startPositionTicks: number
  durationTicks: number
  canSeek: boolean
  container: string
  videoCodec: string
  audioCodec: string
  width?: number
  height?: number
  mediaInfo: {
    size?: number
    bitrate?: number
    videoBitrate?: number
    frameRate?: number
    profile?: string
    bitDepth?: number
    pixelFormat?: string
    videoRange?: string
    colorSpace?: string
    audioChannels?: number
    audioSampleRate?: number
    audioBitrate?: number
  }
  audioTracks: PlaybackTrack[]
  subtitleTracks: PlaybackTrack[]
  audioStreamIndex?: number
  subtitleStreamIndex: number
  subtitleUrl?: string
  subtitleFormat?: 'ass' | 'vtt'
  subtitleFontUrls?: string[]
  fallback?: PlaybackEndpoint
}

export type PlaybackSelection = {
  mediaSourceId?: string
  audioStreamIndex?: number
  subtitleStreamIndex?: number
  forceTranscode?: boolean
}

export type JellyfinFailureCode = 'none' | 'network' | 'http' | 'response' | 'unknown'

const requestTimeoutMs = 20_000

class JellyfinRequestError extends Error {
  readonly code: Exclude<JellyfinFailureCode, 'none'>

  constructor(code: Exclude<JellyfinFailureCode, 'none'>, message: string, readonly httpStatus?: number) {
    super(message)
    this.name = 'JellyfinRequestError'
    this.code = code
  }
}

export function describeJellyfinFailure(reason: unknown): {
  code: Exclude<JellyfinFailureCode, 'none'>
  message: string
  httpStatus?: number
} {
  if (reason instanceof JellyfinRequestError) {
    return { code: reason.code, message: reason.message, httpStatus: reason.httpStatus }
  }
  const message = reason instanceof Error ? reason.message.trim() : ''
  return {
    code: 'unknown',
    message: (message || t("无法读取 Jellyfin 数据。")).slice(0, 240),
  }
}

const itemFields = [
  'Overview',
  'Genres',
  'Studios',
  'People',
  'MediaSources',
  'PrimaryImageAspectRatio',
  'DateCreated',
  'ProductionYear',
  'CommunityRating',
  'OfficialRating',
  'RunTimeTicks',
  'UserData',
  'Path',
  'Taglines',
].join(',')

const seriesIndexFields = [
  'PrimaryImageAspectRatio',
  'ChildCount',
  'DateCreated',
  'Genres',
  'OriginalTitle',
  'SortName',
].join(',')
const seriesIndexPageSize = 200
const maximumSeriesIndexItems = 50_000

const directPlayMaxBitrate = 120_000_000
const transcodeMaxBitrate = 24_000_000
const maximumDirectPlayWidth = 3_840
const maximumDirectPlayHeight = 2_160
const knownWebViewVideoCodecs = ['h264', 'hevc', 'vp8', 'vp9', 'av1'] as const

function hasNativePlayback() {
  try { return window.RayNeoGlasses?.nativePlaybackAvailable?.() === true } catch { return false }
}

function browserSupportsVideoCodec(codec: string) {
  if (typeof document === 'undefined') return codec === 'h264'
  const video = document.createElement('video')
  const contentTypes: Record<string, string[]> = {
    h264: ['video/mp4; codecs="avc1.42E01E"'],
    hevc: [
      'video/mp4; codecs="hvc1.1.6.L93.B0"',
      'video/mp4; codecs="hev1.1.6.L93.B0"',
    ],
    vp8: ['video/webm; codecs="vp8"'],
    vp9: [
      'video/webm; codecs="vp09.00.31.08"',
      'video/webm; codecs="vp9"',
    ],
    av1: ['video/webm; codecs="av01.0.08M.08"'],
  }
  return (contentTypes[codec] ?? []).some((contentType) => video.canPlayType(contentType) !== '')
}

function detectHardwareVideoCodecs() {
  const nativeCodecs = getNativeHardwareVideoCodecs()
  const candidates = nativeCodecs ?? knownWebViewVideoCodecs
  return new Set(hasNativePlayback() ? (nativeCodecs ?? []) : candidates.filter(browserSupportsVideoCodec))
}

function videoConditions(maximumBitDepth: number) {
  return [
    ...(hasNativePlayback() ? [{ Condition: 'Equals', Property: 'VideoRangeType', Value: 'SDR', IsRequired: false }] : []),
    {
      Condition: 'LessThanEqual',
      Property: 'Width',
      Value: String(maximumDirectPlayWidth),
      IsRequired: false,
    },
    {
      Condition: 'LessThanEqual',
      Property: 'Height',
      Value: String(maximumDirectPlayHeight),
      IsRequired: false,
    },
    {
      Condition: 'LessThanEqual',
      Property: 'VideoBitDepth',
      Value: String(maximumBitDepth),
      IsRequired: false,
    },
  ]
}

function nativeAudioCodecs(): string[] {
  try {
    const codecs: unknown = JSON.parse(window.RayNeoGlasses?.getNativeAudioCodecs?.() ?? '[]')
    return Array.isArray(codecs) ? codecs.filter((value): value is string => typeof value === 'string'
      && ['aac', 'mp3', 'ac3', 'eac3', 'opus', 'vorbis', 'flac'].includes(value)) : []
  } catch { return [] }
}

function createWebViewDeviceProfile(hardwareVideoCodecs: ReadonlySet<string>) {
  const native = hasNativePlayback()
  const audio = native ? nativeAudioCodecs().join(',') : 'aac,mp3,ac3,eac3,opus'
  const mp4VideoCodecs = ['h264', 'hevc'].filter((codec) => hardwareVideoCodecs.has(codec))
  const webmVideoCodecs = ['vp8', 'vp9', 'av1'].filter((codec) => hardwareVideoCodecs.has(codec))
  const eightBitVideoCodecs = ['h264', 'vp8'].filter((codec) => hardwareVideoCodecs.has(codec))
  const tenBitVideoCodecs = ['hevc', 'vp9', 'av1'].filter((codec) => hardwareVideoCodecs.has(codec))

  return {
    Name: native ? 'tachi Android Media3 Hardware SDR' : 'tachi Android WebView Hardware',
    MaxStreamingBitrate: directPlayMaxBitrate,
    MaxStaticBitrate: directPlayMaxBitrate,
    DirectPlayProfiles: [
      ...(native && hardwareVideoCodecs.size > 0 ? [{ Container: 'mkv', Type: 'Video',
        VideoCodec: [...hardwareVideoCodecs].join(','), AudioCodec: audio }] : []),
      ...(mp4VideoCodecs.length > 0 ? [{
        Container: 'mp4,m4v,mov',
        Type: 'Video',
        VideoCodec: mp4VideoCodecs.join(','),
        AudioCodec: audio,
      }] : []),
      ...(webmVideoCodecs.length > 0 ? [{
        Container: 'webm',
        Type: 'Video',
        VideoCodec: webmVideoCodecs.join(','),
        AudioCodec: native ? nativeAudioCodecs().filter(codec => ['vorbis', 'opus'].includes(codec)).join(',') : 'vorbis,opus',
      }] : []),
    ],
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: 'Video',
        VideoCodec: 'h264',
        AudioCodec: 'aac,mp3',
        Protocol: 'hls',
        Context: 'Streaming',
        MaxAudioChannels: '2',
        MinSegments: 2,
        SegmentLength: 6,
        EnableSubtitlesInManifest: false,
      },
    ],
    ContainerProfiles: [],
    CodecProfiles: [
      ...(eightBitVideoCodecs.length > 0 ? [{
        Type: 'Video',
        Codec: eightBitVideoCodecs.join(','),
        Conditions: videoConditions(8),
        ApplyConditions: [],
      }] : []),
      ...(tenBitVideoCodecs.length > 0 ? [{
        Type: 'Video',
        Codec: tenBitVideoCodecs.join(','),
        Conditions: videoConditions(10),
        ApplyConditions: [],
      }] : []),
    ],
    SubtitleProfiles: [
      // ASS/SSA use local libass; other text codecs are converted to WebVTT.
      { Format: 'ass', Method: 'External' },
      { Format: 'ssa', Method: 'External' },
      { Format: 'vtt', Method: 'External' },
      { Format: 'webvtt', Method: 'External' },
      { Format: 'pgssub', Method: 'Encode' },
      { Format: 'dvdsub', Method: 'Encode' },
      { Format: 'dvbsub', Method: 'Encode' },
    ],
  }
}

function normalizeCodec(value: string | undefined) {
  const codec = value?.trim().toLocaleLowerCase() ?? ''
  if (['avc', 'avc1'].includes(codec)) return 'h264'
  if (['h265', 'hev1', 'hvc1'].includes(codec)) return 'hevc'
  if (codec === 'subrip') return 'srt'
  return codec
}

function normalizeContainer(value: string | undefined) {
  const container = value?.split(',')[0]?.trim().toLocaleLowerCase() ?? ''
  if (['m4v', 'mov'].includes(container)) return 'mp4'
  return container
}

function inferredVideoBitDepth(stream: JellyfinMediaStream | undefined) {
  if (stream?.BitDepth && Number.isFinite(stream.BitDepth)) return stream.BitDepth
  const pixelFormat = stream?.PixelFormat?.toLocaleLowerCase() ?? ''
  const planar = pixelFormat.match(/(?:yuvj?\d{3}p|gbrp|gray)(\d{2})(?:le|be)?$/)
  if (planar) return Number(planar[1])
  const packed = pixelFormat.match(/^p0?(\d{2})(?:le|be)?$/)
  if (packed) return Number(packed[1])
  if (/^(?:yuvj?\d{3}p|nv12|nv21)$/.test(pixelFormat)) return 8
  return undefined
}

function isHardwareProfileCompatible(stream: JellyfinMediaStream | undefined) {
  if (!stream) return false
  const codec = normalizeCodec(stream.Codec)
  const profile = stream.Profile?.trim().toLocaleLowerCase() ?? ''
  const pixelFormat = stream.PixelFormat?.trim().toLocaleLowerCase() ?? ''
  const bitDepth = inferredVideoBitDepth(stream)
  if (!knownWebViewVideoCodecs.some((candidate) => candidate === codec)) return false
  if (bitDepth === undefined || bitDepth <= 0) return false
  if (/(?:422|444|gbr|rgb)/.test(pixelFormat)) return false
  const maximumBitDepth = codec === 'h264' || codec === 'vp8' ? 8 : 10
  if (bitDepth > maximumBitDepth) return false

  if (codec === 'h264') {
    return !/(?:high\s*10|high\s*4:2:2|high\s*4:4:4|cavlc\s*4:4:4)/.test(profile)
  }
  if (codec === 'hevc') {
    return !/(?:main\s*12|4:2:2|4:4:4|range\s*extension|rext)/.test(profile)
  }
  if (codec === 'vp9') {
    return !/(?:profile\s*)?[13](?:\D|$)/.test(profile)
  }
  if (codec === 'av1') {
    return !/(?:high|professional)/.test(profile)
  }
  return true
}

function isWithinHardwarePlaybackLimits(
  stream: JellyfinMediaStream | undefined,
  sourceBitrate: number | undefined,
) {
  const bitrate = stream?.BitRate ?? sourceBitrate
  return Boolean(stream)
    && Number.isFinite(stream?.Width)
    && Number(stream?.Width) > 0
    && Number(stream?.Width) <= maximumDirectPlayWidth
    && Number.isFinite(stream?.Height)
    && Number(stream?.Height) > 0
    && Number(stream?.Height) <= maximumDirectPlayHeight
    && Number.isFinite(bitrate)
    && Number(bitrate) > 0
    && Number(bitrate) <= directPlayMaxBitrate
    && isHardwareProfileCompatible(stream)
}

function isTextSubtitle(value: string | undefined) {
  return [
    'vtt',
    'webvtt',
    'srt',
    'subrip',
    'ass',
    'ssa',
    'mov_text',
    'tx3g',
    'text',
  ].includes(normalizeCodec(value))
}

function streamsOfType(source: JellyfinMediaSource, type: 'Audio' | 'Subtitle' | 'Video') {
  return (source.MediaStreams ?? []).filter((stream) => stream.Type === type)
}

function resolveStream(
  source: JellyfinMediaSource,
  type: 'Audio' | 'Subtitle',
  requestedIndex: number | undefined,
) {
  const streams = streamsOfType(source, type)
  if (type === 'Subtitle' && requestedIndex !== undefined && requestedIndex < 0) return undefined
  const sourceDefault = type === 'Audio'
    ? source.DefaultAudioStreamIndex
    : source.DefaultSubtitleStreamIndex
  const selected = requestedIndex ?? sourceDefault
  return streams.find((stream) => stream.Index === selected)
    ?? streams.find((stream) => stream.IsDefault)
    ?? (type === 'Audio' ? streams[0] : undefined)
}

function trackLabel(stream: JellyfinMediaStream, type: 'Audio' | 'Subtitle') {
  const language = stream.Language?.trim() || (type === 'Audio' ? t("未知语言") : t("字幕"))
  const codec = normalizeCodec(stream.Codec).toLocaleUpperCase()
  const channels = type === 'Audio' && stream.Channels ? t("{0} 声道", { 0: stream.Channels }) : ''
  const forced = stream.IsForced ? t("强制") : ''
  return stream.DisplayTitle?.trim()
    || stream.Title?.trim()
    || [language, codec, channels, forced].filter(Boolean).join(' · ')
}

function mapTrack(stream: JellyfinMediaStream, type: 'Audio' | 'Subtitle'): PlaybackTrack {
  return {
    index: stream.Index ?? 0,
    get label() { return trackLabel(stream, type) },
    language: stream.Language?.trim() || '',
    codec: normalizeCodec(stream.Codec).toLocaleUpperCase(),
    channels: stream.Channels,
    default: Boolean(stream.IsDefault),
    forced: Boolean(stream.IsForced),
    external: Boolean(stream.IsExternal || stream.SupportsExternalStream),
    text: type === 'Audio' || isTextSubtitle(stream.Codec),
  }
}

function hash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return Math.abs(result >>> 0)
}

function padEpisode(value: number | undefined) {
  return value === undefined ? '--' : String(value).padStart(2, '0')
}

function formatDuration(ticks: number | undefined) {
  if (!ticks || ticks <= 0) return undefined
  const minutes = Math.max(1, Math.round(ticks / 600_000_000))
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (!hours) return t("{0} 分钟", { 0: minutes })
  if (!remainder) return t("{0} 小时", { 0: hours })
  return t("{0} 小时 {1} 分", { 0: hours, 1: String(remainder).padStart(2, '0') })
}

function mediaKind(item: JellyfinItemDto): MediaKind {
  switch (item.Type) {
    case 'Movie':
      return '电影'
    case 'Series':
    case 'Episode':
    case 'Season':
      return '剧集'
    case 'BoxSet':
    case 'Playlist':
    case 'MusicAlbum':
      return '合集'
    case 'CollectionFolder':
    case 'Folder':
    case 'UserView':
      return '文件夹'
    default:
      return '视频'
  }
}

function libraryLabel(collectionType: string | undefined) {
  switch (collectionType?.toLocaleLowerCase()) {
    case 'boxsets':
      return t("合集组")
    case 'movies':
      return t("电影库")
    case 'tvshows':
      return t("剧集库")
    case 'music':
      return t("音乐库")
    case 'homevideos':
      return t("家庭视频")
    case 'photos':
      return t("照片库")
    case 'musicvideos':
      return t("音乐视频")
    default:
      return t("媒体库")
  }
}

function itemSubtitle(item: JellyfinItemDto) {
  if (item.Type === 'Episode') {
    return `S${padEpisode(item.ParentIndexNumber)} E${padEpisode(item.IndexNumber)} · ${item.Name ?? item.SeasonName ?? t('剧集')}`
  }
  if (item.Type === 'Series') {
    const count = item.ChildCount ? t("{0} 集", { 0: item.ChildCount }) : '剧集'
    return [count, ...(item.Genres ?? []).slice(0, 2)].join(' · ')
  }
  if (item.Type === 'CollectionFolder' || item.Type === 'Folder' || item.Type === 'UserView') {
    return `${libraryLabel(item.CollectionType)}${item.ChildCount ? t(" · {0} 项", { 0: item.ChildCount }) : ''}`
  }

  const facts = [
    item.ProductionYear ? String(item.ProductionYear) : '',
    formatDuration(item.RunTimeTicks) ?? '',
    ...(item.Genres ?? []).slice(0, 1),
  ].filter(Boolean)
  return facts.join(' · ') || mediaKind(item)
}

function resolutionFor(source: JellyfinMediaSource | undefined) {
  const video = source?.MediaStreams?.find((stream) => stream.Type === 'Video')
  const width = video?.Width ?? 0
  const height = video?.Height ?? 0
  if (width >= 3800 || height >= 2100) return '4K'
  if (width >= 1900 || height >= 1060) return '1080P'
  if (width >= 1260 || height >= 700) return '720P'
  return video?.DisplayTitle?.split(' ')[0]
}

function progressFor(item: JellyfinItemDto) {
  const userData = item.UserData
  if (!userData || userData.Played) return undefined
  if (typeof userData.PlayedPercentage === 'number' && userData.PlayedPercentage > 0) {
    return Math.min(99, Math.max(1, Math.round(userData.PlayedPercentage)))
  }
  if (!item.RunTimeTicks || !userData.PlaybackPositionTicks) return undefined
  return Math.min(99, Math.max(1, Math.round(
    userData.PlaybackPositionTicks / item.RunTimeTicks * 100,
  )))
}

function unique(items: MediaItem[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

export class JellyfinClient {
  readonly session: JellyfinSession
  private readonly hardwareVideoCodecs: ReadonlySet<string>
  private readonly deviceProfile: ReturnType<typeof createWebViewDeviceProfile>
  private readonly onUnauthorized: () => void
  private unauthorizedPublished = false
  private readonly watchProgress = new WatchProgress()
  private readonly playbackItems = new Map<string, MediaItem>()
  private readonly startedPlayback = new Set<string>()

  constructor(session: JellyfinSession, onUnauthorized: () => void = () => undefined) {
    this.session = session
    this.hardwareVideoCodecs = detectHardwareVideoCodecs()
    this.deviceProfile = createWebViewDeviceProfile(this.hardwareVideoCodecs)
    this.onUnauthorized = onUnauthorized
  }

  private url(path: string, query: Record<string, string | number | boolean | undefined> = {}) {
    const base = `${this.session.serverUrl}/${path.replace(/^\/+/, '')}`
    const url = new URL(base)
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    })
    return url.toString()
  }

  private async request<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    headers.set('X-Emby-Token', this.session.accessToken)
    headers.set(
      'X-Emby-Authorization',
      `MediaBrowser Client="tachi", Device="RayNeo Air", DeviceId="${this.session.deviceId}", Version="${__APP_VERSION__}", Token="${this.session.accessToken}"`,
    )
    if (init.body) headers.set('Content-Type', 'application/json')

    const controller = new AbortController()
    const externalSignal = init.signal
    const abortFromExternalSignal = () => controller.abort()
    if (externalSignal?.aborted) controller.abort()
    else externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true })
    const timeout = window.setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      let response: Response
      try {
        response = await fetch(this.url(path, query), {
          ...init,
          headers,
          cache: 'no-store',
          signal: controller.signal,
        })
      } catch {
        throw new JellyfinRequestError(
          'network',
          controller.signal.aborted
            ? t("眼镜端连接 Jellyfin 超过 20 秒，请检查 WebView 网络与服务器可达性。")
            : t("眼镜端无法访问 Jellyfin。请检查当前网络和服务器地址；IPv6 带端口时必须使用方括号。"),
        )
      }
      if (!response.ok) {
        if ((response.status === 401 || response.status === 403) && !this.unauthorizedPublished) {
          this.unauthorizedPublished = true
          this.onUnauthorized()
        }
        throw new JellyfinRequestError(
          'http',
          t("Jellyfin 请求失败（HTTP {0}）。", { 0: response.status }),
          response.status,
        )
      }
      if (response.status === 204 || response.headers.get('Content-Length') === '0') {
        return undefined as T
      }
      try {
        return await response.json() as T
      } catch {
        if (controller.signal.aborted) {
          throw new JellyfinRequestError(
            'network',
            t("眼镜端读取 Jellyfin 响应超过 20 秒，请检查网络质量。"),
          )
        }
        throw new JellyfinRequestError(
          'response',
          t("Jellyfin 已响应，但返回的数据格式无法解析。"),
        )
      }
    } finally {
      window.clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', abortFromExternalSignal)
    }
  }

  private imageUrl(
    itemId: string,
    type: 'Primary' | 'Backdrop' | 'Logo',
    tag?: string,
    wide = false,
  ) {
    return this.url(`/Items/${encodeURIComponent(itemId)}/Images/${type}`, {
      tag,
      maxWidth: wide ? 1920 : 720,
      maxHeight: wide ? 1080 : 1080,
      quality: 88,
      api_key: this.session.accessToken,
    })
  }

  private absoluteUrl(path: string) {
    if (/^https?:\/\//i.test(path)) return path
    return `${this.session.serverUrl}/${path.replace(/^\/+/, '')}`
  }

  private authenticatedUrl(path: string, query: Record<string, string | number | boolean | undefined> = {}) {
    const url = new URL(this.absoluteUrl(path))
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    })
    url.searchParams.set('api_key', this.session.accessToken)
    return url.toString()
  }

  private playbackRequest(
    startPositionTicks: number,
    selection: PlaybackSelection,
    forceTranscode: boolean,
  ) {
    return {
      UserId: this.session.userId,
      StartTimeTicks: Math.max(0, Math.round(startPositionTicks)),
      MediaSourceId: selection.mediaSourceId,
      AudioStreamIndex: selection.audioStreamIndex,
      SubtitleStreamIndex: selection.subtitleStreamIndex,
      MaxStreamingBitrate: forceTranscode ? transcodeMaxBitrate : directPlayMaxBitrate,
      MaxAudioChannels: forceTranscode ? 2 : 8,
      EnableDirectPlay: !forceTranscode,
      EnableDirectStream: !forceTranscode,
      EnableTranscoding: true,
      AllowVideoStreamCopy: !forceTranscode,
      AllowAudioStreamCopy: !forceTranscode,
      AlwaysBurnInSubtitleWhenTranscoding: false,
      DeviceProfile: {
        ...this.deviceProfile,
        MaxStreamingBitrate: forceTranscode ? transcodeMaxBitrate : directPlayMaxBitrate,
        MaxStaticBitrate: forceTranscode ? transcodeMaxBitrate : directPlayMaxBitrate,
      },
    }
  }

  private directStreamUrl(
    itemId: string,
    source: JellyfinMediaSource,
    startPositionTicks: number,
    audioStreamIndex: number | undefined,
    subtitleStreamIndex: number,
    playSessionId: string,
  ) {
    if (source.DirectStreamUrl) {
      return this.videoUrl(source.DirectStreamUrl, subtitleStreamIndex < 0)
    }

    const container = normalizeContainer(source.Container)
    const extension = container === 'webm' ? 'webm' : hasNativePlayback() && container === 'mkv' ? 'mkv' : 'mp4'
    return this.authenticatedUrl(`/Videos/${encodeURIComponent(itemId)}/stream.${extension}`, {
      static: true,
      deviceId: this.session.deviceId,
      mediaSourceId: source.Id,
      startTimeTicks: startPositionTicks > 0 ? startPositionTicks : undefined,
      audioStreamIndex,
      subtitleStreamIndex,
      playSessionId,
    })
  }

  private videoUrl(path: string, localSubtitles: boolean) {
    const url = new URL(this.authenticatedUrl(path))
    if (localSubtitles) {
      // Even a stale fallback URL must not burn or multiplex the local track.
      for (const key of [...url.searchParams.keys()]) {
        if (['subtitlestreamindex', 'subtitlemethod'].includes(key.toLowerCase())) url.searchParams.delete(key)
      }
      url.searchParams.set('SubtitleStreamIndex', '-1')
      url.searchParams.set('SubtitleMethod', 'External')
    }
    return url.toString()
  }

  private subtitleUrl(
    itemId: string,
    source: JellyfinMediaSource,
    stream: JellyfinMediaStream | undefined,
  ) {
    if (!stream || stream.Index === undefined || !source.Id) return undefined
    const format = ['ass', 'ssa'].includes(normalizeCodec(stream.Codec)) ? 'ass' : 'vtt'
    // Keep ASS styling intact; all subtitle formats use the full media timeline.
    return this.authenticatedUrl(
      `/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(source.Id)}/Subtitles/${stream.Index}/Stream.${format}`,
      {
        copyTimestamps: false,
        addVttTimeMap: false,
        startPositionTicks: 0,
      },
    )
  }

  mapItem = (source: JellyfinItemDto): MediaItem => {
    const id = source.Id ?? `missing-${hash(source.Name ?? 'item')}`
    const sourceName = source.Name?.trim() || t("未命名媒体")
    const title = source.Type === 'Episode' && source.SeriesName?.trim()
      ? source.SeriesName.trim()
      : sourceName
    const mediaSource = source.MediaSources?.[0]
    const video = mediaSource?.MediaStreams?.find((stream) => stream.Type === 'Video')
    const audio = mediaSource?.MediaStreams?.find((stream) => stream.Type === 'Audio')
    const primaryOwner = source.ImageTags?.Primary
      ? id
      : source.SeriesPrimaryImageTag && source.SeriesId
        ? source.SeriesId
        : ''
    const primaryTag = source.ImageTags?.Primary ?? source.SeriesPrimaryImageTag
    const coverOwner = source.SeriesPrimaryImageTag && source.SeriesId
      ? source.SeriesId
      : primaryOwner
    const coverTag = source.SeriesPrimaryImageTag && source.SeriesId
      ? source.SeriesPrimaryImageTag
      : primaryTag
    const backdropTag = source.BackdropImageTags?.[0]
    const progress = progressFor(source)
    const playableTypes = ['Movie', 'Episode', 'Video', 'MusicVideo', 'Audio']

    return {
      id,
      title,
      original: source.Type === 'Episode' && sourceName !== title
        ? sourceName
        : source.OriginalTitle?.trim() || undefined,
      sortName: source.ForcedSortName?.trim() || source.SortName?.trim() || undefined,
      aliases: (source.Aliases ?? []).map((alias) => alias.trim()).filter(Boolean),
      get subtitle() { return itemSubtitle(source) },
      kind: mediaKind(source),
      year: source.ProductionYear ? String(source.ProductionYear) : undefined,
      get duration() { return formatDuration(source.RunTimeTicks ?? mediaSource?.RunTimeTicks) },
      rating: typeof source.CommunityRating === 'number'
        ? source.CommunityRating.toFixed(1)
        : undefined,
      progress,
      lastPlayedDate: source.UserData?.LastPlayedDate,
      art: hash(id) % 12,
      favorite: Boolean(source.UserData?.IsFavorite),
      watched: Boolean(source.UserData?.Played),
      unwatched: source.UserData?.UnplayedItemCount || undefined,
      folder: ['CollectionFolder', 'Folder', 'UserView', 'BoxSet'].includes(source.Type ?? ''),
      resolution: resolutionFor(mediaSource),
      overview: source.Overview?.trim() || undefined,
      tagline: source.Taglines?.find(Boolean)?.trim() || undefined,
      officialRating: source.OfficialRating?.trim() || undefined,
      genres: source.Genres ?? [],
      studios: (source.Studios ?? []).map((studio) => studio.Name ?? '').filter(Boolean),
      people: (source.People ?? []).map((person) => ({
        name: person.Name ?? '',
        role: person.Role ?? '',
        type: person.Type ?? '',
      })).filter((person) => person.name),
      path: source.Path,
      dateCreated: source.DateCreated,
      sourceType: source.Type,
      mediaType: source.MediaType,
      collectionType: source.CollectionType,
      parentId: source.ParentId,
      seriesId: source.SeriesId,
      seasonId: source.SeasonId,
      indexNumber: source.IndexNumber,
      parentIndexNumber: source.ParentIndexNumber,
      runtimeTicks: source.RunTimeTicks ?? mediaSource?.RunTimeTicks,
      playbackPositionTicks: source.UserData?.PlaybackPositionTicks,
      primaryImageAspectRatio: typeof source.PrimaryImageAspectRatio === 'number'
        && Number.isFinite(source.PrimaryImageAspectRatio) && source.PrimaryImageAspectRatio > 0
        ? source.PrimaryImageAspectRatio : undefined,
      imageUrl: primaryOwner && primaryTag
        ? this.imageUrl(primaryOwner, 'Primary', primaryTag)
        : undefined,
      coverUrl: coverOwner && coverTag
        ? this.imageUrl(coverOwner, 'Primary', coverTag)
        : undefined,
      backdropUrl: backdropTag
        ? this.imageUrl(id, 'Backdrop', backdropTag, true)
        : primaryOwner && primaryTag
          ? this.imageUrl(primaryOwner, 'Primary', primaryTag, true)
          : undefined,
      logoUrl: source.ImageTags?.Logo
        ? this.imageUrl(id, 'Logo', source.ImageTags.Logo, true)
        : undefined,
      videoCodec: video?.Codec?.toLocaleUpperCase(),
      audioCodec: audio?.Codec?.toLocaleUpperCase(),
      container: mediaSource?.Container?.toLocaleUpperCase(),
      width: video?.Width,
      height: video?.Height,
      bitrate: mediaSource?.Bitrate ?? video?.BitRate,
      canPlay: source.Type !== 'BoxSet' && (playableTypes.includes(source.Type ?? '') || source.MediaType === 'Video'),
    }
  }

  async loadHome(): Promise<CatalogSnapshot> {
    const common = {
      Fields: itemFields,
      ImageTypeLimit: 1,
      EnableImageTypes: 'Primary,Backdrop,Logo',
    }
    const userId = encodeURIComponent(this.session.userId)
    const [viewsResponse, resumeResponse, latestResponse, nextUpResponse, allResponse, favoriteResponse] = await Promise.all([
      this.request<JellyfinItemsResponse>(`/Users/${userId}/Views`, common),
      this.request<JellyfinItemsResponse>(`/Users/${userId}/Items/Resume`, {
        ...common,
        Recursive: true,
        MediaTypes: 'Video',
        Limit: 12,
      }),
      this.request<JellyfinItemDto[]>(`/Users/${userId}/Items/Latest`, {
        ...common,
        IncludeItemTypes: 'Movie,Series,Episode,Video',
        Limit: 14,
      }),
      this.request<JellyfinItemsResponse>('/Shows/NextUp', {
        ...common,
        UserId: this.session.userId,
        Limit: 12,
      }),
      this.request<JellyfinItemsResponse>(`/Users/${userId}/Items`, {
        ...common,
        Recursive: true,
        IncludeItemTypes: 'Movie,Series,Video',
        SortBy: 'DateCreated,SortName',
        SortOrder: 'Descending',
        Limit: 240,
      }),
      this.request<JellyfinItemsResponse>(`/Users/${userId}/Items`, {
        ...common,
        Recursive: true,
        IncludeItemTypes: 'Movie,Series,Episode,Video',
        Filters: 'IsFavorite',
        SortBy: 'SortName',
        Limit: 240,
      }),
    ])

    const libraries = (viewsResponse.Items ?? []).map(this.mapItem)
    const resume = (resumeResponse.Items ?? []).map(this.mapItem)
    const latest = (latestResponse ?? []).map(this.mapItem)
    const nextUp = (nextUpResponse.Items ?? []).map(this.mapItem)
    const allItems = (allResponse.Items ?? []).map(this.mapItem)
    const favorites = (favoriteResponse.Items ?? []).map(this.mapItem)
    const playable = unique([...resume, ...nextUp, ...latest, ...allItems]).filter((item) => item.canPlay || item.sourceType === 'Series')
    const featured = playable[0] ?? allItems[0] ?? libraries[0] ?? {
      id: 'empty-library',
      title: this.session.serverName || 'Jellyfin',
      get subtitle() { return t("媒体库暂无可显示内容") },
      kind: '文件夹',
      art: 0,
      folder: true,
      get overview() { return t("请在 Jellyfin 服务器中添加媒体，然后刷新页面。") },
    }
    const shelves: MediaShelf[] = [
      { id: 'libraries', title: "我的媒体", eyebrow: 'LIBRARIES', items: libraries, library: true },
      { id: 'resume', title: "继续观看", eyebrow: 'RESUME', items: resume },
      { id: 'next-up', title: "下一集", eyebrow: 'UP NEXT', items: nextUp },
      { id: 'latest', title: "最近添加", eyebrow: 'JUST IN', items: latest },
      { id: 'all', title: "探索媒体库", eyebrow: 'DISCOVER', items: allItems.slice(0, 14) },
    ].filter((shelf) => shelf.items.length)

    return { featured, shelves, libraries, allItems, favorites }
  }

  async loadFolder(parent: MediaItem) {
    // Match Jellyfin Web: ParentId resolves virtual collection views. An
    // IncludeItemTypes filter can make such a view return the library root.
    const response = await this.request<JellyfinItemsResponse>(
      `/Users/${encodeURIComponent(this.session.userId)}/Items`,
      {
        ParentId: parent.id,
        Recursive: false,
        Fields: itemFields,
        ImageTypeLimit: 1,
        EnableImageTypes: 'Primary,Backdrop,Logo',
        SortBy: 'SortName',
        SortOrder: 'Ascending',
        Limit: 500,
      },
    )
    return (response.Items ?? []).map(this.mapItem)
  }

  async loadSeriesIndex(signal?: AbortSignal) {
    const userId = encodeURIComponent(this.session.userId)
    const indexed: MediaItem[] = []
    const seen = new Set<string>()
    let startIndex = 0

    while (startIndex < maximumSeriesIndexItems) {
      const response = await this.request<JellyfinItemsResponse>(
        `/Users/${userId}/Items`,
        {
          Recursive: true,
          IncludeItemTypes: 'Series',
          Fields: seriesIndexFields,
          ImageTypeLimit: 1,
          EnableImageTypes: 'Primary,Backdrop,Logo',
          SortBy: 'SortName',
          SortOrder: 'Ascending',
          StartIndex: startIndex,
          Limit: seriesIndexPageSize,
          EnableTotalRecordCount: true,
        },
        { signal },
      )
      const items = response.Items ?? []
      let added = 0
      const remaining = maximumSeriesIndexItems - indexed.length
      for (const source of items.slice(0, remaining)) {
        const item = this.mapItem(source)
        if (!seen.has(item.id)) {
          seen.add(item.id)
          indexed.push(item)
          added += 1
        }
      }

      if (!items.length || !added || indexed.length >= maximumSeriesIndexItems) break
      startIndex += items.length
      const total = response.TotalRecordCount
      if ((typeof total === 'number' && startIndex >= total) || items.length < seriesIndexPageSize) break
    }

    return indexed
  }

  async loadDetail(itemId: string, requestedSeasonId?: string): Promise<DetailSnapshot> {
    await this.watchProgress.settle()
    const userId = encodeURIComponent(this.session.userId)
    const encodedItemId = encodeURIComponent(itemId)
    const detail = await this.request<JellyfinItemDto>(
      `/Users/${userId}/Items/${encodedItemId}`,
      { Fields: itemFields },
    )
    const item = this.watchProgress.patch(this.mapItem(detail))
    const seriesId = detail.Type === 'Series' ? detail.Id : detail.SeriesId

    const optionalItems = async (path: string, query: Record<string, string | number | boolean | undefined>) => {
      try {
        const response = await this.request<JellyfinItemsResponse | JellyfinItemDto[]>(path, query)
        return Array.isArray(response) ? response : response.Items ?? []
      } catch {
        return []
      }
    }

    const [seasonDtos, similarDtos, specialFeatureDtos, trailerDtos, recentDtos] = await Promise.all([
      seriesId
        ? optionalItems(`/Shows/${encodeURIComponent(seriesId)}/Seasons`, {
            UserId: this.session.userId,
            Fields: itemFields,
          })
        : Promise.resolve([]),
      optionalItems(`/Items/${encodedItemId}/Similar`, {
        UserId: this.session.userId,
        Limit: 10,
        Fields: itemFields,
      }),
      optionalItems(`/Items/${encodedItemId}/SpecialFeatures`, {
        UserId: this.session.userId,
        Fields: itemFields,
      }),
      optionalItems(`/Items/${encodedItemId}/LocalTrailers`, {
        UserId: this.session.userId,
        Fields: itemFields,
      }),
      seriesId && !requestedSeasonId
        ? optionalItems(`/Users/${userId}/Items`, {
            ParentId: seriesId, Recursive: true, IncludeItemTypes: 'Episode',
            SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: 1, Fields: itemFields,
          })
        : Promise.resolve([]),
    ])

    const recent = latestWatchedEpisode([
      ...recentDtos.map((recent) => this.watchProgress.patch(this.mapItem(recent))),
      ...[this.watchProgress.latestFor(item)].filter((value): value is MediaItem => Boolean(value)),
    ])
    const preferredSeasonId = requestedSeasonId
      ?? (detail.Type === 'Season' ? detail.Id : undefined)
      ?? recent?.seasonId ?? detail.SeasonId
    const seasons = seasonDtos.map(this.mapItem)
    const selectedSeason = seasons.find((season) => season.id === preferredSeasonId)
      ?? (detail.Type === 'Season' ? seasons.find((season) => season.id === detail.Id) : undefined)
      ?? seasons.find((season) => !season.watched) ?? seasons[0]
    const episodes = seriesId && selectedSeason
      ? (await optionalItems(`/Shows/${encodeURIComponent(seriesId)}/Episodes`, {
          UserId: this.session.userId,
          SeasonId: selectedSeason.id,
          Fields: itemFields,
          ImageTypeLimit: 1,
          EnableImageTypes: 'Primary,Backdrop',
        })).map(this.mapItem)
      : detail.Type === 'Episode'
        ? [item]
        : []

    return {
      item,
      seriesId,
      selectedSeasonId: selectedSeason?.id,
      seasons,
      episodes: episodes.map((episode) => this.watchProgress.patch(episode)),
      similar: similarDtos.map(this.mapItem),
      extras: unique([...specialFeatureDtos, ...trailerDtos].map(this.mapItem)),
    }
  }

  async preparePlayback(
    item: MediaItem,
    startPositionTicks = 0,
    selection: PlaybackSelection = {},
  ): Promise<PlaybackPlan> {
    if (!item.id || !item.canPlay) throw new Error(t("这个项目没有可播放的媒体源。"))
    this.playbackItems.set(item.id, item)
    if (this.playbackItems.size > 64) this.playbackItems.delete(this.playbackItems.keys().next().value!)

    const startTicks = Math.max(0, Math.round(startPositionTicks))
    const path = `/Items/${encodeURIComponent(item.id)}/PlaybackInfo`
    const directResponse = await this.request<JellyfinPlaybackInfoResponse>(
      path,
      {},
      {
        method: 'POST',
        body: JSON.stringify(this.playbackRequest(startTicks, selection, false)),
      },
    )
    const sources = directResponse.MediaSources ?? []
    const source = selection.mediaSourceId
      ? sources.find((candidate) => candidate.Id === selection.mediaSourceId) ?? sources[0]
      : sources[0]
    if (!source) {
      throw new Error(directResponse.ErrorCode
        ? t("Jellyfin 没有返回可播放源：{0}", { 0: directResponse.ErrorCode })
        : t("Jellyfin 没有返回可播放源。"))
    }

    const audioTracks = streamsOfType(source, 'Audio').map((stream) => mapTrack(stream, 'Audio'))
    const subtitleTracks = streamsOfType(source, 'Subtitle').map((stream) => mapTrack(stream, 'Subtitle'))
    const selectedAudio = resolveStream(source, 'Audio', selection.audioStreamIndex)
    const selectedSubtitle = resolveStream(source, 'Subtitle', selection.subtitleStreamIndex)
    const audioStreamIndex = selectedAudio?.Index
    const subtitleStreamIndex = selectedSubtitle?.Index ?? -1
    const video = streamsOfType(source, 'Video')[0]
    const container = normalizeContainer(source.Container)
    const videoCodec = normalizeCodec(video?.Codec)
    const audioCodec = normalizeCodec(selectedAudio?.Codec)
    const native = hasNativePlayback()
    const browserContainer = (native ? ['mp4', 'webm', 'mkv'] : ['mp4', 'm4v', 'mov', 'webm']).includes(container)
    const browserVideo = this.hardwareVideoCodecs.has(videoCodec)
      && isWithinHardwarePlaybackLimits(video, source.Bitrate)
      && (!native || !video?.VideoRangeType || video.VideoRangeType.toUpperCase() === 'SDR')
    const browserAudio = !selectedAudio
      || (native ? nativeAudioCodecs() : ['aac', 'mp3', 'ac3', 'eac3', 'opus', 'vorbis']).includes(audioCodec)
    const firstAudioIndex = streamsOfType(source, 'Audio')[0]?.Index
    const nonDefaultAudioSelection = selection.audioStreamIndex !== undefined
      && selection.audioStreamIndex !== firstAudioIndex
    const subtitleRequiresBurnIn = Boolean(selectedSubtitle && !isTextSubtitle(selectedSubtitle.Codec))
    const assSubtitle = Boolean(selectedSubtitle && ['ass', 'ssa'].includes(normalizeCodec(selectedSubtitle.Codec)))
    const videoSubtitleIndex = subtitleRequiresBurnIn ? subtitleStreamIndex : -1
    const canDirectPlay = !selection.forceTranscode
      && (native || !nonDefaultAudioSelection)
      && !subtitleRequiresBurnIn
      && Boolean(source.SupportsDirectPlay)
      && browserContainer
      && browserVideo
      && browserAudio

    let transcodeResponse: JellyfinPlaybackInfoResponse | undefined
    try {
      const forcedSelection: PlaybackSelection = {
        ...selection,
        mediaSourceId: source.Id,
        audioStreamIndex,
        subtitleStreamIndex: videoSubtitleIndex,
      }
      const transcodeRequest = this.playbackRequest(startTicks, forcedSelection, true)
      transcodeRequest.AlwaysBurnInSubtitleWhenTranscoding = subtitleRequiresBurnIn
      transcodeResponse = await this.request<JellyfinPlaybackInfoResponse>(
        path,
        {},
        { method: 'POST', body: JSON.stringify(transcodeRequest) },
      )
    } catch {
      // A direct-playable item may still work when server-side transcoding is unavailable.
    }

    const transcodedSource = transcodeResponse?.MediaSources?.find(
      (candidate) => candidate.Id === source.Id,
    ) ?? transcodeResponse?.MediaSources?.[0]
    const transcodePath = transcodedSource?.TranscodingUrl
      ?? (!canDirectPlay ? source.TranscodingUrl : undefined)
    const transcodeEndpoint: PlaybackEndpoint | undefined = transcodePath
      ? {
          url: this.videoUrl(transcodePath, !subtitleRequiresBurnIn),
          playSessionId: transcodeResponse?.PlaySessionId || directResponse.PlaySessionId || '',
          playMethod: 'Transcode',
          transcoding: true,
          subtitleBurnedIn: subtitleRequiresBurnIn,
        }
      : undefined
    const directEndpoint: PlaybackEndpoint | undefined = canDirectPlay
      ? {
          url: this.directStreamUrl(
            item.id,
            source,
            startTicks,
            audioStreamIndex,
            videoSubtitleIndex,
            directResponse.PlaySessionId ?? '',
          ),
          playSessionId: directResponse.PlaySessionId ?? '',
          playMethod: 'DirectPlay',
          transcoding: false,
          subtitleBurnedIn: false,
        }
      : undefined
    const endpoint = directEndpoint ?? transcodeEndpoint
    if (!endpoint) {
      throw new Error(transcodeResponse?.ErrorCode || directResponse.ErrorCode
        ? t("当前设备与服务器没有可用的播放路径：{0}", { 0: transcodeResponse?.ErrorCode || directResponse.ErrorCode })
        : t("当前设备与服务器没有可用的播放路径。"))
    }

    return {
      ...endpoint,
      itemId: item.id,
      mediaSourceId: source.Id ?? item.id,
      startPositionTicks: startTicks,
      durationTicks: source.RunTimeTicks ?? item.runtimeTicks ?? 0,
      canSeek: true,
      container: container.toLocaleUpperCase(),
      videoCodec: videoCodec.toLocaleUpperCase(),
      audioCodec: audioCodec.toLocaleUpperCase(),
      width: video?.Width,
      height: video?.Height,
      mediaInfo: {
        size: source.Size,
        bitrate: source.Bitrate,
        videoBitrate: video?.BitRate,
        frameRate: video?.AverageFrameRate || video?.RealFrameRate,
        profile: video?.Profile,
        bitDepth: inferredVideoBitDepth(video),
        pixelFormat: video?.PixelFormat,
        videoRange: video?.VideoRangeType,
        colorSpace: video?.ColorSpace,
        audioChannels: selectedAudio?.Channels,
        audioSampleRate: selectedAudio?.SampleRate,
        audioBitrate: selectedAudio?.BitRate,
      },
      audioTracks,
      subtitleTracks,
      audioStreamIndex,
      subtitleStreamIndex,
      subtitleFormat: subtitleStreamIndex < 0 || endpoint.subtitleBurnedIn ? undefined : assSubtitle ? 'ass' : 'vtt',
      subtitleFontUrls: assSubtitle && source.Id ? (source.MediaAttachments ?? [])
        .filter((font) => Number.isSafeInteger(font.Index) && font.Index! >= 0
          && (/\.(?:ttf|otf|woff2?)$/i.test(font.FileName ?? '')
            || /^(?:font\/(?:ttf|otf|woff2?)|application\/(?:x-truetype-font|x-font-ttf|vnd.ms-opentype))$/i.test(font.MimeType ?? '')))
        .slice(0, 24)
        .map((font) => this.authenticatedUrl(`/Videos/${encodeURIComponent(item.id)}/${encodeURIComponent(source.Id!)}/Attachments/${font.Index}`)) : undefined,
      subtitleUrl: !endpoint.subtitleBurnedIn && selectedSubtitle && isTextSubtitle(selectedSubtitle.Codec)
        ? this.subtitleUrl(item.id, source, selectedSubtitle)
        : undefined,
      fallback: directEndpoint ? transcodeEndpoint : undefined,
    }
  }

  async reportPlaybackStarted(plan: PlaybackPlan, paused: boolean, positionTicks: number) {
    this.startedPlayback.add(`${plan.itemId}:${plan.playSessionId}:${plan.playMethod}`)
    await this.reportPlayback('/Sessions/Playing', plan, paused, positionTicks)
  }

  async reportPlaybackProgress(plan: PlaybackPlan, paused: boolean, positionTicks: number) {
    await this.reportPlayback('/Sessions/Playing/Progress', plan, paused, positionTicks)
  }

  async reportPlaybackStopped(plan: PlaybackPlan, positionTicks: number, failed = false) {
    const item = this.playbackItems.get(plan.itemId)
    const started = this.startedPlayback.delete(`${plan.itemId}:${plan.playSessionId}:${plan.playMethod}`)
    const record = item && started ? this.watchProgress.record(item, positionTicks, plan.durationTicks) : undefined
    await this.watchProgress.track(this.request<unknown>(
      '/Sessions/Playing/Stopped',
      {},
      {
        method: 'POST',
        body: JSON.stringify({
          ItemId: plan.itemId,
          MediaSourceId: plan.mediaSourceId,
          PositionTicks: Math.max(0, Math.round(positionTicks)),
          PlaySessionId: plan.playSessionId,
          Failed: failed,
        }),
        keepalive: true,
      },
    ).then((result) => {
      if (record) this.watchProgress.confirm(record)
      return result
    }))
  }

  private async reportPlayback(
    path: string,
    plan: PlaybackPlan,
    paused: boolean,
    positionTicks: number,
  ) {
    await this.request<unknown>(
      path,
      {},
      {
        method: 'POST',
        body: JSON.stringify({
          CanSeek: plan.canSeek,
          ItemId: plan.itemId,
          MediaSourceId: plan.mediaSourceId,
          IsPaused: paused,
          IsMuted: false,
          PositionTicks: Math.max(0, Math.round(positionTicks)),
          PlayMethod: plan.playMethod,
          PlaySessionId: plan.playSessionId,
          AudioStreamIndex: plan.audioStreamIndex,
          SubtitleStreamIndex: plan.subtitleStreamIndex,
          RepeatMode: 'RepeatNone',
          PlaybackOrder: 'Default',
        }),
        keepalive: true,
      },
    )
  }

  async setFavorite(itemId: string, favorite: boolean) {
    await this.request<unknown>(
      `/Users/${encodeURIComponent(this.session.userId)}/FavoriteItems/${encodeURIComponent(itemId)}`,
      {},
      { method: favorite ? 'POST' : 'DELETE' },
    )
  }

  async setPlayed(itemId: string, played: boolean) {
    await this.request<unknown>(
      `/Users/${encodeURIComponent(this.session.userId)}/PlayedItems/${encodeURIComponent(itemId)}`,
      {},
      { method: played ? 'POST' : 'DELETE' },
    )
    this.watchProgress.forget(itemId)
  }
}
