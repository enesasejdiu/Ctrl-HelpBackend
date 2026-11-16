// The login rate limit (middleware/rateLimit.js): 20 failed attempts per IP per 15 minutes on POST /api/auth/login,
// then 429. Successful logins don't count. It's off for the rest of the suite (NODE_ENV=test); this file turns it on.
// Jest gives every test file its own copy of the app, so the counts here start at 0 and don't affect other files.
const { api, createUser, resetData } = require('./helpers')
const { LOGIN_LIMIT } = require('../src/middleware/rateLimit')

const attempt = () => api.post('/api/auth/login').send({ email: 'nobody.here@test.local', password: 'wrong-password1' })

beforeAll(() => {
  process.env.RATE_LIMIT_IN_TESTS = '1'
})
afterAll(() => {
  delete process.env.RATE_LIMIT_IN_TESTS
})

describe('login rate limit', () => {
  // One test, in order: the counts carry on from step to step within the window
  test('successful logins never count; 20 failed attempts go through, the 21st gets 429 RATE_LIMITED', async () => {
    expect(LOGIN_LIMIT).toBe(20)
    await resetData()
    const user = await createUser()

    // 30 people signing in from one address (an office behind NAT): all get in, none of it counts
    for (let i = 0; i < 30; i += 1) {
      const res = await api.post('/api/auth/login').send({ email: user.email, password: user.password })
      expect(res.status).toBe(200)
    }

    // Failures do count: 20 go through (401), then 429 with Retry-After
    for (let i = 0; i < LOGIN_LIMIT; i += 1) {
      expect((await attempt()).status).toBe(401)
    }
    const limited = await attempt()
    expect(limited.status).toBe(429)
    expect(limited.body).toEqual({
      message: 'Too many login attempts. Wait a few minutes and try again.',
      code: 'RATE_LIMITED',
    })
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    // Once limited, even the right password and a valid-looking request wait, before the body is checked
    expect((await api.post('/api/auth/login').send({ email: user.email, password: user.password })).status).toBe(429)
    expect((await api.post('/api/auth/login').send({})).status).toBe(429)
  })

  test('only login is limited: other routes still answer normally', async () => {
    expect((await api.get('/api/health')).status).toBe(200)
    expect((await api.get('/api/auth/me')).status).toBe(401)
  })
})
