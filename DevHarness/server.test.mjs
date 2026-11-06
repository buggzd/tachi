import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import { createHarnessServer, normalizeServerUrl } from './server.mjs'

async function listen(context, server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  return `http://127.0.0.1:${server.address().port}`
}

async function authenticationFixture(context) {
  const requests = []
  let authorized = false
  const jellyfin = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ method: request.method, path: request.url, headers: request.headers, body })
    const header = request.headers.authorization || ''
    if (!/^MediaBrowser Client="tachi", Device="Browser Dual UI", DeviceId="[^"]+", Version="[^"]+"$/.test(header)
        || Object.keys(request.headers).some((name) => name.startsWith('x-emby-'))) {
      response.writeHead(401)
      response.end()
      return
    }
    let payload
    switch (`${request.method} ${request.url}`) {
      case 'GET /jellyfin/System/Info/Public':
        payload = { ServerName: 'Test server', Version: '12.0.0', Id: 'test-server' }
        break
      case 'POST /jellyfin/Users/AuthenticateByName':
        if (body !== JSON.stringify({ Username: 'tester', Pw: 'fixture-password' })) {
          response.writeHead(401)
          response.end()
          return
        }
        payload = { AccessToken: 'fixture-token', User: { Id: 'test-user', Name: 'tester' } }
        break
      case 'GET /jellyfin/QuickConnect/Enabled':
        payload = true
        break
      case 'POST /jellyfin/QuickConnect/Initiate':
        payload = { Secret: 'fixture/secret+?', Code: '123456', Authenticated: false }
        break
      case 'GET /jellyfin/QuickConnect/Connect?secret=fixture%2Fsecret%2B%3F':
        payload = { Authenticated: authorized }
        break
      case 'POST /jellyfin/Users/AuthenticateWithQuickConnect':
        if (!authorized || body !== JSON.stringify({ Secret: 'fixture/secret+?' })) {
          response.writeHead(401)
          response.end()
          return
        }
        payload = { AccessToken: 'fixture-token', User: { Id: 'test-user', Name: 'tester' } }
        break
      default:
        response.writeHead(404)
        response.end()
        return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(payload))
  })
  const serverUrl = `${await listen(context, jellyfin)}/jellyfin`
  const harnessUrl = await listen(context, createHarnessServer())
  return {
    requests,
    serverUrl,
    authorize() { authorized = true },
    async post(path, body) {
      const response = await fetch(`${harnessUrl}/api/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://127.0.0.1:4177',
        },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    },
  }
}

test('password login works with standard authorization and a Jellyfin base path', async (context) => {
  const fixture = await authenticationFixture(context)
  const result = await fixture.post('login', {
    serverUrl: fixture.serverUrl,
    username: 'tester',
    password: 'fixture-password',
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.session.serverUrl, fixture.serverUrl)
  assert.equal(result.body.session.serverVersion, '12.0.0')
  assert.equal(result.body.session.accessToken, 'fixture-token')
  assert.equal(result.body.session.userId, 'test-user')
  assert.equal(JSON.stringify(result.body).includes('fixture-password'), false)
  assert.deepEqual(fixture.requests.map(({ method, path }) => `${method} ${path}`), [
    'GET /jellyfin/System/Info/Public',
    'POST /jellyfin/Users/AuthenticateByName',
  ])
})

test('Quick Connect uses standard authorization throughout polling and token exchange', async (context) => {
  const fixture = await authenticationFixture(context)
  const started = await fixture.post('quick-connect/start', { serverUrl: fixture.serverUrl })
  assert.equal(started.status, 200)
  assert.equal(started.body.code, '123456')
  assert.equal(JSON.stringify(started.body).includes('fixture/secret'), false)
  const operation = { operationId: started.body.operationId }
  const pending = await fixture.post('quick-connect/poll', operation)
  assert.equal(pending.status, 200)
  assert.deepEqual(pending.body, { pending: true })
  fixture.authorize()
  const completed = await fixture.post('quick-connect/poll', operation)
  assert.equal(completed.status, 200)
  assert.equal(completed.body.pending, false)
  assert.equal(completed.body.session.accessToken, 'fixture-token')
  assert.equal(completed.body.session.serverUrl, fixture.serverUrl)
  assert.equal(JSON.stringify(completed.body).includes('fixture/secret'), false)
  const expired = await fixture.post('quick-connect/poll', operation)
  assert.equal(expired.body.code, 'quick_connect_expired')
  assert.deepEqual(fixture.requests.map(({ method, path }) => `${method} ${path}`), [
    'GET /jellyfin/QuickConnect/Enabled',
    'GET /jellyfin/System/Info/Public',
    'POST /jellyfin/QuickConnect/Initiate',
    'GET /jellyfin/QuickConnect/Connect?secret=fixture%2Fsecret%2B%3F',
    'GET /jellyfin/QuickConnect/Connect?secret=fixture%2Fsecret%2B%3F',
    'POST /jellyfin/Users/AuthenticateWithQuickConnect',
  ])
})

test('normalizeServerUrl accepts Jellyfin HTTP addresses without queries', () => {
  assert.equal(normalizeServerUrl('jellyfin.local:8096/'), 'http://jellyfin.local:8096')
  assert.equal(normalizeServerUrl('https://media.example.test/jellyfin/'), 'https://media.example.test/jellyfin')
})

test('normalizeServerUrl rejects unsafe or ambiguous inputs', () => {
  assert.throws(() => normalizeServerUrl('ftp://media.example.test'), /HTTP/)
  assert.throws(() => normalizeServerUrl('https://user:secret@media.example.test'), /凭据/)
  assert.throws(() => normalizeServerUrl('https://media.example.test/?token=value'), /查询参数/)
})

test('development API rejects requests outside the harness origin', async (context) => {
  const server = createHarnessServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())

  const address = server.address()
  assert.equal(typeof address, 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const health = await fetch(`${baseUrl}/health`)
  assert.equal(health.status, 200)

  const rejected = await fetch(`${baseUrl}/api/development-server`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(rejected.status, 403)
  assert.equal((await rejected.json()).code, 'invalid_origin')
})

test('development API validates bounded JSON before any network request', async (context) => {
  const server = createHarnessServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())

  const address = server.address()
  assert.equal(typeof address, 'object')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:4177',
    },
    body: JSON.stringify({ serverUrl: 'file:///etc/passwd', username: 'tester', password: '' }),
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'invalid_server')
})
