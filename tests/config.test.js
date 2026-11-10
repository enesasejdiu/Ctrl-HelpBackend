// The startup configuration check (src/config.js): required settings, and the production rules for JWT_SECRET and
// CLIENT_URL, which refuse to start in production and only warn in development.
const { spawnSync } = require('child_process')
const path = require('path')
const { loadConfig, checkConfig, ConfigError, PLACEHOLDER_SECRETS } = require('../src/config')

const STRONG_SECRET = 'a'.repeat(16) + 'B'.repeat(16) + '0123456789'
const GOOD = {
  PORT: '5050',
  DB_HOST: 'localhost',
  DB_PORT: '3306',
  DB_USER: 'root',
  DB_PASSWORD: '',
  DB_NAME: 'ticketflow',
  JWT_SECRET: STRONG_SECRET,
  CLIENT_URL: 'https://helpdesk.example.com',
}
const dev = (overrides) => ({ ...GOOD, NODE_ENV: 'development', ...overrides })
const prod = (overrides) => ({ ...GOOD, NODE_ENV: 'production', ...overrides })

// Runs checkConfig with a fake console and exit, and reports what happened
function run(env, scope = 'server') {
  const log = { warn: jest.fn(), error: jest.fn() }
  const exit = jest.fn()
  const config = checkConfig(scope, { env, log, exit })
  return { config, exited: exit.mock.calls.length > 0, exitCode: exit.mock.calls[0]?.[0], log }
}

describe('a good configuration', () => {
  test('passes in production and development without warnings, with numbers parsed', () => {
    for (const env of [prod(), dev()]) {
      const { config, warnings } = loadConfig(env)
      expect(warnings).toEqual([])
      expect(config).toMatchObject({ PORT: 5050, DB_PORT: 3306, DB_PASSWORD: '' })
    }
  })

  test('NODE_ENV defaults to development', () => {
    expect(loadConfig({ ...GOOD }).config.NODE_ENV).toBe('development')
  })
})

describe('weak settings: refused in production, only a warning in development', () => {
  const cases = [
    ['JWT_SECRET shorter than 32 characters', { JWT_SECRET: 'x'.repeat(31) }, /JWT_SECRET is only 31 characters/],
    ['the .env.example placeholder secret', { JWT_SECRET: 'change_this_to_a_long_random_string' }, /placeholder/],
    ['"secret" as the secret', { JWT_SECRET: 'secret' }, /placeholder/],
    ['a placeholder in other letter case', { JWT_SECRET: 'SECRET' }, /placeholder/],
    ['CLIENT_URL over http', { CLIENT_URL: 'http://helpdesk.example.com' }, /CLIENT_URL must use https in production/],
  ]

  test.each(cases)('%s: production refuses to start (exit 1) with a clear message', (_, overrides, message) => {
    const { exited, exitCode, log } = run(prod(overrides))
    expect(exited).toBe(true)
    expect(exitCode).toBe(1)
    expect(log.error.mock.calls[0][0]).toMatch(message)
    expect(() => loadConfig(prod(overrides))).toThrow(ConfigError)
  })

  test.each(cases)('%s: development starts, with a warning', (_, overrides, message) => {
    const { exited, config, log } = run(dev(overrides))
    expect(exited).toBe(false)
    expect(config).toBeDefined()
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toMatch(message)
    expect(log.warn.mock.calls[0][0]).toMatch(/would refuse to start with NODE_ENV=production/)
  })

  test('the message tells how to generate a secret', () => {
    expect(() => loadConfig(prod({ JWT_SECRET: 'short' }))).toThrow(/randomBytes\(48\)\.toString\('hex'\)/)
  })

  test('every listed placeholder is refused in production, however long', () => {
    for (const secret of PLACEHOLDER_SECRETS) {
      expect(() => loadConfig(prod({ JWT_SECRET: secret }))).toThrow(/placeholder/)
    }
  })

  test('several problems are all listed at once', () => {
    const err = (() => {
      try {
        loadConfig(prod({ JWT_SECRET: 'secret', CLIENT_URL: 'http://x.example' }))
      } catch (e) {
        return e
      }
    })()
    expect(err.problems).toHaveLength(2)
  })
})

describe('missing or malformed settings: refused everywhere', () => {
  test.each(['DB_HOST', 'DB_USER', 'DB_NAME', 'JWT_SECRET', 'CLIENT_URL', 'PORT', 'DB_PORT'])(
    '%s missing stops the server in development too',
    (name) => {
      const env = dev()
      delete env[name]
      const { exited, log } = run(env)
      expect(exited).toBe(true)
      expect(log.error.mock.calls[0][0]).toContain(name)
    },
  )

  test('an empty required value counts as missing', () => {
    expect(() => loadConfig(dev({ DB_HOST: '  ' }))).toThrow(/DB_HOST is missing/)
  })

  test('DB_PASSWORD may be empty but must be set', () => {
    expect(loadConfig(dev({ DB_PASSWORD: '' })).config.DB_PASSWORD).toBe('')
    const env = dev()
    delete env.DB_PASSWORD
    expect(() => loadConfig(env)).toThrow(/DB_PASSWORD is missing/)
  })

  test.each([
    ['PORT', 'abc', /PORT must be a number/],
    ['PORT', '70000', /PORT must be between 1 and 65535/],
    ['DB_PORT', '33.5', /DB_PORT must be a whole number/],
    ['CLIENT_URL', 'localhost:5173', /CLIENT_URL must be the frontend address/],
  ])('%s=%s is refused', (name, value, message) => {
    expect(() => loadConfig(dev({ [name]: value }))).toThrow(message)
  })
})

describe("the database scripts' scope", () => {
  test('needs only the DB_* settings, and never applies the production secret rules', () => {
    const env = { DB_HOST: 'h', DB_PORT: '3306', DB_USER: 'u', DB_PASSWORD: '', DB_NAME: 'n', NODE_ENV: 'production' }
    expect(run(env, 'database').exited).toBe(false)
    delete env.DB_NAME
    expect(run(env, 'database').exited).toBe(true)
  })
})

describe('the real entry points', () => {
  const root = path.join(__dirname, '..')
  // The child gets explicit values; dotenv never overrides them, so the developer's .env doesn't matter
  const spawnNode = (file, env) =>
    spawnSync(process.execPath, [file], {
      cwd: root,
      env: { PATH: process.env.PATH, DOTENV_CONFIG_QUIET: 'true', ...env },
      encoding: 'utf8',
      timeout: 15000,
    })

  test('src/server.js refuses to start in production with a weak secret, before listening', () => {
    const res = spawnNode(
      'src/server.js',
      prod({ JWT_SECRET: 'secret', PORT: '5999', DB_NAME: 'ticketflow_test_never_used' }),
    )
    expect(res.status).toBe(1)
    expect(res.stderr).toMatch(/Invalid configuration/)
    expect(res.stderr).toMatch(/JWT_SECRET is a placeholder/)
    expect(res.stdout).not.toMatch(/API running/)
  })

  test('scripts/migrate.js stops before connecting when a DB setting is missing', () => {
    const res = spawnNode('scripts/migrate.js', dev({ DB_HOST: ' ', DB_NAME: 'ticketflow_test_never_used' }))
    expect(res.status).toBe(1)
    expect(res.stderr).toMatch(/DB_HOST is missing/)
    expect(res.stdout).not.toMatch(/Applied|up to date/)
  })
})
