// Real player controls with a mocked native transport; no media/server needed.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { PlayerPage } from '../src/App'
import { discoverRuntime } from '../src/runtime'
import { featured } from '../src/data'
import type { PlaybackPlan } from '../src/jellyfin'
import { applyUiTheme } from '../../SharedUI/theme.mjs'
import { applyLanguage } from '../../SharedUI/i18n.mjs'
import '../src/styles.css'
import '../../SharedUI/simpleUI.css'
import '../src/simpleUI.css'
await discoverRuntime()
const simple = new URLSearchParams(location.search).get('theme') === 'simpleUI'
applyUiTheme(simple ? 'simpleUI' : 'liquid-glass')
applyLanguage('zh-CN')
const prepare = async (): Promise<PlaybackPlan> => ({
  itemId: 'fixture', mediaSourceId: 'fixture', url: 'https://media.example.invalid/Videos/fixture/stream.mp4',
  playSessionId: 'fixture', playMethod: 'DirectPlay', transcoding: false, subtitleBurnedIn: false,
  startPositionTicks: 100e7, durationTicks: 600e7, canSeek: true, container: 'mp4', videoCodec: 'h264',
  audioCodec: 'aac', width: 1920, height: 1080, mediaInfo: {}, audioTracks: [], subtitleTracks: [], subtitleStreamIndex: -1,
})
const noop = () => {}
const report = async () => {}
createRoot(document.getElementById('root')!).render(<PlayerPage simpleUi={simple} subtitleSize="normal"
  item={{ ...featured, id: 'fixture', title: '播放交互预览', original: '', subtitle: '', runtimeTicks: 600e7 }}
  startPositionTicks={100e7} infoVisible={false} onToggleInfo={noop} preparePlayback={prepare}
  reportPlaybackStarted={report} reportPlaybackProgress={report} reportPlaybackStopped={report}
  onPlayItem={noop} onBack={noop} />)
