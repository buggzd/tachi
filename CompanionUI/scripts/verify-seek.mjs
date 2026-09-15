/** Real React controls and native transport fixtures; never contacts a server. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../..', import.meta.url))
const servers = []
let browser
const errors = []
try {
  for (const folder of ['CompanionUI', 'GlassesUI']) {
    const server = await createServer({ root: `${root}/${folder}`, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
    await server.listen(); servers.push(server)
  }
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
  for (const theme of ['liquid-glass', 'simpleUI']) {
    const phone = await browser.newPage({ viewport: { width: 400, height: 820 }, hasTouch: true })
    phone.on('pageerror', e => errors.push(e.message))
    await phone.addInitScript(theme => {
      window.__commands = []
      window.__state = { state: 'session_ready', sessionAvailable: true, mediaReady: true, glassesPresentationReady: true,
        glassesConnected: true, glassesRuntimeState: 'ready', uiTheme: theme, language: 'zh-CN',
        playback: { state: 'paused', itemId: 'fixture', title: '播放交互预览', positionTicks: 100e7, durationTicks: 600e7, seekEnabled: true } }
      window.JellyfinNative = { getState: () => JSON.stringify(window.__state), ready() {}, screenChanged() {},
        remoteCommand: (command, haptic) => window.__commands.push({ command, haptic }) }
    }, theme)
    await phone.goto(servers[0].resolvedUrls.local[0])
    await phone.waitForFunction(() => !!window.LumaNative?.openScreen)
    await phone.evaluate(() => { window.LumaNative.openScreen('home'); window.__state.touchpadReady = true; window.LumaNative.receiveState(window.__state) })
    await phone.locator('.touchpad-seek-guide').waitFor()
    const commands = () => phone.evaluate(() => window.__commands.map(x => x.command))
    const clear = () => phone.evaluate(() => { window.__commands = [] })
    await phone.mouse.move(140, 460); await phone.mouse.down(); await phone.mouse.move(195, 460); await phone.mouse.up()
    assert.deepEqual(await commands(), ['right'])
    await clear()
    await phone.mouse.move(140, 460); await phone.mouse.down(); await phone.mouse.move(250, 460, { steps: 8 })
    assert.ok((await commands()).some(x => x.startsWith('scrub:start:')))
    assert.ok(!(await commands()).some(x => x.includes(':commit:') || x.startsWith('seek:')))
    await phone.mouse.move(210, 460, { steps: 4 }); await phone.mouse.up()
    assert.equal((await commands()).filter(x => x.includes(':commit:')).length, 1)
    assert.ok((await commands()).at(-1).endsWith(':135'))
    await clear()
    await phone.mouse.move(140, 460); await phone.mouse.down(); await phone.mouse.move(250, 460)
    await phone.evaluate(() => window.dispatchEvent(new Event('blur')))
    await phone.mouse.up()
    assert.ok(!(await commands()).some(x => x.includes(':commit:')))
    assert.ok((await commands()).some(x => x.includes(':cancel:')))
    await clear()
    const slider = phone.locator('.touchpad-playback__slider')
    const box = await slider.boundingBox()
    await phone.mouse.move(box.x + box.width * .25, box.y + box.height / 2); await phone.mouse.down()
    await phone.mouse.move(box.x + box.width * .8, box.y + box.height / 2, { steps: 8 })
    assert.ok(!(await commands()).some(x => x.includes(':commit:')))
    await phone.mouse.up()
    assert.equal((await commands()).filter(x => x.includes(':commit:')).length, 1)
    assert.ok(Number((await commands()).find(x => x.includes(':commit:')).split(':').at(-1)) > 450)
    await clear()
    const touch = await phone.context().newCDPSession(phone)
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 140, y: 460, id: 1 }] })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 250, y: 460, id: 1 }] })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 250, y: 460, id: 1 }, { x: 280, y: 500, id: 2 }] })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    assert.ok((await commands()).some(x => x.includes(':cancel:')))
    assert.ok(!(await commands()).some(x => x.includes(':commit:')))
    await clear()
    await phone.mouse.move(140, 460); await phone.mouse.down(); await phone.mouse.move(250, 460)
    await phone.evaluate(() => window.LumaNative.receiveState({ ...window.__state, playback: { ...window.__state.playback, itemId: 'next' } }))
    await phone.waitForFunction(() => window.__commands.some(x => x.command.includes(':cancel:')))
    await phone.mouse.up()
    assert.ok(!(await commands()).some(x => x.includes(':commit:')))
    await phone.screenshot({ path: `/tmp/tachi-phone-${theme}.png` })
    await phone.evaluate(() => window.LumaNative.receiveState({ ...window.__state, playback: { ...window.__state.playback, seekEnabled: false } }))
    await phone.waitForFunction(() => document.querySelector('.touchpad-playback__slider').disabled)
    assert.equal(await slider.isDisabled(), true)
    await phone.close()

    const glasses = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    glasses.on('pageerror', e => errors.push(e.message))
    await glasses.addInitScript(() => {
      window.__commands = []; window.__states = []
      window.RayNeoGlasses = { nativePlaybackAvailable: () => true, ready() {}, getHardwareVideoCodecs: () => '[]',
        getBootstrapState: () => JSON.stringify({ source: 'android', catalogGeneration: 0, language: 'zh-CN' }),
        postMessage: value => window.__states.push(JSON.parse(value)),
        nativePlaybackCommand: value => window.__commands.push(JSON.parse(value)) }
    })
    await glasses.goto(`${servers[1].resolvedUrls.local[0]}tests/player-preview.html?theme=${theme}`)
    await glasses.waitForFunction(() => window.__commands.some(x => x.operation === 'open'))
    await glasses.evaluate(() => {
      const open = window.__commands.findLast(x => x.operation === 'open')
      window.dispatchEvent(new CustomEvent('tachi-native-playback', { detail: { token: open.token, generation: open.generation,
        status: 'paused', position: 100, duration: 600, firstFrame: true, seekable: true } }))
    })
    await glasses.waitForFunction(() => window.__states.some(x => x.seekEnabled === true))
    assert.equal(await glasses.locator('video').count(), 0)
    assert.equal(await glasses.locator('[data-spatial-focus="true"]').count(), 1)
    assert.equal(await glasses.locator('.player-progress__bar').getAttribute('data-spatial-focus'), 'true')
    const resting = await glasses.locator('.player-play').evaluate(x => getComputedStyle(x).backgroundColor)
    const send = command => glasses.evaluate(command => window.dispatchEvent(new CustomEvent('rayneo-remote-command', { detail: command })), command)
    const seekCount = () => glasses.evaluate(() => window.__commands.filter(x => x.operation === 'seek').length)
    const before = await seekCount()
    await send('scrub:start:abcd1234'); await send('scrub:preview:abcd1234:160')
    await glasses.locator('.seek-preview').waitFor()
    assert.equal(await seekCount(), before)
    await glasses.screenshot({ path: `/tmp/tachi-player-${theme}.png` })
    await send('scrub:preview:abcd1234:145'); await send('scrub:commit:abcd1234:145'); await send('scrub:commit:abcd1234:145')
    assert.equal(await seekCount(), before + 1)
    assert.equal(await glasses.evaluate(() => window.__commands.findLast(x => x.operation === 'seek').position), 145)
    assert.equal(await glasses.evaluate(() => window.__commands.filter(x => x.operation === 'play').length), 0)
    await send('scrub:start:abcd1235'); await send('scrub:preview:abcd1235:200'); await send('scrub:cancel:abcd1235'); await send('scrub:commit:abcd1235:200')
    assert.equal(await seekCount(), before + 1)
    await send('scrub:start:abcd1236'); await send('scrub:preview:abcd1236:200')
    await glasses.locator('.seek-preview').waitFor({ state: 'hidden', timeout: 4000 })
    await send('scrub:commit:abcd1236:200')
    assert.equal(await seekCount(), before + 1)
    await glasses.evaluate(() => window.dispatchEvent(new CustomEvent('lucent-player-key', { detail: 'down' })))
    assert.equal(await glasses.locator('[data-spatial-focus="true"]').count(), 1)
    assert.equal(await glasses.locator('.player-play').getAttribute('data-spatial-focus'), 'true')
    await glasses.waitForFunction(resting => getComputedStyle(document.querySelector('.player-play')).backgroundColor !== resting, resting)
    assert.notEqual(await glasses.locator('.player-play').evaluate(x => getComputedStyle(x).backgroundColor), resting)
    await send('scrub:start:abcd1237'); await send('scrub:commit:abcd1237:200')
    assert.equal(await seekCount(), before + 1, 'focus loss revokes seek permission')
    await glasses.evaluate(() => window.dispatchEvent(new CustomEvent('lucent-player-key', { detail: 'up' })))
    await glasses.evaluate(() => {
      const open = window.__commands.findLast(x => x.operation === 'open')
      window.dispatchEvent(new CustomEvent('tachi-native-playback', { detail: { token: open.token, generation: open.generation,
        status: 'playing', position: 145, duration: 600, firstFrame: true, seekable: true, seekId: 1 } }))
    })
    const transportCount = await glasses.evaluate(() => window.__commands.filter(x => ['play', 'pause'].includes(x.operation)).length)
    await send('scrub:start:abcd1238'); await send('scrub:preview:abcd1238:180'); await send('scrub:commit:abcd1238:180')
    assert.equal(await seekCount(), before + 2)
    assert.equal(await glasses.evaluate(() => window.__commands.filter(x => ['play', 'pause'].includes(x.operation)).length), transportCount)
    assert.deepEqual(errors, [])
    await glasses.close()
    console.log(`PASS ${theme}: short swipe, drag/reversal, cancellation, full slider, focus, preview/commit/expiry, paused native player`)
  }
} finally {
  await browser?.close()
  for (const server of servers) await server.close()
}
