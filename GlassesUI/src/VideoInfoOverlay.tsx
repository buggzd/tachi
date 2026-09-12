import { NativePlayback, type PlaybackSurface } from './nativePlayback'
import { t } from '../../SharedUI/i18n.mjs'
import { Info } from 'lucide-react'
import type Hls from 'hls.js'
import { memo, useEffect, useState, type RefObject } from 'react'
import type { PlaybackPlan } from './jellyfin'
import { getNativeHardwareVideoCodecs } from './runtime'
import { usePresence } from './feedback'
import { playbackInfoRows, playbackMethodLabel, samplePlaybackStats, type PlaybackStats, type PlaybackInfoSource } from './playbackInfo'
import './playbackInfo.css'

const VideoInfoOverlay = memo(function VideoInfoOverlay({ visible, plan, failed, videoRef, nativeRef, hlsRef, sourceRef }: {
  visible: boolean
  plan: PlaybackPlan | null
  failed: boolean
  videoRef: RefObject<HTMLVideoElement | null>
  nativeRef: RefObject<PlaybackSurface | null>
  hlsRef: RefObject<Hls | null>
  sourceRef: RefObject<PlaybackInfoSource>
}) {
  const mounted = usePresence(visible)
  const [sample, setSample] = useState<{ plan: PlaybackPlan; stats: PlaybackStats } | null>(null)
  useEffect(() => {
    if (!visible || !plan || failed) return
    const refresh = () => {
      if (document.hidden) return
      const native = nativeRef.current
      if (native instanceof NativePlayback) {
        const state = native.snapshot
        const mime = (value?: string) => ({ 'video/avc': 'h264', 'video/hevc': 'hevc', 'audio/mp4a-latm': 'aac',
          'audio/mpeg': 'mp3', 'video/x-vnd.on2.vp9': 'vp9', 'video/x-vnd.on2.vp8': 'vp8', 'video/av01': 'av1' }[value ?? ''] ?? value?.split('/').pop())
        setSample({ plan, stats: state ? { decoder: state.decoder || "MediaCodec", width: state.width, height: state.height, videoCodec: mime(state.videoCodec),
          audioCodec: mime(state.audioCodec), frameRate: state.frameRate && state.frameRate > 0 ? state.frameRate : undefined, bufferSeconds: Math.max(0, (state.buffered ?? 0) - state.position),
          droppedFrames: state.droppedFrames, totalFrames: state.decodedFrames } : {} })
        return
      }
      if (!videoRef.current) return
      if (sourceRef.current.plan !== plan) {
        setSample({ plan, stats: {} })
        return
      }
      const stats = samplePlaybackStats(videoRef.current, hlsRef.current)
      setSample({ plan, stats: videoRef.current.readyState >= 1 ? { ...stats, ...sourceRef.current.codecs } : {} })
    }
    refresh()
    const timer = window.setInterval(refresh, 1000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [visible, plan, failed, videoRef, nativeRef, hlsRef, sourceRef])

  if (!mounted) return null
  const rows = plan ? playbackInfoRows(plan, sample?.plan === plan ? sample.stats : {}, getNativeHardwareVideoCodecs()) : null
  return (
    <aside className={`playback-info${visible ? '' : ' is-leaving'}`} aria-label={t("视频信息")} aria-hidden={!visible} aria-live="off">
      <header className="playback-info__header">
        <h2><Info size={17} aria-hidden="true" />{t("视频信息")}</h2>
        <span>{failed ? t("播放中断") : playbackMethodLabel(plan)}</span>
      </header>
      {rows ? <>
        <section aria-label={t("当前播放")}>
          <h3>{t("当前播放")}</h3>
          <dl>{rows.current.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </section>
        <p className="playback-info__note">{nativeRef.current instanceof NativePlayback
          ? `Media3 · ${nativeRef.current.snapshot?.decoder || t('等待解码器')}`
          : t("WebView 未公开本次实际硬解 / 软解状态")}</p>
        <section aria-label={t("原始媒体")}>
          <h3>{t("原始媒体")}</h3>
          <dl>{rows.original.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </section>
      </> : <p className="playback-info__pending">{failed ? t("暂时无法读取媒体信息") : t("媒体就绪后显示编码与播放参数")}</p>}
    </aside>
  )
})

export default VideoInfoOverlay
