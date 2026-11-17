// The search suggestions' rate limit (middleware/rateLimit.js): 30 requests a minute per user on
// GET /api/search/suggestions, then 429 RATE_LIMITED. Counted per user, not per address. It's off for the rest of the
// suite (NODE_ENV=test); this file turns it on. Jest gives every test file its own copy of the app, so the counts here
// start at 0.
const { api, createUser, loginAs, auth, resetData } = require('./helpers')
const { SUGGESTIONS_LIMIT, SUGGESTIONS_WINDOW_MS } = require('../src/middleware/rateLimit')

beforeAll(() => {
  process.env.RATE_LIMIT_IN_TESTS = '1'
})
afterAll(() => {
  delete process.env.RATE_LIMIT_IN_TESTS
})

test('30 requests a minute go through, the 31st gets 429; another user is not affected', async () => {
  expect(SUGGESTIONS_LIMIT).toBe(30)
  expect(SUGGESTIONS_WINDOW_MS).toBe(60_000)
  await resetData()
  const first = await loginAs(await createUser({ role: 'employee' }))
  const second = await loginAs(await createUser({ role: 'employee' }))
  const ask = (session) => api.get('/api/search/suggestions?q=printer').set(auth(session))

  for (let i = 0; i < SUGGESTIONS_LIMIT; i += 1) {
    expect((await ask(first)).status).toBe(200)
  }
  const limited = await ask(first)
  expect(limited.status).toBe(429)
  expect(limited.body).toEqual({ message: 'Too many searches. Wait a minute and try again.', code: 'RATE_LIMITED' })
  expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)

  // Same address, different user: their own count
  expect((await ask(second)).status).toBe(200)
})
