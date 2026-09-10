import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useRealtimeSbs, DepthPreview } from '../src/useRealtimeSbs'
import { discoverRuntime } from '../src/runtime'
const harness = { starts: [] as string[], stops: [] as string[], frames: [] as { token: string; sequence: number; rect: number[] }[], hold: false, error: false, token: '' }
Object.assign(window, { sbsHarness: harness })
window.RayNeoGlasses = {
  getBootstrapState: () => JSON.stringify({ source: 'android', displayMode: 'stereo_screen', displayModeApplied: true }),
  getHardwareVideoCodecs: () => '[]', ready: () => {}, postMessage: () => {},
  realtimeSbsAvailable: () => true,
  startRealtimeSbs: token => { harness.token = token; harness.starts.push(token); setTimeout(() => window.dispatchEvent(new CustomEvent('tachi-depth', { detail: { token, status: 'ready' } })), 20) },
  stopRealtimeSbs: token => { harness.stops.push(token) },
  submitRealtimeFrame: payload => {
    const data = JSON.parse(payload)
    if (data.rgba.length !== 218476) throw new Error('Invalid frame size')
    harness.frames.push({ token: data.token, sequence: data.sequence, rect: data.rect })
    if (!harness.hold) setTimeout(() => window.dispatchEvent(new CustomEvent('tachi-depth', { detail: { token: data.token, sequence: data.sequence,
      status: harness.error ? 'error' : 'frame', nativeMs: 25, depth: btoa('x'.repeat(266 * 154)) } })), 35)
    return true
  },
}
function Test() {
  const video = useRef<HTMLVideoElement>(null)
  const [subtitles, setSubtitles] = useState(false)
  const sbs = useRealtimeSbs(video, 'fixture', true, subtitles, true)
  useEffect(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
    let n = 0
    const interval = setInterval(() => { const ctx = canvas.getContext('2d')!; ctx.fillStyle = n++ % 2 ? '#204080' : '#c08030'; ctx.fillRect(0, 0, 640, 360) }, 33)
    const stream = canvas.captureStream(30)
    video.current!.srcObject = stream; void video.current!.play()
    return () => { clearInterval(interval); stream.getTracks().forEach(track => track.stop()) }
  }, [])
  return <><video ref={video} muted style={{ width: 640, height: 360 }} /><button id="toggle" onClick={sbs.toggle}>toggle</button>
    <button id="subtitles" onClick={() => setSubtitles(v => !v)}>subtitles</button><output>{sbs.status}</output><DepthPreview value={sbs.depth} /></>
}
await discoverRuntime()
const root = createRoot(document.getElementById('root')!)
Object.assign(window, { unmountSbs: () => root.unmount() })
root.render(<Test />)
