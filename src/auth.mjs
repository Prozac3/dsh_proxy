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
function page(next, failed = false) {
  const escaped = next.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>DSH Login</title><style>body{font:16px system-ui;max-width:24rem;margin:12vh auto;padding:1rem}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{padding:.7rem;margin:.4rem 0 1rem}.error{color:#b00}</style></head><body><h1>DeepSeek Harness</h1>${failed ? '<p class="error">用户名或密码错误。</p>' : ''}<form method="post" action="/login"><input type="hidden" name="next" value="${escaped}"><label>用户名<input name="username" autocomplete="username" required autofocus></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">登录</button></form></body></html>`
}
function send(res, status, body = '', headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers }); res.end(body)
}

/** Validate the authentication service environment. */
export function loadAuthConfig(env = process.env) {
  for (const name of ['AUTH_USER', 'AUTH_PASS', 'SESSION_SECRET']) {
    if (typeof env[name] !== 'string' || env[name].length < 8) throw new Error(`${name} must contain at least 8 characters`)
  }
  const port = 3082; const hours = Number(env.SESSION_HOURS ?? 12)
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('SESSION_HOURS must be positive')
  return { user: env.AUTH_USER, password: env.AUTH_PASS, secret: env.SESSION_SECRET, port, hours, secure: new URL(env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:3000').protocol === 'https:' }
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
      send(res, 303, '', { location: target, 'set-cookie': attrs.join('; ') })
    })
  })
}
