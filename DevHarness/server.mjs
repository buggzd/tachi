import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const harnessDirectory = dirname(fileURLToPath(import.meta.url))
const projectDirectory = resolve(harnessDirectory, '..')
const configuredDevelopmentConfigPath = String(
  process.env.RAYNEO_JELLYFIN_DEV_CONFIG || '',
).trim()
const developmentConfigPath = configuredDevelopmentConfigPath
  ? resolve(configuredDevelopmentConfigPath)
  : resolve(projectDirectory, '.jellyfin-dev.json')
const versionPropertiesPath = resolve(projectDirectory, 'version.properties')
const host = '127.0.0.1'
const port = 4_177
const maximumRequestLength = 8_192
const maximumResponseLength = 1_048_576
const requestTimeoutMs = 15_000
const quickConnectLifetimeMs = 300_000
const deviceId = 'lucent-rayneo-dual-ui-development'
const applicationVersion = readFileSync(versionPropertiesPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.split('=', 2))
  .find(([key]) => key === 'versionName')?.[1]?.trim() || 'development'
const allowedOrigins = new Set([
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
])
const quickConnectOperations = new Map()

const staticFiles = new Map([
  ['/seekCommand.mjs', ['../SharedUI/seekCommand.mjs', 'text/javascript; charset=utf-8']],
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/harness.js', ['harness.js', 'text/javascript; charset=utf-8']],
])

class UserFailure extends Error {
  constructor(message, { code = 'request_failed', status = 400, server = null } = {}) {
    super(message)
    this.code = code
    this.status = status
    this.server = server
  }
}

class HttpFailure extends Error {
  constructor(status) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

function text(value, maximumLength = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'string' ? value.trim().slice(0, maximumLength) : ''
}

function headerSafe(value) {
  return text(value, 512).replace(/[\\"\r\n]/g, '')
}

export function normalizeServerUrl(value) {
  let candidate = text(value, 2_048)
  if (!candidate) throw new UserFailure('请输入 Jellyfin 服务器地址。', { code: 'invalid_server' })
  if (!/^https?:\/\//i.test(candidate)) {
    if (candidate.includes('://')) {
      throw new UserFailure('服务器地址只支持 HTTP 或 HTTPS。', { code: 'invalid_server' })
    }
    candidate = `http://${candidate}`
  }

  let url
  try {
    url = new URL(candidate)
  } catch {
    throw new UserFailure('服务器地址无效；IPv6 带端口时请使用方括号。', { code: 'invalid_server' })
  }
  if (!['http:', 'https:'].includes(url.protocol)
      || !url.hostname
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.host.includes('%')) {
    throw new UserFailure('服务器地址无效；请勿包含凭据、查询参数或片段。', { code: 'invalid_server' })
  }

  const pathname = url.pathname.replace(/\/+$/, '')
  const normalized = `${url.protocol}//${url.host}${pathname}`
  if (normalized.length > 2_048) {
    throw new UserFailure('Jellyfin 服务器地址过长。', { code: 'invalid_server' })
  }
  return normalized
}

function authorizationHeader() {
  return [
    'MediaBrowser Client="tachi"',
    'Device="Browser Dual UI"',
    `DeviceId="${headerSafe(deviceId)}"`,
    `Version="${headerSafe(applicationVersion)}"`,
  ].join(', ')
}

async function requestText(method, endpoint, body = undefined) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
  const authorization = authorizationHeader()
  try {
    const response = await fetch(endpoint, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: authorization,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      },
    })
    const advertisedLength = Number(response.headers.get('content-length') || 0)
    if (advertisedLength > maximumResponseLength) {
      throw new UserFailure('Jellyfin 响应过大，已停止处理。', { code: 'response_too_large' })
    }
    let result = ''
    if (response.body) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let receivedLength = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        receivedLength += value.byteLength
        if (receivedLength > maximumResponseLength) {
          await reader.cancel()
          throw new UserFailure('Jellyfin 响应过大，已停止处理。', { code: 'response_too_large' })
        }
        result += decoder.decode(value, { stream: true })
      }
      result += decoder.decode()
    }
    if (!response.ok) throw new HttpFailure(response.status)
    return result
  } catch (error) {
    if (error instanceof UserFailure || error instanceof HttpFailure) throw error
    if (error?.name === 'AbortError') {
      throw new UserFailure('连接 Jellyfin 超时，请检查服务器地址和网络。', { code: 'timeout' })
    }
    throw new UserFailure('无法连接 Jellyfin，请检查地址、端口、网络和 HTTPS 证书。', {
      code: 'network',
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function requestJson(method, endpoint, body = undefined) {
  const response = await requestText(method, endpoint, body)
  if (!response.trim()) return {}
  try {
    const parsed = JSON.parse(response)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new UserFailure('Jellyfin 返回了无法解析的响应。', { code: 'response' })
  }
}

function friendlyFailure(error, server = null) {
  if (error instanceof UserFailure) {
    if (!error.server) error.server = server
    return error
  }
  if (error instanceof HttpFailure) {
    if (error.status === 401 || error.status === 403) {
      return new UserFailure('用户名或密码不正确，请检查后重试。', {
        code: 'unauthorized',
        status: 401,
        server,
      })
    }
    if (error.status === 404) {
      return new UserFailure('服务器不支持此登录方式，请检查地址。', {
        code: 'not_supported',
        status: 400,
        server,
      })
    }
    return new UserFailure(`Jellyfin 请求失败（HTTP ${error.status}），请检查服务器。`, {
      code: 'http',
      status: 502,
      server,
    })
  }
  return new UserFailure('Jellyfin 联调请求失败。', { code: 'unknown', status: 500, server })
}

function serverSummary(serverUrl, publicInfo = {}) {
  const fallbackName = new URL(serverUrl).host
  return {
    serverUrl,
    serverName: text(publicInfo.ServerName, 512) || fallbackName,
    serverVersion: text(publicInfo.Version, 128),
    serverId: text(publicInfo.Id, 512),
  }
}

function createSession(serverUrl, publicInfo, authentication) {
  const user = authentication.User && typeof authentication.User === 'object'
    ? authentication.User
    : {}
  const session = {
    serverUrl,
    serverName: text(publicInfo.ServerName, 512),
    serverVersion: text(publicInfo.Version, 128),
    serverId: text(authentication.ServerId, 512) || text(publicInfo.Id, 512),
    accessToken: text(authentication.AccessToken, 4_096),
    userId: text(user.Id, 512),
    userName: text(user.Name, 512),
    deviceId,
  }
  if (!session.accessToken || !session.userId) {
    throw new UserFailure('服务器没有返回有效的 Jellyfin 会话。', { code: 'invalid_session' })
  }
  return session
}

async function authenticate(serverValue, userValue, passwordValue) {
  const serverUrl = normalizeServerUrl(serverValue)
  const username = text(userValue, 512)
  const password = typeof passwordValue === 'string' ? passwordValue.slice(0, 4_096) : ''
  const initialServer = serverSummary(serverUrl)
  if (!username) {
    throw new UserFailure('请输入 Jellyfin 用户名。', {
      code: 'invalid_username',
      server: initialServer,
    })
  }

  try {
    const publicInfo = await requestJson('GET', `${serverUrl}/System/Info/Public`)
    const server = serverSummary(serverUrl, publicInfo)
    const authentication = await requestJson('POST', `${serverUrl}/Users/AuthenticateByName`, {
      Username: username,
      Pw: password,
    })
    return {
      server,
      session: createSession(serverUrl, publicInfo, authentication),
    }
  } catch (error) {
    throw friendlyFailure(error, initialServer)
  }
}

async function readDevelopmentConfig() {
  let source
  try {
    source = await readFile(developmentConfigPath, 'utf8')
  } catch {
    throw new UserFailure('未找到 .jellyfin-dev.json。', {
      code: 'missing_config',
      status: 404,
    })
  }
  if (source.length > 65_536) {
    throw new UserFailure('.jellyfin-dev.json 过大，已拒绝读取。', { code: 'invalid_config' })
  }
  try {
    const parsed = JSON.parse(source)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return {
      serverUrl: normalizeServerUrl(parsed.serverUrl),
      username: text(parsed.username, 512),
      password: typeof parsed.password === 'string' ? parsed.password.slice(0, 4_096) : '',
    }
  } catch (error) {
    if (error instanceof UserFailure) throw error
    throw new UserFailure('.jellyfin-dev.json 格式无效。', { code: 'invalid_config' })
  }
}

async function developmentServer() {
  const config = await readDevelopmentConfig()
  return { server: serverSummary(config.serverUrl) }
}

async function developmentSession() {
  const config = await readDevelopmentConfig()
  return authenticate(config.serverUrl, config.username, config.password)
}

function pruneQuickConnectOperations() {
  const now = Date.now()
  for (const [id, operation] of quickConnectOperations) {
    if (operation.expiresAt <= now) quickConnectOperations.delete(id)
  }
}

async function startQuickConnect(serverValue) {
  pruneQuickConnectOperations()
  const serverUrl = normalizeServerUrl(serverValue)
  const initialServer = serverSummary(serverUrl)
  try {
    const enabled = await requestText('GET', `${serverUrl}/QuickConnect/Enabled`)
    if (enabled.trim().toLowerCase() !== 'true') {
      throw new UserFailure('此 Jellyfin 服务器未启用快速连接，请使用账户密码登录。', {
        code: 'quick_connect_disabled',
        server: initialServer,
      })
    }
    const publicInfo = await requestJson('GET', `${serverUrl}/System/Info/Public`)
    const initiated = await requestJson('POST', `${serverUrl}/QuickConnect/Initiate`)
    const secret = text(initiated.Secret, 4_096)
    const code = text(initiated.Code, 32)
    if (!secret || !code) {
      throw new UserFailure('服务器没有返回有效的快速登录码。', {
        code: 'invalid_quick_connect',
        server: serverSummary(serverUrl, publicInfo),
      })
    }

    const operationId = randomUUID()
    quickConnectOperations.clear()
    quickConnectOperations.set(operationId, {
      serverUrl,
      publicInfo,
      secret,
      expiresAt: Date.now() + quickConnectLifetimeMs,
    })
    return {
      operationId,
      code,
      authorizationUrl: `${serverUrl}/web/#/quickconnect?code=${encodeURIComponent(code)}`,
      server: serverSummary(serverUrl, publicInfo),
    }
  } catch (error) {
    throw friendlyFailure(error, initialServer)
  }
}

async function pollQuickConnect(operationIdValue) {
  pruneQuickConnectOperations()
  const operationId = text(operationIdValue, 128)
  const operation = quickConnectOperations.get(operationId)
  if (!operation) {
    throw new UserFailure('快速登录码已过期，请重新申请。', {
      code: 'quick_connect_expired',
    })
  }

  const server = serverSummary(operation.serverUrl, operation.publicInfo)
  try {
    const state = await requestJson(
      'GET',
      `${operation.serverUrl}/QuickConnect/Connect?secret=${encodeURIComponent(operation.secret)}`,
    )
    if (state.Authenticated !== true) return { pending: true }

    const authentication = await requestJson(
      'POST',
      `${operation.serverUrl}/Users/AuthenticateWithQuickConnect`,
      { Secret: operation.secret },
    )
    quickConnectOperations.delete(operationId)
    return {
      pending: false,
      server,
      session: createSession(operation.serverUrl, operation.publicInfo, authentication),
    }
  } catch (error) {
    quickConnectOperations.delete(operationId)
    throw friendlyFailure(error, server)
  }
}

function cancelQuickConnect(operationIdValue) {
  quickConnectOperations.delete(text(operationIdValue, 128))
  return { cancelled: true }
}

async function readJsonBody(request) {
  let source = ''
  let receivedLength = 0
  for await (const chunk of request) {
    receivedLength += chunk.length
    if (receivedLength > maximumRequestLength) {
      throw new UserFailure('联调请求内容过大。', { code: 'request_too_large', status: 413 })
    }
    source += chunk
  }
  if (!source.trim()) return {}
  try {
    const parsed = JSON.parse(source)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new UserFailure('联调请求格式无效。', { code: 'invalid_request' })
  }
}

function securityHeaders(contentType) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      'frame-src http://127.0.0.1:4175 http://127.0.0.1:4176 http://localhost:4175 http://localhost:4176',
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, securityHeaders('application/json; charset=utf-8'))
  response.end(JSON.stringify(payload))
}

function assertTrustedApiRequest(request) {
  if (!allowedOrigins.has(request.headers.origin || '')) {
    throw new UserFailure('已拒绝非联调页面发起的请求。', { code: 'invalid_origin', status: 403 })
  }
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new UserFailure('联调 API 只接受 JSON。', { code: 'invalid_content_type', status: 415 })
  }
}

async function handleApi(request, response, pathname) {
  assertTrustedApiRequest(request)
  const body = await readJsonBody(request)
  let result
  switch (pathname) {
    case '/api/development-server':
      result = await developmentServer()
      break
    case '/api/development-session':
      result = await developmentSession()
      break
    case '/api/login':
      result = await authenticate(body.serverUrl, body.username, body.password)
      break
    case '/api/quick-connect/start':
      result = await startQuickConnect(body.serverUrl)
      break
    case '/api/quick-connect/poll':
      result = await pollQuickConnect(body.operationId)
      break
    case '/api/quick-connect/cancel':
      result = cancelQuickConnect(body.operationId)
      break
    default:
      throw new UserFailure('未找到联调 API。', { code: 'not_found', status: 404 })
  }
  sendJson(response, 200, result)
}

async function handleRequest(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`)
  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { status: 'ok' })
    return
  }
  if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
    await handleApi(request, response, url.pathname)
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new UserFailure('不支持此请求方法。', { code: 'method_not_allowed', status: 405 })
  }

  const asset = staticFiles.get(url.pathname)
  if (!asset) {
    response.writeHead(404, securityHeaders('text/plain; charset=utf-8'))
    response.end('Not found')
    return
  }
  const [filename, contentType] = asset
  const source = await readFile(resolve(harnessDirectory, filename))
  response.writeHead(200, securityHeaders(contentType))
  if (request.method === 'HEAD') response.end()
  else response.end(source)
}

export function createHarnessServer() {
  return createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      const failure = friendlyFailure(error)
      if (!response.headersSent) {
        sendJson(response, failure.status, {
          error: failure.message,
          code: failure.code,
          ...(failure.server ? { server: failure.server } : {}),
        })
      } else {
        response.end()
      }
    })
  })
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const server = createHarnessServer()
  server.on('error', (error) => {
    const code = error && typeof error === 'object' ? error.code : ''
    if (code === 'EADDRINUSE') {
      process.stderr.write(`双端联调端口 ${port} 已被占用。\n`)
    } else {
      process.stderr.write('双端联调服务启动失败。\n')
    }
    process.exitCode = 1
  })
  server.listen(port, host, () => {
    process.stdout.write(`双端联调页：http://${host}:${port}/\n`)
  })
}
