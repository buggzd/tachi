import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { transformWithEsbuild } from 'vite'

const { code } = await transformWithEsbuild(await readFile(new URL('../src/focusNotification.ts', import.meta.url), 'utf8'), 'focusNotification.ts', { target: 'es2022' })
const { focusWithNotification } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

class TestFocusEvent extends Event {
  constructor(type, options = {}) { super(type, options); this.relatedTarget = options.relatedTarget }
}

function fixture(t, nativeEvents) {
  const original = globalThis.FocusEvent
  globalThis.FocusEvent = TestFocusEvent
  t.after(() => {
    if (original === undefined) delete globalThis.FocusEvent
    else globalThis.FocusEvent = original
  })
  const previous = {}
  class Target extends EventTarget {
    isConnected = true
    ownerDocument = { activeElement: previous }
    focus(options) {
      this.options = options
      this.ownerDocument.activeElement = this
      if (nativeEvents) this.dispatchEvent(new TestFocusEvent('focusin', { bubbles: true, relatedTarget: previous }))
    }
  }
  const target = new Target()
  const events = []
  target.addEventListener('focusin', event => events.push(event))
  return { target, events, previous }
}

test('external WebView selection notifies preview when DOM focus changes silently', t => {
  const { target, events, previous } = fixture(t, false)
  focusWithNotification(target, { preventScroll: true }, true)
  assert.equal(target.ownerDocument.activeElement, target)
  assert.equal(events.length, 1)
  assert.equal(events[0].bubbles, true)
  assert.equal(events[0].relatedTarget, previous)
  assert.deepEqual(target.options, { preventScroll: true })
})

test('normal browser focus sends exactly one preview notification', t => {
  const { target, events } = fixture(t, true)
  focusWithNotification(target, { preventScroll: true }, true)
  assert.equal(events.length, 1)
})

test('reselecting the same logical target does not repeat a missing focus event', t => {
  const { target, events } = fixture(t, false)
  focusWithNotification(target, {}, true)
  focusWithNotification(target, {}, false)
  assert.equal(events.length, 1)
})

test('a removed target cannot publish a stale preview', t => {
  const { target, events } = fixture(t, false)
  target.isConnected = false
  focusWithNotification(target, {}, true)
  assert.equal(events.length, 0)
})
