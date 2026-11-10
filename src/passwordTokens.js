// One-time password links (the password_tokens table, migrations 010 and 011), used when email is set up
// (isEmailConfigured() in src/mail/mailer.js). Two purposes:
//   setup  a new account sets its first password (POST /api/users)
//   reset  an admin or HR reset the password (POST /api/users/:id/reset-password)
// The person opens {APP_URL}/set-password?token=..., and POST /api/auth/set-password uses the token up.
//
// - The token is 32 random bytes from crypto.randomBytes, base64url (43 URL-safe characters). Only its SHA-256 hash
//   is stored and looked up: the database alone can't produce a working link. (A plain hash is enough, unlike for
//   passwords: the token is random and long, so there is nothing to guess.)
// - It expires TOKEN_HOURS after it was issued and works once (used_at). Expiry uses the API's clock (Date.now), so
//   tests can fake the time.
// - Issuing a new token removes the user's other unused ones (of either purpose), so only the newest link works.
// - Tokens and links are never logged.
const bcrypt = require('bcryptjs')
const crypto = require('crypto')

const TOKEN_BYTES = 32
const TOKEN_HOURS = 48
const PURPOSES = ['setup', 'reset']

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
  const expiresAt = new Date(Date.now() + TOKEN_HOURS * 60 * 60 * 1000)
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

module.exports = {
  issueToken,
  lookUpToken,
  latestPurpose,
  hashToken,
  unusablePasswordHash,
  TOKEN_HOURS,
  TOKEN_BYTES,
  PURPOSES,
}
