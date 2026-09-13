import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'

const COOKIE_NAME = 'dsh_proxy_session'
const equal = (a, b) => {
  const left = Buffer.from(a); const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
const sign = (secret, payload) => createHmac('sha256', secret).update(payload).digest('base64url')

function createSession(secret, hours) {
  const payload = Buffer.from(JSON.stringify({ expiresAt: Date.now() + hours * 3_600_000, nonce: randomBytes(16).toString('base64url') })).toString('base64url')
  return `${payload}.${sign(secret, payload)}`
}

function validSession(secret, value) {
  const [payload, signature, extra] = value.split('.')
  if (payload === undefined || signature === undefined || extra !== undefined || !equal(signature, sign(secret, payload))) return false
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return typeof decoded.expiresAt === 'number' && decoded.expiresAt > Date.now()
  } catch { return false }
}

function cookieValue(header) {
  for (const part of (header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === COOKIE_NAME) return rest.join('=')
  }
}

const safeNext = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/'

/**
 * Complete the Harness launch-token exchange after the proxy login.
 * Harness accepts its launch token only on the root URL, so the browser
 * always starts at `/` and is then redirected back to a clean root by DSH.
 */
function dshLoginTarget(next, dshToken) {
  if (typeof dshToken !== 'string' || dshToken.length === 0) return next
  const target = new URL(next, 'http://dsh-proxy.invalid')
  target.pathname = '/'; target.search = ''; target.hash = ''
  target.searchParams.set('token', dshToken)
  return `${target.pathname}${target.search}`
}

function page(next, failed = false) {
  const escaped = next.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness</title>
<style>
  :root { --bg: #151517; --card: #1b1b1c; --border: rgba(255,255,255,.06); --text: #f5f6f7; --muted: #979da6; --primary: #5686fe; --error: #f56c6c; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .card { width: 340px; padding: 32px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; }
  .mark { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .logo { width: 28px; height: 28px; flex: none; background: var(--primary); -webkit-mask: url('/favicon.svg') center / contain no-repeat; mask: url('/favicon.svg') center / contain no-repeat; }
  .title { font-size: 18px; font-weight: 700; }
  .subtitle { font-size: 13px; color: var(--muted); margin-bottom: 24px; }
  label { display: block; font-size: 13px; color: var(--muted); margin: 14px 0 6px; }
  input { width: 100%; padding: 9px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 14px; outline: none; }
  input:focus { border-color: var(--primary); }
  .error { color: var(--error); font-size: 13px; margin-top: 12px; min-height: 18px; }
  button { width: 100%; margin-top: 18px; padding: 10px; background: var(--primary); border: none; border-radius: 8px; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
</style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <div class="mark">
      <div class="logo" aria-hidden="true"></div>
      <div class="title">DeepSeek Harness</div>
    </div>
    <div class="subtitle">登录以访问 Agent Web UI</div>
    <input type="hidden" name="next" value="${escaped}">
    <label for="user">用户名</label>
    <input id="user" name="username" autocomplete="username" required autofocus>
    <label for="pass">密码</label>
    <input id="pass" name="password" type="password" autocomplete="current-password" required>
    <div class="error">${failed ? '用户名或密码错误' : ''}</div>
    <button type="submit">登录</button>
  </form>
</body>
</html>`
}
function send(res, status, body = '', headers = {}) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    ...headers,
  }); res.end(body)
}

/** Validate the authentication service environment. */
export function loadAuthConfig(env = process.env) {
  if (typeof env.AUTH_USER !== 'string' || env.AUTH_USER.length === 0) throw new Error('AUTH_USER must not be empty')
  for (const name of ['AUTH_PASS', 'SESSION_SECRET']) {
    if (typeof env[name] !== 'string' || env[name].length < 8) throw new Error(`${name} must contain at least 8 characters`)
  }
  const port = 3082; const hours = Number(env.SESSION_HOURS ?? 12)
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('SESSION_HOURS must be positive')
  const dshToken = typeof env.DSH_LAUNCH_TOKEN === 'string' && env.DSH_LAUNCH_TOKEN !== ''
    ? env.DSH_LAUNCH_TOKEN : undefined
  return {
    user: env.AUTH_USER,
    password: env.AUTH_PASS,
    secret: env.SESSION_SECRET,
    dshToken,
    port,
    hours,
    secure: new URL(env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:3000').protocol === 'https:',
  }
}

/** Create the loopback auth_request service. */
export function createAuthServer(config) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://auth.invalid')
    if (url.pathname === '/_auth') {
      const session = cookieValue(req.headers.cookie)
      send(res, session !== undefined && validSession(config.secret, session) ? 204 : 401); return
    }
    if (url.pathname !== '/login') { send(res, 404, 'not found\n'); return }
    const next = safeNext(url.searchParams.get('next'))
    if (req.method === 'GET') { send(res, 200, page(next), { 'content-type': 'text/html; charset=utf-8' }); return }
    if (req.method !== 'POST') { send(res, 405, 'method not allowed\n', { allow: 'GET, POST' }); return }
    const chunks = []; let bytes = 0
    req.on('data', (chunk) => { bytes += chunk.length; if (bytes > 16 * 1024) req.destroy(); else chunks.push(chunk) })
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString()); const target = safeNext(form.get('next'))
      if (!equal(form.get('username') ?? '', config.user) || !equal(form.get('password') ?? '', config.password)) {
        send(res, 401, page(target, true), { 'content-type': 'text/html; charset=utf-8' }); return
      }
      const attrs = [`${COOKIE_NAME}=${createSession(config.secret, config.hours)}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${String(Math.floor(config.hours * 3600))}`]
      if (config.secure) attrs.push('Secure')
      send(res, 303, '', { location: dshLoginTarget(target, config.dshToken), 'set-cookie': attrs.join('; ') })
    })
  })
}
