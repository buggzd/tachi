import assert from 'node:assert/strict'
import test from 'node:test'
import { ScrubGesture } from '../../SharedUI/scrubGesture.mjs'
import { parseSeekCommand, parseScrubCommand, SeekPreview } from '../../SharedUI/seekCommand.mjs'

test('short strokes and vertical navigation do not enter preview', () => {
  const short = new ScrubGesture(100, 100, 100, 600)
  assert.equal(short.move(160, 105), null)
  assert.equal(short.active, false)
  const vertical = new ScrubGesture(100, 100, 100, 600)
  assert.equal(vertical.move(105, 160), null)
  assert.equal(vertical.move(250, 170), null)
})

test('drag distance is reversible, bounded and independent of move sampling', () => {
  const drag = new ScrubGesture(100, 100, 100, 600)
  assert.equal(drag.move(200, 103), 150)
  assert.equal(drag.move(220, 103), 160)
  assert.equal(drag.move(218, 103), 159)
  assert.equal(drag.move(100, 103), 100)
  assert.equal(drag.active, true)
  assert.equal(drag.move(-1000, 103), 0)
  assert.equal(drag.move(2000, 103), 600)
  const sparse = new ScrubGesture(100, 100, 100, 600)
  assert.equal(sparse.move(218, 103), 159)
})

test('only canonical bounded bridge messages are accepted', () => {
  for (const phase of ['start', 'cancel']) assert.ok(parseScrubCommand(`scrub:${phase}:abcd1234`))
  for (const phase of ['preview', 'commit']) for (const value of [0, 1, 999999]) assert.ok(parseScrubCommand(`scrub:${phase}:abcd1234:${value}`))
  for (const command of [null, 'scrub:start:1', 'scrub:start:abcd1234:1', 'scrub:commit:abcd1234', 'scrub:preview:abcd1234:-1', 'scrub:preview:abcd1234:01', 'scrub:commit:abcd1234:1.5', 'scrub:commit:abcd1234:1000000', 'scrub:commit:abcd1234:1;up']) assert.equal(parseScrubCommand(command), null)
  for (const value of ['seek:0','seek:61','seek:-61','seek:1.5','seek:01']) assert.equal(parseSeekCommand(value), null)
  assert.equal(parseSeekCommand('seek:-60'), -60)
})

test('preview never seeks; release commits once and clamps to actual duration', () => {
  const session = new SeekPreview()
  const receive = (command, now = 0) => session.receive(command, 100, 600, now)
  assert.equal(receive('scrub:commit:abcd1234:200'), null)
  assert.equal(receive('scrub:start:abcd1234'), null)
  assert.equal(receive('scrub:preview:abcd1234:200', 500), null)
  assert.equal(session.active.origin, 100)
  assert.equal(session.active.target, 200)
  assert.equal(receive('scrub:preview:abcd1234:180', 1000), null)
  assert.equal(receive('scrub:commit:abcd1234:999999', 1200), 600)
  assert.equal(receive('scrub:commit:abcd1234:999999', 1300), null)
})

test('cancel, source reset, mismatched ID and expiry discard late releases', () => {
  for (const action of ['cancel', 'reset', 'expire']) {
    const session = new SeekPreview()
    session.receive('scrub:start:abcd1234', 100, 600, 0)
    assert.equal(session.receive('scrub:commit:ffff1234:200', 100, 600, 100), null)
    if (action === 'cancel') session.receive('scrub:cancel:abcd1234', 100, 600, 100)
    if (action === 'reset') session.reset()
    assert.equal(session.receive('scrub:commit:abcd1234:200', 100, 600, action === 'expire' ? 2001 : 200), null)
  }
})
