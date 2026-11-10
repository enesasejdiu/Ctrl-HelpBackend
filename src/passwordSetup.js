// Set-password links for new accounts (migrations/008): POST /api/users and POST /api/users/:id/resend-invite issue a
// token, the user opens {APP_URL}/set-password?token=..., and POST /api/auth/set-password uses it up.
//
// - The token is 32 random bytes from crypto.randomBytes (base64url, 43 characters). Only its SHA-256 hash is stored:
//   the database alone can't produce a working link. (A plain hash is enough, unlike for passwords: the token is
//   random and long, so there is nothing to guess.)
// - It expires INVITE_HOURS after it was issued and works once. Expiry uses the API's clock (Date.now), so tests can
//   fake the time.
// - Issuing a new token removes the user's unused ones, so only the newest link works.
const bcrypt = require('bcryptjs')
const crypto = require('crypto')

const TOKEN_BYTES = 32
const INVITE_HOURS = 72

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex')

// A password hash nobody knows the password for: a new account can't be logged into until its owner sets a password
// with the link (login then fails with the usual "Wrong email or password")
async function unusablePasswordHash() {
  return bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10)
}

// Issues a new token for the user, on `db` (a pool or a connection inside the caller's transaction).
// Returns { token, expiresAt }; the plain token exists only here and in the email.
async function issueToken(db, userId) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITE_HOURS * 60 * 60 * 1000)
  await db.query('DELETE FROM password_setup_tokens WHERE user_id = ? AND used_at IS NULL', [userId])
  await db.query('INSERT INTO password_setup_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)', [
    userId,
    hashToken(token),
    expiresAt,
  ])
  return { token, expiresAt }
}

// Finds the token's row (and its user) and says what state it is in: 'valid', 'expired', 'used' or 'invalid'
// (unknown, replaced by a newer link, or the account is deactivated). With forUpdate, locks the row until the
// caller's transaction ends, so two requests with the same link can't both use it.
async function lookUpToken(db, token, { forUpdate = false } = {}) {
  const [rows] = await db.query(
    `SELECT t.id, t.user_id, t.expires_at, t.used_at, u.name, u.email, u.is_active
     FROM password_setup_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [hashToken(token)],
  )
  const row = rows[0]
  if (!row || !row.is_active) return { status: 'invalid', row: null }
  if (row.used_at) return { status: 'used', row }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { status: 'expired', row }
  return { status: 'valid', row }
}

module.exports = { issueToken, lookUpToken, hashToken, unusablePasswordHash, INVITE_HOURS, TOKEN_BYTES }
