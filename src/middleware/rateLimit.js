// Rate limits for the routes anyone can call without logging in, per IP address (and, for "Forgot password", the
// per-account email limit too: every limit lives here). The counts live in memory, so a
// restart clears them.
//   loginRateLimit        POST /api/auth/login: at most LOGIN_LIMIT failed attempts in LOGIN_WINDOW_MS, then 429.
//                         Only failures count (wrong password, unknown or locked account, invalid body): a successful
//                         login is not guessing, and counting it would lock out an office whose people all sign in
//                         from one address (NAT). It slows down password guessing across many accounts from one
//                         address; the per-account lockout in routes/auth.js covers guessing one account's password.
//   forgotPasswordRateLimit  POST /api/auth/forgot-password: at most FORGOT_PASSWORD_LIMIT requests in the same
//                         window, then 429 with Retry-After (that says nothing about whether an account exists). Each
//                         account also gets at most FORGOT_PASSWORD_EMAIL_LIMIT emails per FORGOT_PASSWORD_EMAIL_WINDOW_MINUTES;
//                         over that the answer stays the same 200 and no email is sent (src/mail/notifications.js).
//   setPasswordRateLimit  GET /api/auth/set-password/validate and POST /api/auth/set-password: at most
//                         SET_PASSWORD_LIMIT requests in the same window. The tokens are far too long to guess; this
//                         only keeps someone from hammering the endpoints.
//   suggestionsRateLimit  GET /api/search/suggestions (logged in): at most SUGGESTIONS_LIMIT requests per
//                         SUGGESTIONS_WINDOW_MS per user (not per address: a whole office can share one), then 429.
//                         The New ticket form asks once per pause in typing, far below this.
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
const SUGGESTIONS_LIMIT = 30
const SUGGESTIONS_WINDOW_MS = 60 * 1000

// windowMs and keyGenerator: the window, and what is counted (default: the client's IP address)
function limiter(limit, message, { skipSuccessfulRequests = false, windowMs = LOGIN_WINDOW_MS, keyGenerator } = {}) {
  return rateLimit({
    windowMs,
    limit,
    ...(keyGenerator ? { keyGenerator } : {}),
    // A response under 400 is taken off the count again
    skipSuccessfulRequests,
    standardHeaders: 'draft-8', // RateLimit-Policy / RateLimit headers, and Retry-After on a 429
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_IN_TESTS !== '1',
    handler: (req, res) => {
      res.status(429).json({ message, code: 'RATE_LIMITED' })
    },
  })
}

const loginRateLimit = limiter(LOGIN_LIMIT, 'Too many login attempts. Wait a few minutes and try again.', {
  skipSuccessfulRequests: true,
})
const setPasswordRateLimit = limiter(SET_PASSWORD_LIMIT, 'Too many attempts. Wait a few minutes and try again.')
const forgotPasswordRateLimit = limiter(FORGOT_PASSWORD_LIMIT, 'Too many requests. Wait a few minutes and try again.')
// Runs after requireAuth, so req.user is set
const suggestionsRateLimit = limiter(SUGGESTIONS_LIMIT, 'Too many searches. Wait a minute and try again.', {
  windowMs: SUGGESTIONS_WINDOW_MS,
  keyGenerator: (req) => `user:${req.user.id}`,
})

module.exports = {
  loginRateLimit,
  setPasswordRateLimit,
  forgotPasswordRateLimit,
  suggestionsRateLimit,
  LOGIN_LIMIT,
  LOGIN_WINDOW_MS,
  SET_PASSWORD_LIMIT,
  FORGOT_PASSWORD_LIMIT,
  FORGOT_PASSWORD_EMAIL_LIMIT,
  FORGOT_PASSWORD_EMAIL_WINDOW_MINUTES,
  SUGGESTIONS_LIMIT,
  SUGGESTIONS_WINDOW_MS,
}
