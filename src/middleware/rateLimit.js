// Rate limits for the routes anyone can call without logging in, per IP address (and, for "Forgot password", the
// per-account email limit too: every limit lives here). The counts live in memory, so a
// restart clears them.
//   loginRateLimit        POST /api/auth/login: at most LOGIN_LIMIT requests in LOGIN_WINDOW_MS, then 429. Every
//                         attempt counts, right or wrong. It slows down password guessing across many accounts from
//                         one address; the per-account lockout in routes/auth.js covers guessing one account's password.
//   forgotPasswordRateLimit  POST /api/auth/forgot-password: at most FORGOT_PASSWORD_LIMIT requests in the same
//                         window, then 429 with Retry-After (that says nothing about whether an account exists). Each
//                         account also gets at most FORGOT_PASSWORD_EMAIL_LIMIT emails per FORGOT_PASSWORD_EMAIL_WINDOW_MINUTES;
//                         over that the answer stays the same 200 and no email is sent (src/mail/notifications.js).
//   setPasswordRateLimit  GET /api/auth/set-password/validate and POST /api/auth/set-password: at most
//                         SET_PASSWORD_LIMIT requests in the same window. The tokens are far too long to guess; this
//                         only keeps someone from hammering the endpoints.
// Off in the test suite (NODE_ENV=test), where hundreds of requests come from one address, except in the test that sets
// RATE_LIMIT_IN_TESTS=1 to check it.
const { rateLimit } = require('express-rate-limit')

const LOGIN_LIMIT = 20
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const SET_PASSWORD_LIMIT = 30
// "Forgot password": requests per IP address per window, and reset emails per account per hour
const FORGOT_PASSWORD_LIMIT = 5
const FORGOT_PASSWORD_EMAIL_LIMIT = 3
const FORGOT_PASSWORD_EMAIL_WINDOW_MINUTES = 60

function limiter(limit, message) {
  return rateLimit({
    windowMs: LOGIN_WINDOW_MS,
    limit,
    standardHeaders: 'draft-8', // RateLimit-Policy / RateLimit headers, and Retry-After on a 429
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_IN_TESTS !== '1',
    handler: (req, res) => {
      res.status(429).json({ message, code: 'RATE_LIMITED' })
    },
  })
}

const loginRateLimit = limiter(LOGIN_LIMIT, 'Too many login attempts. Wait a few minutes and try again.')
const setPasswordRateLimit = limiter(SET_PASSWORD_LIMIT, 'Too many attempts. Wait a few minutes and try again.')
const forgotPasswordRateLimit = limiter(FORGOT_PASSWORD_LIMIT, 'Too many requests. Wait a few minutes and try again.')

module.exports = {
  loginRateLimit,
  setPasswordRateLimit,
  forgotPasswordRateLimit,
  LOGIN_LIMIT,
  LOGIN_WINDOW_MS,
  SET_PASSWORD_LIMIT,
  FORGOT_PASSWORD_LIMIT,
  FORGOT_PASSWORD_EMAIL_LIMIT,
  FORGOT_PASSWORD_EMAIL_WINDOW_MINUTES,
}
