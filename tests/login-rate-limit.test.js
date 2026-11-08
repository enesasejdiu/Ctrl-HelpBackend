// The login rate limit (middleware/rateLimit.js): 20 requests per IP per 15 minutes on POST /api/auth/login, then 429.
// It's off for the rest of the suite (NODE_ENV=test); this file turns it on. Jest gives every test file its own copy of
// the app, so the counts here start at 0 and don't affect other files.
const { api } = require('./helpers');
const { LOGIN_LIMIT } = require('../src/middleware/rateLimit');

const attempt = () => api.post('/api/auth/login').send({ email: 'nobody.here@test.local', password: 'wrong-password1' });

beforeAll(() => {
  process.env.RATE_LIMIT_IN_TESTS = '1';
});
afterAll(() => {
  delete process.env.RATE_LIMIT_IN_TESTS;
});

describe('login rate limit', () => {
  test('the first 20 requests go through; the 21st gets 429 RATE_LIMITED with Retry-After', async () => {
    expect(LOGIN_LIMIT).toBe(20);
    for (let i = 0; i < LOGIN_LIMIT; i += 1) {
      const res = await attempt();
      expect(res.status).toBe(401);
    }

    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      message: 'Too many login attempts. Wait a few minutes and try again.',
      code: 'RATE_LIMITED',
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Even a valid-looking request is refused before the body is checked
    expect((await api.post('/api/auth/login').send({})).status).toBe(429);
  });

  test('only login is limited: other routes still answer normally', async () => {
    expect((await api.get('/api/health')).status).toBe(200);
    expect((await api.get('/api/auth/me')).status).toBe(401);
  });
});
