import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig } from '../src/config.mjs'

test('passes an explicit DSH working directory to the supervisor configuration', () => {
  const config = loadConfig({
    PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    DSH_BIN: 'node',
    DSH_ARGS_JSON: '["/srv/dsh/apps/cli/lib/bin.js","web"]',
    DSH_CWD: '/srv/dsh',
  })

  assert.equal(config.dshBin, 'node')
  assert.deepEqual(config.dshArgs, ['/srv/dsh/apps/cli/lib/bin.js', 'web'])
  assert.equal(config.dshCwd, '/srv/dsh')
})

test('leaves the DSH working directory unset by default', () => {
  assert.equal(loadConfig({}).dshCwd, undefined)
})
