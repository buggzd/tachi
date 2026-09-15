// One short-lived gesture update; never a queued command or an absolute position.
export function parseSeekCommand(value) {
  if (typeof value !== 'string' || !/^seek:-?(?:[1-9]|[1-5][0-9]|60)$/.test(value)) return null
  return Number(value.slice(5))
}

// A preview transaction never enters the reconnect queue. Positions are whole
// seconds, capped at 999999; the player additionally clamps to media duration.
export function parseScrubCommand(value) {
  if (typeof value !== 'string' || value.length > 32) return null
  const match = /^scrub:(start|cancel|preview|commit):([a-f0-9]{8})(?::(0|[1-9][0-9]{0,5}))?$/.exec(value)
  if (!match) return null
  const [, phase, id, position] = match
  if ((phase === 'preview' || phase === 'commit') !== (position !== undefined)) return null
  return { phase, id, position: position === undefined ? null : Number(position) }
}

export class SeekPreview {
  active = null

  reset() { this.active = null }

  receive(command, current, duration, now) {
    const message = parseScrubCommand(command)
    if (!message || !Number.isFinite(current) || !Number.isFinite(duration) || duration <= 0) return null
    if (this.active && now - this.active.updated > 2000) this.reset()
    if (message.phase === 'start') {
      this.active = { id: message.id, origin: current, target: current, updated: now }
      return null
    }
    if (this.active?.id !== message.id) return null
    if (message.phase === 'cancel') { this.reset(); return null }
    const target = Math.max(0, Math.min(duration, message.position))
    this.active = { ...this.active, target, updated: now }
    if (message.phase !== 'commit') return null
    this.reset()
    return target
  }
}
