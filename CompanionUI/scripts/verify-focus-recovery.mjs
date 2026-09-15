import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
const server = await createServer({ root: fileURLToPath(new URL('../../GlassesUI', import.meta.url)), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${server.resolvedUrls.local[0]}tests/focus-recovery.html`)
  await page.waitForFunction(() => !!window.focusFixture)
  assert.equal(await page.evaluate(() => window.focusFixture.initialSpatialFocus().id), 'back')
  assert.equal(await page.evaluate(() => window.focusFixture.focusSpatialElement(document.querySelector('#play'))), false)
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    await page.evaluate(() => {
      document.activeElement.blur()
      document.querySelectorAll('[data-spatial-focus]').forEach(node => node.removeAttribute('data-spatial-focus'))
      document.querySelector('#play').setAttribute('data-spatial-focus', 'true')
    })
    await page.keyboard.press(key)
    assert.equal(await page.evaluate(() => document.activeElement.id), 'back', `${key} recovers from disabled autofocus`)
    assert.equal(await page.locator('[data-spatial-focus="true"]').count(), 1)
  }
  for (const [key, id] of [['ArrowDown','favorite'], ['ArrowRight','watched'], ['ArrowLeft','favorite'], ['ArrowDown','similar'], ['ArrowUp','favorite'], ['ArrowUp','back']]) {
    await page.keyboard.press(key)
    assert.equal(await page.evaluate(() => document.activeElement.id), id)
  }
  await page.keyboard.press('Enter')
  assert.equal(await page.evaluate(() => window.backCount), 1)
  await page.evaluate(() => {
    const button = document.querySelector('#play')
    button.disabled = false
    window.focusFixture.focusSpatialElement(button)
    button.disabled = true
  })
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'back', 'async loss of playability recovers')
  await page.evaluate(() => { document.querySelector('#play').disabled = false })
  assert.equal(await page.evaluate(() => window.focusFixture.initialSpatialFocus().id), 'play', 'valid autoplay target retains priority')
  assert.deepEqual(errors, [])
  console.log('PASS disabled/hidden/inert autofocus, four-direction recovery, navigation, Back activation and asynchronous disable')
} finally {
  await browser?.close()
  await server.close()
}
