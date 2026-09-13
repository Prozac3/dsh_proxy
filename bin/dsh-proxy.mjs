#!/usr/bin/env node
import { resolve } from 'node:path'
import { startStack } from '../src/supervisor.mjs'

startStack(resolve(import.meta.dirname, '..')).catch((error) => {
  console.error(`dsh-proxy: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
