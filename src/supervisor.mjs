import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'

const DSH_URL_PATTERN = /dsh web:\s+(https?:\/\/[^\s)]+)/u

function externalUrl(line, publicOrigin) {
  const match = DSH_URL_PATTERN.exec(line)
  if (match?.[1] === undefined) return undefined
  const local = new URL(match[1])
  return new URL(`${local.pathname}${local.search}${local.hash}`, publicOrigin).href
}

function relay(stream, destination, onLine) {
  const lines = readline.createInterface({ input: stream })
  lines.on('line', (line) => {
    destination.write(`${line}\n`)
    onLine?.(line)
  })
  return lines
}

/** Start an unmodified dsh Web process and add the proxy-facing Web flags. */
export function startDsh(config, output = process.stdout, errorOutput = process.stderr) {
  let resolveReady
  let rejectReady
  let readySettled = false
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const args = [
    ...config.dshArgs,
    '--no-open',
    '--host', config.upstreamHost,
    '--port', String(config.upstreamPort),
    '--trusted-host', config.publicOrigin.host,
  ]
  const child = spawn(config.dshBin, args, {
    cwd: config.dshCwd,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  const failReady = (error) => {
    if (readySettled) return
    readySettled = true; rejectReady(error)
  }
  child.once('error', (error) => failReady(error))
  child.once('exit', (code, signal) => {
    if (!readySettled) failReady(new Error(`dsh exited before announcing its Web URL (${signal ?? String(code)})`))
  })
  relay(child.stdout, output, (line) => {
    const url = externalUrl(line, config.publicOrigin)
    if (url !== undefined) {
      output.write(`dsh-proxy: open ${url}\n`)
      const token = new URL(url).searchParams.get('token')
      if (token !== null && token !== '' && !readySettled) {
        readySettled = true; resolveReady(token)
      }
    }
  })
  relay(child.stderr, errorOutput)
  return { child, ready }
}

/** Terminate a managed child and wait for it to exit. */
export async function stopDsh(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise(resolve => child.once('exit', resolve))
}

function loadEnvFile(path) {
  if (!existsSync(path)) throw new Error(`missing ${path}; copy .env.example to .env and configure it`)
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim(); if (line === '' || line.startsWith('#')) continue
    const at = line.indexOf('='); if (at < 1) throw new Error(`invalid .env line: ${raw}`)
    const name = line.slice(0, at).trim(); let value = line.slice(at + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (process.env[name] === undefined) process.env[name] = value
  }
}

function startChild(root, name, command, args, env = process.env) {
  const handle = spawn(command, args, { cwd: root, env, stdio: 'inherit' })
  handle.once('error', error => console.error(`dsh-proxy: ${name} failed: ${error.message}`)); return handle
}

/** Validate Nginx, then supervise auth, DSH, and Nginx as one foreground stack. */
export async function startStack(root) {
  loadEnvFile(join(root, '.env'))
  const config = (await import('./config.mjs')).loadConfig()
  const nginxArgs = ['-p', `${root}/`, '-c', 'nginx/nginx.conf']
  const check = spawnSync('nginx', [...nginxArgs, '-t'], { cwd: root, env: process.env, stdio: 'inherit' })
  if (check.error !== undefined) throw check.error
  if (check.status !== 0) throw new Error('Nginx configuration validation failed')
  const children = []
  let stopping = false
  const stop = (signal = 'SIGTERM') => {
    if (stopping) return; stopping = true
    for (const handle of children.toReversed()) if (handle.exitCode === null && handle.signalCode === null) handle.kill(signal)
  }
  process.once('SIGINT', () => stop('SIGINT')); process.once('SIGTERM', () => stop('SIGTERM'))
  const dsh = config.manageDsh ? startDsh(config) : undefined
  let dshToken = process.env.DSH_LAUNCH_TOKEN
  if (dsh !== undefined) {
    children.push(dsh.child)
    try {
      dshToken = await dsh.ready
    } catch (error) {
      stop()
      await stopDsh(dsh.child)
      throw error
    }
  }
  const authEnv = dshToken === undefined ? process.env : { ...process.env, DSH_LAUNCH_TOKEN: dshToken }
  children.push(startChild(root, 'auth', process.execPath, ['bin/auth-server.mjs'], authEnv))
  children.push(startChild(root, 'nginx', 'nginx', [...nginxArgs, '-g', 'daemon off;']))
  for (const handle of children) handle.once('exit', (code, signal) => {
    if (!stopping) { console.error(`dsh-proxy: child exited (${signal ?? String(code)})`); stop() }
  })
  console.log(`dsh-proxy: Nginx entry is ready for ${config.publicOrigin.origin}`)
  await Promise.all(children.map(handle => new Promise(resolve => handle.once('exit', resolve))))
}
