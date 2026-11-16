// Error tracking (src/sentry.js, src/crash.js): off without a DSN; with one, only 5xx errors and crashes are sent, with
// the request id, method, route and user id, and nothing private. A fake transport keeps every event here: no test
// ever talks to Sentry.
const { EventEmitter } = require('events')
const http = require('http')
const https = require('https')
const pool = require('../src/db')
const sentry = require('../src/sentry')
const { installCrashHandlers } = require('../src/crash')
const { captureLogs } = require('../src/logger')
const { api, auth, createUser, loginAs, resetData } = require('./helpers')

const FAKE_DSN = 'https://publickey@o0.ingest.sentry.invalid/1'

// Every envelope the SDK would have sent, as parsed events
let events = []
function fakeTransport(options) {
  const { createTransport } = require('@sentry/node')
  return createTransport(options, async (request) => {
    const body = typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf8')
    const lines = body.split('\n').filter(Boolean)
    for (let i = 1; i < lines.length; i += 2) {
      const item = JSON.parse(lines[i])
      if (item.type === 'event') events.push(JSON.parse(lines[i + 1]))
    }
    return { statusCode: 200 }
  })
}

// Makes the next query that matches `pattern` fail with `message`; all other queries run normally
function failQuery(pattern, message) {
  const query = pool.query.bind(pool)
  let failed = false
  return jest.spyOn(pool, 'query').mockImplementation((sql, ...rest) => {
    if (!failed && pattern.test(String(sql))) {
      failed = true
      return Promise.reject(new Error(message))
    }
    return query(sql, ...rest)
  })
}

beforeEach(async () => {
  await resetData()
  events = []
})
afterEach(() => jest.restoreAllMocks())

describe('off without SENTRY_DSN', () => {
  test('not started: no DSN, or a blank one', () => {
    expect(sentry.initSentry({})).toBe(false)
    expect(sentry.initSentry({ SENTRY_DSN: '   ' })).toBe(false)
    expect(sentry.isSentryOn()).toBe(false)
  })

  test('a 500 sends nothing and opens no connection', async () => {
    // supertest itself talks to the app over http on 127.0.0.1; anything else would be Sentry
    const outside = (args) =>
      !/127\.0\.0\.1|localhost|::1/.test(JSON.stringify(args.map((a) => (a instanceof URL ? a.href : a))))
    const requests = [jest.spyOn(http, 'request'), jest.spyOn(https, 'request')]
    const user = await createUser()
    const session = await loginAs(user)
    failQuery(/FROM tickets/i, 'database down')

    const res = await api.get('/api/tickets').set(auth(session))

    expect(res.status).toBe(500)
    expect(sentry.captureServerError(new Error('x'), { method: 'GET' })).toBeUndefined()
    expect(await sentry.flushSentry()).toBe(true)
    expect(events).toEqual([])
    expect(requests[1]).not.toHaveBeenCalled() // no https at all
    expect(requests[0].mock.calls.filter(outside)).toEqual([])
  })
})

describe('on, with a fake transport', () => {
  beforeAll(() => {
    expect(sentry.initSentry({ SENTRY_DSN: FAKE_DSN, NODE_ENV: 'test' }, { transport: fakeTransport })).toBe(true)
  })
  afterAll(() => sentry.closeSentry())

  const sent = async () => {
    await sentry.flushSentry()
    return events
  }

  test('a 500 is sent with the request id (also the event id), method, route, user id, environment and release', async () => {
    const user = await createUser()
    const session = await loginAs(user)
    failQuery(/FROM tickets/i, 'connect ECONNREFUSED')

    const res = await api.get('/api/tickets').set(auth(session))

    const id = res.headers['x-request-id']
    expect(res.status).toBe(500)
    expect(res.body.message).toBe(`Something went wrong (reference: ${id})`)
    const [event, ...more] = await sent()
    expect(more).toEqual([])
    expect(event.event_id).toBe(id.replace(/-/g, ''))
    expect(event.tags).toEqual({
      kind: 'server-error',
      request_id: id,
      method: 'GET',
      route: '/api/tickets',
      status: '500',
    })
    expect(event.user).toEqual({ id: String(user.id) })
    expect(event.environment).toBe('test')
    expect(event.release).toBe(sentry.DEFAULT_RELEASE)
    expect(event.release).toMatch(/^ticketflow-backend@\d+\.\d+\.\d+$/)
    expect(event.exception.values[0]).toMatchObject({ type: 'Error', value: 'connect ECONNREFUSED' })
    expect(event.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0)
  })

  test('the route is the pattern, not the path with its ids', async () => {
    const user = await createUser()
    const session = await loginAs(user)
    failQuery(/FROM tickets/i, 'boom')

    await api.get('/api/tickets/12345').set(auth(session))

    const [event] = await sent()
    expect(event.tags.route).toBe('/api/tickets/:id')
  })

  test('4xx is never sent: 400, 401, 403, 404, 422', async () => {
    const employee = await createUser()
    const session = await loginAs(employee)
    await api.post('/api/auth/login').set('Content-Type', 'application/json').send('{"broken": ') // 400
    await api.get('/api/tickets') // 401
    await api.get('/api/users').set(auth(session)) // 403
    await api.get('/api/no-such-route') // 404
    await api.post('/api/auth/forgot-password').send({ email: 'not-an-email' }) // 422
    expect(await sent()).toEqual([])
  })

  test('PRIVACY: no cookie, Authorization, body, query value, email, name, IP, password, token, link or temporary password', async () => {
    const user = await createUser({ name: 'Private Person-Name', email: 'private.person@example.org' })
    const session = await loginAs(user)
    const secrets = {
      session,
      csrf: 'test-csrf-token',
      bearer: 'bearer-SECRET-9f8e7d',
      bodyTitle: 'Body-Title-SECRET-1a2b',
      bodyText: 'Body-Description-SECRET-3c4d',
      queryValue: 'query-SECRET-5e6f',
      name: 'Private Person-Name',
      email: 'private.person@example.org',
      messageEmail: 'someone.else@example.com',
      ipv4: '10.1.2.3',
      ipv6: 'fe80::1ff:fe23:4567:890a',
      password: 'Password-SECRET-7a8b',
      token: 'tok-SECRET-0123456789abcdef',
      temporaryPassword: 'Temp-SECRET-c0ffee',
    }
    // An error whose message mentions all of it, as a careless library might
    failQuery(
      /INSERT INTO tickets/i,
      `insert failed for ${secrets.messageEmail} from ${secrets.ipv4} / ${secrets.ipv6}: password=${secrets.password} ` +
        `link https://helpdesk.example.com/set-password?token=${secrets.token} temporary_password: ${secrets.temporaryPassword} ` +
        `Authorization: Bearer ${secrets.bearer}`,
    )

    const [[category]] = await pool.query('SELECT id FROM categories ORDER BY id LIMIT 1')
    const res = await api
      .post(`/api/tickets?search=${secrets.queryValue}&email=${encodeURIComponent(secrets.email)}`)
      .set(auth(session))
      .set('Authorization', `Bearer ${secrets.bearer}`)
      .set('X-Forwarded-For', secrets.ipv4)
      .send({
        title: secrets.bodyTitle,
        description: secrets.bodyText,
        category_id: category.id,
      })

    expect(res.status).toBe(500)
    // A login that crashes: the password is in the body, the email too
    jest.restoreAllMocks()
    failQuery(/FROM users/i, 'database down')
    const login = await api
      .post('/api/auth/login')
      .set('Cookie', `tf_session=${session}`)
      .send({ email: secrets.email, password: secrets.password })
    expect(login.status).toBe(500)

    const [event, loginEvent, ...more] = await sent()
    expect(more).toEqual([])
    expect(loginEvent.tags).toMatchObject({ method: 'POST', route: '/api/auth/login' })
    const text = JSON.stringify([event, loginEvent])
    for (const [name, value] of Object.entries(secrets)) {
      expect({ name, found: text.includes(value) }).toEqual({ name, found: false })
    }
    // The client's own address (supertest: 127.0.0.1 / ::ffff:127.0.0.1) isn't there either
    expect(text).not.toMatch(/127\.0\.0\.1/)
    // ... and the event is still useful: what failed, where, for which request and user id
    expect(event.exception.values[0].value).toBe(
      'insert failed for [email] from [ip] / [ip]: password=[redacted] link https://helpdesk.example.com/set-password?[redacted] ' +
        'temporary_password: [redacted] Authorization: [redacted] [redacted]',
    )
    // No request data at all beyond what scrubEvent allows (method and route)
    expect(Object.keys(event.request ?? {}).filter((key) => !['method', 'url'].includes(key))).toEqual([])
    expect(event.tags).toMatchObject({ method: 'POST', route: '/api/tickets' })
    expect(event.tags.request_id).toBe(res.headers['x-request-id'])
    expect(event.user).toEqual({ id: String(user.id) })
    expect(event).not.toHaveProperty('breadcrumbs')
    expect(event).not.toHaveProperty('extra')
    expect(event.server_name).toBe('ticketflow-api')
  })

  test('a crash (uncaught exception, unhandled rejection) is logged, sent with its kind, then the process exits 1', async () => {
    const proc = new EventEmitter()
    const exit = jest.fn()
    const logs = captureLogs()
    const remove = installCrashHandlers({ proc, exit, flushMs: 1000 })
    try {
      await proc.listeners('uncaughtException')[0](new Error('crash for private.person@example.org'))
      expect(exit).toHaveBeenCalledWith(1)
      const [event] = await sent()
      expect(event.tags).toEqual({ kind: 'uncaughtException' })
      expect(event.exception.values[0].value).toBe('crash for [email]')
      expect(event).not.toHaveProperty('user')
      expect(logs.lines).toEqual([
        expect.objectContaining({ level: 'fatal', msg: 'uncaughtException: crash for private.person@example.org' }),
      ])
    } finally {
      remove()
      logs.restore()
    }
    expect(proc.listenerCount('uncaughtException')).toBe(0)
  })

  test('an unhandled rejection with a non-Error reason is sent too; a second crash only adds a log line', async () => {
    const proc = new EventEmitter()
    const exit = jest.fn()
    const logs = captureLogs()
    const remove = installCrashHandlers({ proc, exit, flushMs: 1000 })
    try {
      const first = proc.listeners('unhandledRejection')[0]('just a string')
      proc.listeners('uncaughtException')[0](new Error('second'))
      await first
      expect(exit).toHaveBeenCalledTimes(1)
      const sentEvents = await sent()
      expect(sentEvents).toHaveLength(1)
      expect(sentEvents[0].tags).toEqual({ kind: 'unhandledRejection' })
      expect(sentEvents[0].exception.values[0].value).toBe('just a string')
      expect(logs.lines.map((line) => line.level)).toEqual(['fatal', 'fatal'])
    } finally {
      remove()
      logs.restore()
    }
  })
})

describe('helpers', () => {
  test('eventIdFor: a UUID becomes a Sentry event id; anything else is left to Sentry', () => {
    expect(sentry.eventIdFor('9B2F6C1E-3D4A-4F8E-B1C2-7A5D0E9F4C21')).toBe('9b2f6c1e3d4a4f8eb1c27a5d0e9f4c21')
    expect(sentry.eventIdFor('demo-req-42')).toBeUndefined()
    expect(sentry.eventIdFor(undefined)).toBeUndefined()
  })

  test('scrubText masks emails, IPs, secrets, bearer tokens and query strings; leaves the rest', () => {
    expect(sentry.scrubText("Duplicate entry 'a.b@example.com' for key 'users.email'")).toBe(
      "Duplicate entry '[email]' for key 'users.email'",
    )
    expect(sentry.scrubText('connect ECONNREFUSED 10.0.0.5:3306')).toBe('connect ECONNREFUSED [ip]:3306')
    expect(sentry.scrubText('{"password":"hunter2","token": "abc"}')).toBe(
      '{"password":"[redacted]","token": "[redacted]"}',
    )
    expect(sentry.scrubText('GET /x?token=abc&page=2 failed')).toBe('GET /x?[redacted] failed')
    expect(sentry.scrubText('temporary_password: Temp-1 new_password=N-2 reset_token="R-3" JWT_SECRET=J-4')).toBe(
      'temporary_password: [redacted] new_password=[redacted] reset_token="[redacted]" JWT_SECRET=[redacted]',
    )
    expect(sentry.scrubText('from fe80::1ff:fe23:4567:890a and ::ffff:10.0.0.5 and 2001:db8:0:0:0:0:2:1')).toBe(
      'from [ip] and [ip] and [ip]',
    )
    expect(sentry.scrubText('at 10:30 in Foo::bar')).toBe('at 10:30 in Foo::bar')
    expect(sentry.scrubText('peer fe80::1: closed')).toBe('peer [ip]: closed')
    expect(sentry.scrubText('Unknown column in field list')).toBe('Unknown column in field list')
    expect(sentry.scrubText(undefined)).toBeUndefined()
  })

  test('scrubEvent keeps only the allowed tags, contexts and the user id', () => {
    const event = sentry.scrubEvent({
      request: {
        method: 'GET',
        url: 'http://x/api?token=1',
        headers: { cookie: 'c' },
        data: 'body',
        query_string: 'a=1',
      },
      user: { id: 7, email: 'e@example.com', ip_address: '1.2.3.4', username: 'n' },
      tags: { route: '/api/x', request_id: 'r1', other: 'secret' },
      contexts: { runtime: { name: 'node' }, culture: { locale: 'hu' }, custom: { email: 'e@example.com' } },
      breadcrumbs: [{ message: 'm' }],
      extra: { body: 'b' },
      modules: { express: '5' },
      message: 'for e@example.com',
      exception: {
        values: [{ value: 'v', stacktrace: { frames: [{ vars: { password: 'p' }, context_line: 'x?token=1' }] } }],
      },
    })
    expect(event).toEqual({
      request: { method: 'GET', url: '/api/x' },
      user: { id: '7' },
      tags: { route: '/api/x', request_id: 'r1' },
      contexts: { runtime: { name: 'node' } },
      message: 'for [email]',
      exception: { values: [{ value: 'v', stacktrace: { frames: [{ context_line: 'x?[redacted]' }] } }] },
    })
    expect(sentry.scrubEvent({ user: { email: 'e@example.com' } }).user).toBeUndefined()
  })
})

describe('settings and edge cases', () => {
  afterEach(() => sentry.closeSentry())

  test('SENTRY_ENVIRONMENT and SENTRY_RELEASE are used; without NODE_ENV the environment is development', async () => {
    sentry.initSentry(
      { SENTRY_DSN: FAKE_DSN, SENTRY_ENVIRONMENT: ' staging ', SENTRY_RELEASE: 'ticketflow-backend@1a2b3c4' },
      { transport: fakeTransport },
    )
    const options = require('@sentry/node').getClient().getOptions()
    expect([options.environment, options.release, options.sendDefaultPii]).toEqual([
      'staging',
      'ticketflow-backend@1a2b3c4',
      false,
    ])
    await sentry.closeSentry()
    sentry.initSentry({ SENTRY_DSN: FAKE_DSN }, { transport: fakeTransport })
    expect(require('@sentry/node').getClient().getOptions().environment).toBe('development')
    expect(sentry.isSentryOn()).toBe(true)
  })

  test('a 5xx outside a request (no id, no user, only a url) and a crash with no reason', async () => {
    sentry.initSentry({ SENTRY_DSN: FAKE_DSN, NODE_ENV: 'test' }, { transport: fakeTransport })
    sentry.captureServerError(new Error('no request id'), { method: 'GET', url: '/api/tickets/42?token=abc' }, 503)
    sentry.captureServerError(new Error('nothing at all'), {})
    sentry.captureCrash(undefined, 'unhandledRejection')
    await sentry.flushSentry()
    const [first, second, third] = events
    expect(first.tags).toEqual({ kind: 'server-error', method: 'GET', route: '/api/tickets/:id', status: '503' })
    expect(first).not.toHaveProperty('user')
    expect(first.event_id).toMatch(/^[0-9a-f]{32}$/)
    expect(second.tags).toMatchObject({ route: '', status: '500' })
    expect(third.exception.values[0].value).toBe('undefined')
  })

  test('closeSentry and flushSentry do nothing when it is off', async () => {
    await sentry.closeSentry()
    expect(sentry.isSentryOn()).toBe(false)
    expect(sentry.captureCrash(new Error('x'), 'uncaughtException')).toBeUndefined()
    expect(await sentry.flushSentry()).toBe(true)
  })

  test('scrubEvent: log messages and code context are masked; an event with nothing extra stays as it is', () => {
    const event = sentry.scrubEvent({
      logentry: { message: 'mail to a@example.com' },
      exception: {
        values: [
          {
            value: 'v',
            stacktrace: { frames: [{ pre_context: ['token=abc'], post_context: ['ip 10.0.0.1'], filename: 'f.js' }] },
          },
          { value: 'no stack' },
        ],
      },
    })
    expect(event.logentry.message).toBe('mail to [email]')
    expect(event.exception.values[0].stacktrace.frames[0]).toEqual({
      pre_context: ['token=[redacted]'],
      post_context: ['ip [ip]'],
      filename: 'f.js',
    })
    expect(sentry.scrubEvent({ message: 'plain' })).toEqual({ message: 'plain', user: undefined })
    expect(sentry.scrubEvent({ request: { method: 'GET', url: '/x?y=1' } }).request).toEqual({ method: 'GET' })
  })

  test('the crash handlers with their defaults attach to the real process, and come off again', () => {
    const before = process.listenerCount('uncaughtException')
    const remove = installCrashHandlers()
    expect(process.listenerCount('uncaughtException')).toBe(before + 1)
    remove()
    expect(process.listenerCount('uncaughtException')).toBe(before)
  })
})
