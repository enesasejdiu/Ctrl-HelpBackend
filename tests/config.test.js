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
  // Email (production needs SMTP_HOST, MAIL_FROM and an https APP_URL unless MAIL_ENABLED=false)
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_SECURE: 'false',
  SMTP_USER: 'mailer',
  SMTP_PASS: 'smtp-password-never-logged',
  MAIL_FROM: 'TicketFlow <no-reply@example.com>',
  APP_URL: 'https://helpdesk.example.com',
  IT_NOTIFY_EMAIL: 'it@example.com',
}
const MAIL_SETTINGS = [
  'MAIL_ENABLED',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
  'APP_URL',
  'IT_NOTIFY_EMAIL',
]
// GOOD without any email setting
const withoutMail = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !MAIL_SETTINGS.includes(key)))
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

describe('email settings', () => {
  test('production with MAIL_ENABLED=true sends real email (email set up), with the settings parsed', () => {
    const { config, notices } = loadConfig(prod({ MAIL_ENABLED: 'true' }))
    expect(notices).toEqual([])
    expect(config.mail).toMatchObject({
      mode: 'smtp',
      emailConfigured: true,
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'mailer',
      from: 'TicketFlow <no-reply@example.com>',
      appUrl: 'https://helpdesk.example.com',
      itNotifyEmail: 'it@example.com',
    })
  })

  test('email is off unless MAIL_ENABLED=true, even in production with every SMTP setting', () => {
    for (const env of [prod(), dev(), prod({ MAIL_ENABLED: 'false' })]) {
      expect(loadConfig(env).config.mail).toMatchObject({ mode: 'log', emailConfigured: false })
    }
  })

  test('production with MAIL_ENABLED=true but without SMTP_HOST, MAIL_FROM or APP_URL refuses to start, listing all three', () => {
    const { exited, exitCode, log } = run(
      prod({ MAIL_ENABLED: 'true', SMTP_HOST: '', MAIL_FROM: undefined, APP_URL: undefined }),
    )
    expect({ exited, exitCode }).toEqual({ exited: true, exitCode: 1 })
    const message = log.error.mock.calls[0][0]
    expect(message).toMatch(/SMTP_HOST is missing/)
    expect(message).toMatch(/MAIL_FROM is missing/)
    expect(message).toMatch(/APP_URL is missing/)
    expect(message).toMatch(/or set MAIL_ENABLED=false/)
  })

  test('production refuses an http APP_URL', () => {
    expect(() => loadConfig(prod({ MAIL_ENABLED: 'true', APP_URL: 'http://helpdesk.example.com' }))).toThrow(
      /APP_URL must use https in production/,
    )
  })

  test('production without any email settings starts (passwords are temporary ones), with no warning', () => {
    const { config, exited, log } = run(withoutMail(prod()))
    expect(exited).toBe(false)
    expect(config.mail).toMatchObject({ mode: 'log', emailConfigured: false })
    expect(log.warn).not.toHaveBeenCalled()
  })

  test('development without SMTP settings logs emails instead of sending, with links from CLIENT_URL', () => {
    const { config, notices } = loadConfig(withoutMail(dev({ CLIENT_URL: 'http://localhost:5173/' })))
    expect(notices).toEqual([])
    expect(config.mail).toMatchObject({ mode: 'log', appUrl: 'http://localhost:5173', itNotifyEmail: null })
  })

  test('development sends only with MAIL_ENABLED=true, an SMTP host and MAIL_FROM (e.g. Mailpit)', () => {
    expect(loadConfig(dev()).config.mail.mode).toBe('log')
    expect(loadConfig(dev({ MAIL_ENABLED: 'true' })).config.mail).toMatchObject({ mode: 'smtp', emailConfigured: true })
    for (const missing of [{ SMTP_HOST: '' }, { MAIL_FROM: '' }]) {
      const half = loadConfig(dev({ MAIL_ENABLED: 'true', ...missing }))
      expect(half.config.mail).toMatchObject({ mode: 'log', emailConfigured: false })
      expect(half.notices).toEqual([
        'MAIL_ENABLED=true but SMTP_HOST or MAIL_FROM is empty: emails are logged instead of sent, and passwords are temporary ones',
      ])
    }
  })

  test('the test suite never sends, whatever is set', () => {
    expect(loadConfig({ ...GOOD, NODE_ENV: 'test', MAIL_ENABLED: 'true' }).config.mail.mode).toBe('test')
  })

  test('blank values count as not set, and APP_URL loses a trailing slash', () => {
    const { config } = loadConfig(dev({ SMTP_PORT: ' ', IT_NOTIFY_EMAIL: '', APP_URL: 'https://desk.example.com/' }))
    expect(config.mail).toMatchObject({ port: 587, itNotifyEmail: null, appUrl: 'https://desk.example.com' })
  })

  test.each([
    ['SMTP_PORT', 'abc', /SMTP_PORT must be a number/],
    ['SMTP_PORT', '70000', /SMTP_PORT must be between 1 and 65535/],
    ['SMTP_SECURE', 'yes', /SMTP_SECURE must be true or false/],
    ['MAIL_ENABLED', '1', /MAIL_ENABLED must be true or false/],
    ['MAIL_FROM', 'TicketFlow', /MAIL_FROM must be an address/],
    ['MAIL_FROM', 'TicketFlow <no-reply@example.com>\nBcc: x@evil.example', /MAIL_FROM must be an address/],
    ['APP_URL', 'helpdesk', /APP_URL must be the frontend address/],
    ['IT_NOTIFY_EMAIL', 'it-team', /IT_NOTIFY_EMAIL must be an email address/],
  ])('a malformed %s (%j) stops even development', (name, value, message) => {
    expect(() => loadConfig(dev({ [name]: value }))).toThrow(message)
  })

  test('SMTP_USER and SMTP_PASS must come together', () => {
    expect(() => loadConfig(dev({ SMTP_PASS: '' }))).toThrow(/SMTP_USER and SMTP_PASS must be set together/)
    expect(() => loadConfig(dev({ SMTP_USER: '' }))).toThrow(/SMTP_USER and SMTP_PASS must be set together/)
    expect(loadConfig(dev({ SMTP_USER: '', SMTP_PASS: '' })).config.mail.user).toBeNull()
  })

  test('the database scripts never need email settings', () => {
    expect(run(withoutMail(prod()), 'database').exited).toBe(false)
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

  test('src/server.js refuses to start in production with MAIL_ENABLED=true but no SMTP host, and never prints the SMTP password', () => {
    const res = spawnNode(
      'src/server.js',
      prod({ MAIL_ENABLED: 'true', SMTP_HOST: '', PORT: '5999', DB_NAME: 'ticketflow_test_never_used' }),
    )
    expect(res.status).toBe(1)
    expect(res.stderr).toMatch(/Invalid configuration/)
    expect(res.stderr).toMatch(/SMTP_HOST is missing/)
    expect(`${res.stdout}${res.stderr}`).not.toContain(GOOD.SMTP_PASS)
    expect(res.stdout).not.toMatch(/API running/)
  })

  test('scripts/migrate.js stops before connecting when a DB setting is missing', () => {
    const res = spawnNode('scripts/migrate.js', dev({ DB_HOST: ' ', DB_NAME: 'ticketflow_test_never_used' }))
    expect(res.status).toBe(1)
    expect(res.stderr).toMatch(/DB_HOST is missing/)
    expect(res.stdout).not.toMatch(/Applied|up to date/)
  })
})

describe('LOCKOUT_MINUTES', () => {
  test.each(['production', 'development'])('%s refuses to start with a value other than 15', (NODE_ENV) => {
    const env = NODE_ENV === 'production' ? prod({ LOCKOUT_MINUTES: '5' }) : dev({ LOCKOUT_MINUTES: '5' })
    const { exited, exitCode, log } = run(env)
    expect([exited, exitCode]).toEqual([true, 1])
    expect(log.error.mock.calls[0][0]).toMatch(/LOCKOUT_MINUTES can only be changed when NODE_ENV=test/)
  })

  test('15, or not set, is fine everywhere', () => {
    expect(run(prod({ LOCKOUT_MINUTES: '15' })).exited).toBe(false)
    expect(run(prod()).exited).toBe(false)
    expect(run(dev({ LOCKOUT_MINUTES: '' })).exited).toBe(false)
  })

  test('in the test environment: a whole number of minutes from 1 to 1440', () => {
    const test = (value) => ({ ...GOOD, NODE_ENV: 'test', LOCKOUT_MINUTES: value })
    expect(run(test('1')).exited).toBe(false)
    expect(run(test('1440')).exited).toBe(false)
    for (const value of ['0', '1441', '2.5', 'abc']) {
      const { exited, log } = run(test(value))
      expect([value, exited]).toEqual([value, true])
      expect(log.error.mock.calls[0][0]).toMatch(/LOCKOUT_MINUTES must be a whole number of minutes from 1 to 1440/)
    }
  })
})
