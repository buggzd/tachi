// A horizontal stroke uses a stable distance scale, independent of finger speed.
export class ScrubGesture {
  constructor(x, y, position, duration) {
    this.x = x
    this.y = y
    this.position = position
    this.duration = Math.min(999999, duration)
    this.active = false
    this.vertical = false
    this.target = position
  }

  move(x, y) {
    const dx = x - this.x, dy = y - this.y
    if (!this.active && Math.abs(dy) > 24 && Math.abs(dy) > Math.abs(dx)) this.vertical = true
    if (this.vertical) return null
    // Short swipes retain the existing ten-second step. Crossing 72 CSS px
    // consumes the stroke, even if it returns to its starting position.
    if (!this.active && Math.abs(dx) >= 72 && Math.abs(dx) > Math.abs(dy) * 1.5) this.active = true
    if (!this.active) return null
    this.target = Math.max(0, Math.min(this.duration, Math.round(this.position + dx * .5)))
    return this.target
  }
}
