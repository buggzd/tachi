import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
const server = await createServer({ root: fileURLToPath(new URL('../../GlassesUI', import.meta.url)), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
  for (const scenario of ['playable', 'manual', 'empty']) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      localStorage.setItem('lucent.remote-tutorial.v1', 'skipped')
      window.RayNeoGlasses = {
        getBootstrapState: () => JSON.stringify({ source: 'android', language: 'zh-CN', catalogGeneration: 1,
          session: { serverUrl: 'https://fixture.invalid', userId: 'user', accessToken: 'fixture', deviceId: 'fixture' } }),
        ready() {}, postMessage() {}, getHardwareVideoCodecs: () => '[]',
      }
    })
    const series = { Id: 'series', Name: 'Delayed series', Type: 'Series', PrimaryImageAspectRatio: 2 / 3 }
    let release
    const pending = new Promise(resolve => { release = resolve })
    await page.route('https://fixture.invalid/**', async route => {
      const path = new URL(route.request().url()).pathname
      let data = { Items: [] }
      if (path === '/Users/user/Items/series') { await pending; data = series }
      else if (path === '/Shows/series/Seasons') data = { Items: [{ Id: 'season', Type: 'Season' }] }
      else if (path === '/Shows/series/Episodes') data = { Items: scenario === 'empty' ? [] : [{ Id: 'episode', Name: 'First episode', Type: 'Episode', IndexNumber: 1, SeriesId: 'series', SeasonId: 'season' }] }
      else if (path === '/Users/user/Items/Latest') data = [series]
      else if (path === '/Users/user/Items') data = { Items: [series] }
      await route.fulfill({ json: data })
    })
    await page.goto(server.resolvedUrls.local[0])
    await page.locator('.hero-section .focus-button--primary').click()
    await page.locator('.detail-play-button').waitFor()
    await page.waitForTimeout(450)
    assert.equal(await page.locator('.detail-play-button').isDisabled(), true)
    if (scenario === 'manual') {
      await page.keyboard.press('ArrowDown')
      assert.equal(await page.evaluate(() => document.activeElement.closest('.detail-page') !== null), true)
    }
    const manualFocus = await page.evaluate(() => document.activeElement.outerHTML)
    release()
    if (scenario === 'empty') {
      await page.getByText('暂无可播放内容', { exact: true }).waitFor()
      await page.waitForFunction(() => document.activeElement.matches('.detail-page [data-focusable="true"]:not([disabled])'))
      assert.equal(await page.locator('.detail-play-button').isDisabled(), true)
    } else {
      await page.waitForFunction(() => !document.querySelector('.detail-play-button').disabled)
      await page.waitForTimeout(250)
      if (scenario === 'manual') assert.equal(await page.evaluate(() => document.activeElement.outerHTML), manualFocus)
      else assert.equal(await page.locator('.detail-play-button').evaluate(node => node === document.activeElement), true)
    }
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`PASS delayed detail initial focus: ${scenario}`)
  }
} finally {
  await browser?.close()
  await server.close()
}
