// One-time password links (the password_tokens table, migrations 010 and 011), used when email is set up
// (isEmailConfigured() in src/mail/mailer.js). Two purposes:
//   setup  a new account sets its first password (POST /api/users)
//   reset  an admin or HR reset the password (POST /api/users/:id/reset-password)
//   forgot the user asked for it with "Forgot password" (POST /api/auth/forgot-password); lasts only 1 hour
// The person opens {APP_URL}/set-password?token=..., and POST /api/auth/set-password uses the token up.
//
// - The token is 32 random bytes from crypto.randomBytes, base64url (43 URL-safe characters). Only its SHA-256 hash
//   is stored and looked up: the database alone can't produce a working link. (A plain hash is enough, unlike for
//   passwords: the token is random and long, so there is nothing to guess.)
// - It expires after its purpose's lifetime (TOKEN_MINUTES: 48 hours, "forgot" 1 hour) and works once (used_at). Expiry uses the API's clock (Date.now), so
//   tests can fake the time.
// - Issuing a new token removes the user's other unused ones (of either purpose), so only the newest link works.
// - Tokens and links are never logged.
// - Used and expired tokens are deleted KEEP_ENDED_DAYS later (cleanupPasswordTokens: on start, then once a day, and
//   npm run db:password-tokens:cleanup).
const bcrypt = require('bcryptjs')
const crypto = require('crypto')

const TOKEN_BYTES = 32
const TOKEN_HOURS = 48 // setup and reset links
const FORGOT_TOKEN_MINUTES = 60 // "Forgot password" links: anyone can ask for one, so they expire sooner
const TOKEN_MINUTES = { setup: TOKEN_HOURS * 60, reset: TOKEN_HOURS * 60, forgot: FORGOT_TOKEN_MINUTES }
const PURPOSES = Object.keys(TOKEN_MINUTES)
const KEEP_ENDED_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex')

// A password hash nobody knows the password for: the account can't be logged into until its owner sets a password
// with the link (login then fails with the usual "Wrong email or password")
async function unusablePasswordHash() {
  return bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10)
}

// Issues a new token for the user, on `db` (a pool or a connection inside the caller's transaction).
// Returns { token, expiresAt }; the plain token exists only here and in the email.
async function issueToken(db, userId, purpose) {
  if (!PURPOSES.includes(purpose)) throw new Error(`Unknown token purpose: ${purpose}`)
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + TOKEN_MINUTES[purpose] * 60 * 1000)
  await db.query('DELETE FROM password_tokens WHERE user_id = ? AND used_at IS NULL', [userId])
  await db.query('INSERT INTO password_tokens (user_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, ?)', [
    userId,
    hashToken(token),
    purpose,
    expiresAt,
  ])
  return { token, expiresAt }
}

// Finds the token's row (and its user) and says what state it is in: 'valid', 'expired', 'used' or 'invalid'
// (unknown, replaced by a newer link, or the account is deactivated). An unknown token and a deactivated account look
// exactly the same, and both take one indexed lookup. With forUpdate, locks the row until the caller's transaction
// ends, so two requests with the same link can't both use it.
async function lookUpToken(db, token, { forUpdate = false } = {}) {
  const [rows] = await db.query(
    `SELECT t.id, t.user_id, t.purpose, t.expires_at, t.used_at, u.name, u.email, u.is_active
     FROM password_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [hashToken(token)],
  )
  const row = rows[0]
  if (!row || !row.is_active) return { status: 'invalid', row: null }
  if (row.used_at) return { status: 'used', row }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { status: 'expired', row }
  return { status: 'valid', row }
}

// The purpose of the user's newest token, or null (for resend: send the same kind of link again)
async function latestPurpose(db, userId) {
  const [[row]] = await db.query('SELECT purpose FROM password_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1', [
    userId,
  ])
  return row?.purpose ?? null
}

// Deletes tokens used or expired more than KEEP_ENDED_DAYS ago (both times are the API's clock, like expiry). Unused,
// unexpired links are never touched. Returns how many were deleted.
async function cleanupPasswordTokens(db) {
  const cutoff = new Date(Date.now() - KEEP_ENDED_DAYS * DAY_MS)
  const [result] = await db.query(
    'DELETE FROM password_tokens WHERE (used_at IS NOT NULL AND used_at < ?) OR expires_at < ?',
    [cutoff, cutoff],
  )
  return result.affectedRows
}

// Runs cleanupPasswordTokens now, then every `everyMs` (a day), like the session cleanup. The timer is unref()'d, so it
// never keeps the process alive on its own; a failure is only logged. Returns the timer.
function startPasswordTokenCleanup(db, { everyMs = DAY_MS, log = console } = {}) {
  const run = () =>
    cleanupPasswordTokens(db)
      .then((deleted) => {
        if (deleted > 0)
          log.log(`Password link cleanup: deleted ${deleted} links used or expired over ${KEEP_ENDED_DAYS} days ago`)
      })
      .catch((err) => log.error(`Password link cleanup failed: ${err.message}`, err))
  run()
  return setInterval(run, everyMs).unref()
}

module.exports = {
  cleanupPasswordTokens,
  startPasswordTokenCleanup,
  KEEP_ENDED_DAYS,
  issueToken,
  lookUpToken,
  latestPurpose,
  hashToken,
  unusablePasswordHash,
  TOKEN_HOURS,
  FORGOT_TOKEN_MINUTES,
  TOKEN_MINUTES,
  TOKEN_BYTES,
  PURPOSES,
}
