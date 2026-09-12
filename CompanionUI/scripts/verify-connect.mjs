/** Full React/native-bridge regression; no account, device, or real server required. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const server = await createServer({ root, server: { host:'127.0.0.1', port:0 }, logLevel:'error' })
let browser
try {
  await server.listen()
  const url = server.resolvedUrls.local[0]
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless:true })
  for (const theme of ['liquid-glass','simpleUI']) {
    for (const loggedIn of [false,true]) {
      const page = await browser.newPage({viewport:{width:400,height:820}})
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.addInitScript(({theme,loggedIn}) => {
        const account = {id:'fixture',serverUrl:'https://media.example.invalid',serverName:'Fixture',username:'Fixture',persisted:true}
        window.__bridgeCalls = []
        const state={state:loggedIn?'session_ready':'login_required',sessionAvailable:loggedIn,activeSessionId:loggedIn?'fixture':'',
          serverUrl:loggedIn?account.serverUrl:'',serverName:'Fixture',username:'Fixture',accounts:loggedIn?[account]:[],servers:[],
          discoveryMessage:'未发现局域网服务器，请填写服务器地址。',uiTheme:theme,language:'zh-CN',sessionSaved:true}
        window.__fixtureState=state
        window.JellyfinNative={getState:()=>JSON.stringify(state),ready:()=>{},screenChanged:()=>{},scan:()=>{},
          selectServer:(host,name)=>window.__bridgeCalls.push({host,name}),getCompanionBackground:()=>''}
      },{theme,loggedIn})
      await page.goto(url)
      if (loggedIn) {
        await page.waitForFunction(()=>typeof window.LumaNative?.openScreen==='function')
        await page.evaluate(()=>window.LumaNative.openScreen('accounts'))
        await page.getByRole('button',{name:'添加服务器',exact:true}).click()
      }
      await page.getByRole('button',{name:/手动填写地址/}).waitFor({timeout:5000})
      await page.getByRole('button',{name:/手动填写地址/}).click()
      const dialog = page.getByRole('dialog',{name:'手动添加服务器'})
      await dialog.waitFor()
      const input = dialog.locator('input')
      await input.fill('https://media.example.invalid/jellyfin')
      // Native discovery/clock publications must not dismiss the sheet or reset input.
      await page.evaluate(()=>window.LumaNative.receiveState({...window.__fixtureState,discoveryScanning:true}))
      assert.equal(await input.inputValue(),'https://media.example.invalid/jellyfin')
      await page.setViewportSize({width:400,height:460})
      await dialog.getByRole('button',{name:'继续登录'}).click()
      await page.waitForFunction(()=>window.__bridgeCalls.length===1)
      assert.equal((await page.evaluate(()=>window.__bridgeCalls))[0].host,'https://media.example.invalid/jellyfin')
      await page.evaluate(()=>window.LumaNative.openScreen('connect'))
      await page.getByRole('button',{name:/手动填写地址/}).click()
      await page.getByRole('button',{name:'关闭添加服务器'}).click()
      await page.getByRole('dialog',{name:'手动添加服务器'}).waitFor({state:'hidden'})
      assert.equal(await page.locator('.screen-stack').evaluate(node=>node.inert),false)
      assert.deepEqual(errors,[])
      await page.close()
      console.log(`PASS ${theme}: ${loggedIn?'add with saved account':'new install'}, manual sheet, native update, compact viewport, submit, close`)
    }
  }
} finally {
  await browser?.close()
  await server.close()
}
