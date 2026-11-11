// How long a lockout lasts (5 wrong passwords in a row lock the account; see POST /api/auth/login).
// Always 15 minutes, except in the test environment (NODE_ENV=test), where LOCKOUT_MINUTES may shorten it so end-to-end
// tests can watch a lock run out. Anywhere else LOCKOUT_MINUTES is ignored here, and src/config.js refuses to start the
// server with a value other than 15. Read on every call, so tests can change it.
const DEFAULT_LOCKOUT_MINUTES = 15
const MAX_LOCKOUT_MINUTES = 24 * 60

// A valid LOCKOUT_MINUTES value as a number, or null: a whole number of minutes from 1 to a day
function parseLockoutMinutes(value) {
  if (value === undefined || value === '') return null
  const minutes = Number(value)
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_LOCKOUT_MINUTES ? minutes : null
}

function lockoutMinutes(env = process.env) {
  if (env.NODE_ENV !== 'test') return DEFAULT_LOCKOUT_MINUTES
  return parseLockoutMinutes(env.LOCKOUT_MINUTES) ?? DEFAULT_LOCKOUT_MINUTES
}

module.exports = { lockoutMinutes, parseLockoutMinutes, DEFAULT_LOCKOUT_MINUTES, MAX_LOCKOUT_MINUTES }
