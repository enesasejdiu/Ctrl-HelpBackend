// Structured logs (src/logger.js): the request id on every line and in the X-Request-Id header, one access line per
// request, how failures are logged (src/middleware/errors.js), and that no secret ever reaches the log.
const pool = require('../src/db')
const { captureLogs, logger, safePath, levelFromEnv } = require('../src/logger')
const {
  api,
  auth,
  createUser,
  loginAs,
  resetData,
  useEmail,
  inviteTokenFor,
  sentMail,
  DEFAULT_PASSWORD,
} = require('./helpers')

let logs
beforeEach(async () => {
  await resetData()
  logs = captureLogs()
})
afterEach(() => {
  logs.restore()
  jest.restoreAllMocks()
})

const accessLines = () => logs.lines.filter((line) => line.res?.status !== undefined)
const linesOf = (id) => logs.lines.filter((line) => line.request_id === id)

describe('request id', () => {
  test('every request gets an id: sent back in X-Request-Id and on its log lines', async () => {
    const res = await api.get('/api/no-such-route')

    const id = res.headers['x-request-id']
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(linesOf(id).length).toBeGreaterThanOrEqual(2) // the 404 warning and the access line
    expect(logs.lines.every((line) => line.request_id === id)).toBe(true)
  })

  test('two requests get two different ids', async () => {
    const a = await api.get('/api/no-such-route')
    const b = await api.get('/api/no-such-route')
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id'])
  })

  test('a safe incoming X-Request-Id is kept (e.g. from nginx)', async () => {
    const res = await api.get('/api/no-such-route').set('X-Request-Id', 'abc-123_DEF.4')

    expect(res.headers['x-request-id']).toBe('abc-123_DEF.4')
    expect(linesOf('abc-123_DEF.4').length).toBeGreaterThanOrEqual(2)
  })

  test.each([
    ['too long', 'a'.repeat(65)],
    ['spaces', 'two words'],
    ['quotes', '"injected"'],
    ['a forged JSON field', 'x","level":"fatal'],
    ['empty', ''],
  ])('an unsafe incoming X-Request-Id (%s) is replaced by a new one', async (_, incoming) => {
    const res = await api.get('/api/no-such-route').set('X-Request-Id', incoming)

    const id = res.headers['x-request-id']
    expect(id).not.toBe(incoming)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(logs.text()).not.toContain(incoming || '"request_id":""')
  })

  test('lines a route logs itself carry the request id too', async () => {
    useEmail(false)
    try {
      const res = await api.post('/api/auth/forgot-password').send({ email: 'nobody@test.local' })
      const id = res.headers['x-request-id']
      const routeLine = logs.lines.find((line) => /Forgot password/.test(line.msg))
      expect(routeLine).toMatchObject({ request_id: id, level: 'warn' })
    } finally {
      useEmail(false)
    }
  })
})

describe('access log', () => {
  test('one line per request: method, path, status, duration, user id and request id', async () => {
    const user = await createUser()
    const session = await loginAs(user)
    logs.lines.length = 0

    const res = await api.get('/api/tickets?page=2&search=secret-search-term').set(auth(session))

    expect(res.status).toBe(200)
    const lines = accessLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: 'info',
      request_id: res.headers['x-request-id'],
      req: { method: 'GET', path: '/api/tickets?page&search' },
      res: { status: 200 },
      user_id: user.id,
    })
    expect(typeof lines[0].duration_ms).toBe('number')
    expect(lines[0].msg).toMatch(/^GET \/api\/tickets\?page&search 200 \d+ms$/)
    // The query string's values are not logged
    expect(logs.text()).not.toContain('secret-search-term')
  })

  test('no user id when nobody is logged in', async () => {
    await api.get('/api/no-such-route')
    expect(accessLines()[0]).not.toHaveProperty('user_id')
  })

  test('GET /api/health is not logged (health checks would flood the log)', async () => {
    const res = await api.get('/api/health')

    expect(res.status).toBe(200)
    expect(res.headers['x-request-id']).toBeDefined()
    expect(logs.lines).toEqual([])
  })
})

describe('failures', () => {
  test('a 500 is logged at error with message, stack, request id, method, path and user id; the client only gets a reference', async () => {
    const user = await createUser()
    const session = await loginAs(user)
    const detail = 'connect ECONNREFUSED 10.0.0.5:3306 (internal detail)'
    // Fails the ticket list's query, after requireAuth has found the user
    const query = pool.query.bind(pool)
    jest
      .spyOn(pool, 'query')
      .mockImplementation((sql, ...rest) =>
        /FROM tickets/i.test(String(sql)) ? Promise.reject(new Error(detail)) : query(sql, ...rest),
      )

    const res = await api.get('/api/tickets').set(auth(session))

    const id = res.headers['x-request-id']
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ message: `Something went wrong (reference: ${id})`, request_id: id })
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED')

    const errorLine = logs.lines.find((line) => line.level === 'error')
    expect(errorLine).toMatchObject({
      request_id: id,
      method: 'GET',
      path: '/api/tickets',
      status: 500,
      user_id: user.id,
      msg: detail,
      err: { message: detail, type: 'Error' },
    })
    expect(errorLine.err.stack).toContain('Error: connect ECONNREFUSED')
    expect(errorLine.err.stack).toMatch(/\n\s+at /)
    // The access line keeps its usual shape: no second (made-up) error
    const [access] = accessLines()
    expect(access).toMatchObject({ request_id: id, res: { status: 500 }, user_id: user.id })
    expect(access).not.toHaveProperty('err')
    expect(access.msg).toMatch(/^GET \/api\/tickets 500 \d+ms$/)
  })

  test('a 4xx is logged at warn with its message, without a stack', async () => {
    const res = await api.get('/api/no-such-route')

    expect(res.status).toBe(404)
    const line = logs.lines.find((l) => l.level === 'warn')
    expect(line).toMatchObject({
      request_id: res.headers['x-request-id'],
      method: 'GET',
      path: '/api/no-such-route',
      status: 404,
      msg: 'Route not found: GET /api/no-such-route',
    })
    expect(line).not.toHaveProperty('err')
    expect(JSON.stringify(line)).not.toContain(' at ')
  })

  test('a 404 for a path with a query string does not echo its values', async () => {
    const res = await api.get('/api/no-such-route?token=abcdef123456')

    expect(res.body.message).toBe('Route not found: GET /api/no-such-route?token')
    expect(logs.text()).not.toContain('abcdef123456')
  })
})

describe('secrets never reach the log', () => {
  test('passwords, tokens, cookies, temporary passwords, set-password links and server secrets', async () => {
    // Server secrets, set so the test can look for them
    const original = { SMTP_USER: process.env.SMTP_USER, SMTP_PASS: process.env.SMTP_PASS }
    process.env.SMTP_USER = 'mailer'
    process.env.SMTP_PASS = 'smtp-pass-MARKER-91f2'
    const secrets = { jwtSecret: process.env.JWT_SECRET, smtpPass: process.env.SMTP_PASS }
    try {
      // 1. Login: password in the body, session in Set-Cookie
      const admin = await createUser({ role: 'admin', password: 'Admin-Pass-MARKER-77a1' })
      const login = await api.post('/api/auth/login').send({ email: admin.email, password: admin.password })
      expect(login.status).toBe(200)
      const session = login.headers['set-cookie'].join(';').match(/tf_session=([^;]+)/)[1]
      secrets.loginPassword = admin.password
      secrets.session = decodeURIComponent(session)

      // 2. Cookie and Authorization headers on an authenticated request
      const bearer = 'Bearer bearer-MARKER-4c3d'
      await api.get('/api/tickets').set(auth(secrets.session)).set('Authorization', bearer)
      secrets.bearer = 'bearer-MARKER-4c3d'

      // 3. A temporary password (email not set up)
      useEmail(false)
      const created = await api
        .post('/api/users')
        .set(auth(secrets.session))
        .send({ name: 'Temp Person', email: 'temp.person@test.local', role: 'employee' })
      expect(created.status).toBe(201)
      secrets.temporaryPassword = created.body.temporaryPassword
      expect(secrets.temporaryPassword).toEqual(expect.any(String))

      // 4. A set-password link (email set up): validate it, then use it with a new password
      useEmail(true)
      await api
        .post('/api/users')
        .set(auth(secrets.session))
        .send({ name: 'Link Person', email: 'link.person@test.local', role: 'employee' })
      const token = await inviteTokenFor('link.person@test.local')
      secrets.linkToken = token
      secrets.link = (await sentMail()).find((mail) => mail.to === 'link.person@test.local').link
      await api.get(`/api/auth/set-password/validate?token=${token}`)
      const newPassword = 'New-Pass-MARKER-2b8e'
      const setRes = await api.post('/api/auth/set-password').send({ token, new_password: newPassword })
      expect(setRes.status).toBe(200)
      secrets.newPassword = newPassword

      // 5. Change password: current and new password in the body
      const user = await createUser({ password: DEFAULT_PASSWORD })
      const userSession = await loginAs(user)
      const changedPassword = 'Changed-Pass-MARKER-5e6f'
      await api
        .post('/api/auth/change-password')
        .set(auth(userSession))
        .send({ currentPassword: DEFAULT_PASSWORD, newPassword: changedPassword })
      secrets.changedPassword = changedPassword

      // 6. A failed login (4xx) and one that crashes (500): the body is never logged
      await api.post('/api/auth/login').send({ email: admin.email, password: 'Wrong-Pass-MARKER-0a0b' })
      secrets.wrongPassword = 'Wrong-Pass-MARKER-0a0b'
      jest.spyOn(pool, 'query').mockRejectedValueOnce(new Error('database down'))
      await api.post('/api/auth/login').send({ email: admin.email, password: 'Crash-Pass-MARKER-c0c1' })
      secrets.crashPassword = 'Crash-Pass-MARKER-c0c1'

      // 7. Something logs an object with secret fields anyway: redact takes them out
      logger.info(
        {
          password: 'obj-password-MARKER',
          user: { temporary_password: 'obj-temp-MARKER', token: 'obj-token-MARKER' },
          headers: { authorization: 'obj-auth-MARKER', cookie: 'obj-cookie-MARKER' },
          body: { anything: 'obj-body-MARKER' },
          JWT_SECRET: secrets.jwtSecret,
          SMTP_PASS: secrets.smtpPass,
        },
        'object with secrets',
      )
      for (const marker of ['obj-password', 'obj-temp', 'obj-token', 'obj-auth', 'obj-cookie', 'obj-body']) {
        secrets[marker] = `${marker}-MARKER`
      }

      await sentMail() // background emails finished, their lines written
      const text = logs.text()
      expect(logs.lines.length).toBeGreaterThan(10) // the requests above really were logged
      for (const [name, value] of Object.entries(secrets)) {
        expect({ name, found: text.includes(value) }).toEqual({ name, found: false })
      }
      expect(text).toContain('[redacted]')
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      useEmail(false)
    }
  })
})

describe('helpers', () => {
  test('safePath keeps the query keys and drops their values', () => {
    expect(safePath('/api/tickets')).toBe('/api/tickets')
    expect(safePath('/api/x?token=abc&token=def&page=2')).toBe('/api/x?token&page')
    expect(safePath('/api/x?')).toBe('/api/x')
  })

  test('LOG_LEVEL: default info, any valid level, silent in tests', () => {
    expect(levelFromEnv({ NODE_ENV: 'production' })).toBe('info')
    expect(levelFromEnv({ NODE_ENV: 'production', LOG_LEVEL: 'debug' })).toBe('debug')
    expect(levelFromEnv({ NODE_ENV: 'production', LOG_LEVEL: ' WARN ' })).toBe('warn')
    expect(levelFromEnv({ NODE_ENV: 'production', LOG_LEVEL: 'loud' })).toBe('info')
    expect(levelFromEnv({ NODE_ENV: 'test', LOG_LEVEL: 'debug' })).toBe('silent')
  })
})
