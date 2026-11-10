// Rate limit for POST /api/auth/login: at most LOGIN_LIMIT requests per IP address in LOGIN_WINDOW_MS, then 429.
// Every attempt counts, right or wrong. It slows down password guessing across many accounts from one address; the
// per-account lockout in routes/auth.js covers guessing one account's password.
// Off in the test suite (NODE_ENV=test), where hundreds of logins come from one address, except in the test that sets
// RATE_LIMIT_IN_TESTS=1 to check it. The counts live in memory, so a restart clears them.
const { rateLimit } = require('express-rate-limit')

const LOGIN_LIMIT = 20
const LOGIN_WINDOW_MS = 15 * 60 * 1000

const loginRateLimit = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: LOGIN_LIMIT,
  standardHeaders: 'draft-8', // RateLimit-Policy / RateLimit headers, and Retry-After on a 429
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_IN_TESTS !== '1',
  handler: (req, res) => {
    res.status(429).json({
      message: 'Too many login attempts. Wait a few minutes and try again.',
      code: 'RATE_LIMITED',
    })
  },
})

module.exports = { loginRateLimit, LOGIN_LIMIT, LOGIN_WINDOW_MS }
