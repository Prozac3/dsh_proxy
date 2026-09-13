#!/usr/bin/env node
import { createAuthServer, loadAuthConfig } from '../src/auth.mjs'

try {
  const config = loadAuthConfig()
  createAuthServer(config).listen(config.port, '127.0.0.1', () => console.log(`dsh-proxy auth: listening on 127.0.0.1:${String(config.port)}`))
} catch (error) {
  console.error(`dsh-proxy auth: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1
}
