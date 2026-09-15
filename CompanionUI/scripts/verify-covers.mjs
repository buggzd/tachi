/** Server-free rendering of the shared card layout in both themes. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../GlassesUI', import.meta.url))
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
  for (const theme of ['liquid-glass', 'simpleUI']) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${server.resolvedUrls.local[0]}tests/cards-preview.html?theme=${theme}`)
    await page.locator('.art-frame img').first().waitFor()
    for (const [name, ratio] of [['collections', 2 / 3], ['landscape', 16 / 9], ['square', 1], ['banner', 1000 / 185]]) {
      const frames = await page.locator(`[data-group="${name}"] .art-frame`).evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect()
        return box.width / box.height
      }))
      assert.equal(frames.length, 3)
      for (const actual of frames) assert.ok(Math.abs(actual - ratio) < .01, `${theme} ${name}: ${actual}`)
    }
    await page.screenshot({ path: `/tmp/tachi-cover-${theme}.png` })
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`PASS ${theme}: portrait collections, landscape, square, banner and missing metadata share group geometry`)
  }
} finally {
  await browser?.close()
  await server.close()
}
