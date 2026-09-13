import assert from 'node:assert/strict'
import http from 'node:http'
import { afterEach, test } from 'node:test'
import { createAuthServer } from '../src/auth.mjs'

const servers = []
afterEach(async () => Promise.allSettled(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))))
async function start() {
  const server = createAuthServer({ user: 'operator', password: 'correct-password', secret: 'a-secure-test-secret', hours: 1, secure: true })
  servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port
}
function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    }); req.on('error', reject); req.end(options.body)
  })
}
test('login issues a secure cookie accepted by auth_request', async () => {
  const port = await start(); const login = await request(port, '/login', { method: 'POST', body: 'username=operator&password=correct-password&next=%2F%3Ftoken%3Dabc' })
  assert.equal(login.status, 303); assert.equal(login.headers.location, '/?token=abc'); assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Path=\/; Max-Age=3600; Secure/u)
  assert.equal((await request(port, '/_auth', { headers: { cookie: login.headers['set-cookie'][0].split(';', 1)[0] } })).status, 204)
})
test('rejects wrong credentials and external redirects', async () => {
  const port = await start(); const login = await request(port, '/login', { method: 'POST', body: 'username=operator&password=wrong-pass&next=https%3A%2F%2Fevil.example' })
  assert.equal(login.status, 401); assert.doesNotMatch(login.body, /evil\.example/u); assert.equal((await request(port, '/_auth')).status, 401)
})
