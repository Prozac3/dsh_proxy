import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('marks an authenticated remote browser as the attended Host owner', async () => {
  const config = await readFile(new URL('../nginx/dsh-web.conf', import.meta.url), 'utf8')

  assert.match(config, /proxy_set_header Accept-Encoding "";/u)
  assert.match(config, /sub_filter_once on;/u)
  assert.match(config, /globalThis\.__DSH_TRANSPORT__\?\?=Object\.freeze\(\{ownsHost:true\}\)/u)
})
