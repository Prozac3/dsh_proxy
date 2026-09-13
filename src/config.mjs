function boolean(name, value, fallback) {
  if (value === undefined || value === '') return fallback
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  throw new Error(`${name} must be 1, 0, true, or false`)
}

function stringArray(name, value, fallback) {
  if (value === undefined || value === '') return fallback
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`${name} must be a JSON array: ${error.message}`)
  }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error(`${name} must be a JSON array of strings`)
  }
  return parsed
}

function publicOrigin(value) {
  const origin = new URL(value ?? 'http://127.0.0.1:3080')
  if ((origin.protocol !== 'http:' && origin.protocol !== 'https:')
    || origin.username !== '' || origin.password !== '' || origin.pathname !== '/'
    || origin.search !== '' || origin.hash !== '') {
    throw new Error('PUBLIC_ORIGIN must be an http(s) origin without credentials, path, query, or fragment')
  }
  return origin
}

/** Load and validate process configuration. */
export function loadConfig(env = process.env) {
  const origin = publicOrigin(env.PUBLIC_ORIGIN)
  return {
    publicOrigin: origin,
    upstreamHost: '127.0.0.1',
    upstreamPort: 3081,
    manageDsh: boolean('MANAGE_DSH', env.MANAGE_DSH, true),
    dshBin: env.DSH_BIN || 'dsh',
    dshArgs: stringArray('DSH_ARGS_JSON', env.DSH_ARGS_JSON, ['web']),
  }
}
