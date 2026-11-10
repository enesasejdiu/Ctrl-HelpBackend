// Authentication routes: login, logout, "who am I", change password, and setting a password with an emailed link.
// Mounted at /api/auth. A successful login sets the session cookies (tf_session with the token, httpOnly, and tf_csrf
// for the CSRF header; see src/session.js) and returns { user }. The token is never sent in a response body.
// There is no self-registration: admins and HR create accounts with POST /api/users, and the new user sets a password
// with the link from their email (the set-password routes at the end; public, no login needed).
const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const pool = require('../db')
const { HttpError } = require('../middleware/errors')
const { requireAuth } = require('../middleware/auth')
const { loginRateLimit, setPasswordRateLimit } = require('../middleware/rateLimit')
const { lookUpToken } = require('../passwordSetup')
const { SESSION_HOURS, SESSION_COOKIE, setSessionCookies, clearSessionCookies } = require('../session')
const { createSession, revokeSession, revokeUserSessions } = require('../sessionStore')
const validate = require('../middleware/validate')
const schemas = require('../schemas/auth')

const router = express.Router()

// Signed token identifying the user. requireAuth only trusts the id from it and reloads name/role from the DB;
// name and role are included so the frontend can show them without an extra request.
// sid is the server-side session (a sessions row, see src/sessionStore.js): requireAuth refuses the token once that row
// is revoked or expired. session_version must still match users.session_version too. Valid for 8 hours, the same as
// the session row and the cookie that carries it.
function makeToken(user, sid) {
  return jwt.sign(
    { id: user.id, name: user.name, role: user.role, session_version: user.session_version, sid },
    process.env.JWT_SECRET,
    { expiresIn: `${SESSION_HOURS}h` },
  )
}

// What these routes load about a user: the public fields, plus the password hash and active flag for the checks.
// The department comes from departments; the old free-text users.department is no longer read (see migrations/005).
const AUTH_USER_COLUMNS = `
  u.id, u.name, u.email, u.role, u.password_hash, u.is_active, u.must_change_password, u.session_version,
  u.department_id, d.name AS department_name, u.job_title, u.created_at, u.last_login_at`
const AUTH_USER_FROM = 'FROM users u LEFT JOIN departments d ON d.id = u.department_id'
const AUTH_USER_SELECT = `SELECT ${AUTH_USER_COLUMNS} ${AUTH_USER_FROM}`

// Lockout: this many wrong passwords in a row lock the account for LOCK_MINUTES (see POST /login below)
const MAX_FAILED_LOGINS = 5
const LOCK_MINUTES = 15

// The login query also reads the lockout state. lock_seconds_left is computed by the database, with the same clock that
// set locked_until: NULL = not locked, > 0 = still locked, <= 0 = the lock has run out.
const LOGIN_SELECT = `
  SELECT ${AUTH_USER_COLUMNS}, u.failed_login_count, TIMESTAMPDIFF(SECOND, NOW(), u.locked_until) AS lock_seconds_left
  ${AUTH_USER_FROM}`

// 423 for a locked account, with the minutes left (rounded up, at least 1) in the body and the seconds in Retry-After
function accountLocked(res, secondsLeft) {
  const minutes = Math.max(1, Math.ceil(secondsLeft / 60))
  res.set('Retry-After', String(Math.max(1, secondsLeft)))
  return new HttpError(
    423,
    `Too many wrong passwords. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
    'ACCOUNT_LOCKED',
    { retryAfterMinutes: minutes },
  )
}

// Counts a wrong password. Returns the lock's length in seconds if this attempt locked the account, otherwise null.
// The lockout columns are bookkeeping, not account changes, so these updates keep updated_at as it was.
async function recordWrongPassword(user) {
  const lockRanOut = user.lock_seconds_left !== null && user.lock_seconds_left <= 0
  if (lockRanOut) {
    // A lock that has run out is cleared, and this wrong password starts the count again at 1
    await pool.query(
      'UPDATE users SET failed_login_count = 1, locked_until = NULL, updated_at = updated_at WHERE id = ?',
      [user.id],
    )
    return null
  }
  // Two steps, each with one assignment, so the result doesn't depend on whether the database applies a statement's
  // assignments left to right (MySQL) or all at once (MariaDB's SIMULTANEOUS_ASSIGNMENT). The +1 is atomic, so
  // simultaneous wrong attempts are all counted.
  await pool.query(
    'UPDATE users SET failed_login_count = failed_login_count + 1, updated_at = updated_at WHERE id = ?',
    [user.id],
  )
  const [locked] = await pool.query(
    `UPDATE users SET locked_until = NOW() + INTERVAL ? MINUTE, updated_at = updated_at
     WHERE id = ? AND failed_login_count >= ? AND locked_until IS NULL`,
    [LOCK_MINUTES, user.id, MAX_FAILED_LOGINS],
  )
  return locked.affectedRows > 0 ? LOCK_MINUTES * 60 : null
}

// The only user shape ever sent to clients; password_hash is deliberately left out
function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    department_id: user.department_id,
    department_name: user.department_name,
    // null when not set (no job title yet, never logged in)
    job_title: user.job_title,
    created_at: user.created_at,
    last_login_at: user.last_login_at,
    // True for an account created by an admin or HR, until the user sets their own password
    must_change_password: Boolean(user.must_change_password),
  }
}

// POST /api/auth/login → { user }, and the session cookies (tf_session, httpOnly, and tf_csrf; see src/session.js)
// A user with a temporary password logs in normally; user.must_change_password tells the client to send them to the
// change-password screen, and requireAuth blocks everything else until they do.
// Limits: at most 20 requests per IP address per 15 minutes (429 RATE_LIMITED, middleware/rateLimit.js), and 5 wrong
// passwords in a row lock the account for 15 minutes (423 ACCOUNT_LOCKED, even with the right password). The lock
// ends by itself, after a successful login, or when an admin or HR resets the password.
router.post('/login', loginRateLimit, validate(schemas.login), async (req, res) => {
  const { email, password } = req.valid.body

  const [rows] = await pool.query(`${LOGIN_SELECT} WHERE u.email = ?`, [email])
  const user = rows[0]

  // Same message for unknown email and wrong password, so attackers can't probe which emails exist
  if (!user) {
    throw new HttpError(401, 'Wrong email or password')
  }
  // Locked: refused before the password is even checked, so guessing is pointless until the lock runs out
  if (user.lock_seconds_left > 0) {
    throw accountLocked(res, user.lock_seconds_left)
  }
  if (!(await bcrypt.compare(password, user.password_hash))) {
    const lockedFor = await recordWrongPassword(user)
    // The wrong password that locks the account already says so, instead of one more "wrong password"
    if (lockedFor) throw accountLocked(res, lockedFor)
    throw new HttpError(401, 'Wrong email or password')
  }
  if (!user.is_active) {
    throw new HttpError(403, 'This account is deactivated')
  }

  // Only a successful login counts; the failed attempts above never get here. It also clears the wrong-password count
  // and a lock that has run out. A login isn't a change to the account, so updated_at stays as it was.
  await pool.query(
    `UPDATE users SET last_login_at = CURRENT_TIMESTAMP, failed_login_count = 0, locked_until = NULL,
       updated_at = updated_at
     WHERE id = ?`,
    [user.id],
  )
  // Read back the stored value, so the user returned here matches what /me returns right after
  const [[{ last_login_at: lastLoginAt }]] = await pool.query('SELECT last_login_at FROM users WHERE id = ?', [user.id])

  const loggedIn = publicUser({ ...user, last_login_at: lastLoginAt })
  const sid = await createSession(user.id, req)
  setSessionCookies(res, makeToken(user, sid))
  res.json({ user: loggedIn })
})

// The session id from the request's cookie, if the token is genuine (signed by us). Expired tokens count too, so their
// row can still be revoked. A forged or garbled cookie gives null.
function sessionIdFromCookie(req) {
  const token = req.cookies?.[SESSION_COOKIE]
  if (!token) return null
  try {
    return jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true }).sid || null
  } catch {
    return null
  }
}

// POST /api/auth/logout → 204. Ends this browser's session on the server (revoked_at on its row, so even a copy of the
// token stops working), then clears both cookies. Needs no valid session: with an expired, revoked or missing one it
// only clears the cookies, and still answers 204. The user's other sessions keep working (see /logout-all).
// No CSRF check: the worst another site could do is log you out, and sameSite "lax" already keeps the cookies off
// cross-site POSTs.
router.post('/logout', async (req, res) => {
  const sid = sessionIdFromCookie(req)
  if (sid) await revokeSession(sid)
  clearSessionCookies(res)
  res.status(204).end()
})

// POST /api/auth/logout-all → 204 (logged in). "Log out everywhere": ends every session of this user, in every browser
// and device, this one included, and clears this browser's cookies.
router.post('/logout-all', requireAuth, async (req, res) => {
  await revokeUserSessions(req.user.id)
  clearSessionCookies(res)
  res.status(204).end()
})

// GET /api/auth/me: the logged-in user's profile (the frontend calls this on page load to restore the session)
router.get('/me', requireAuth, async (req, res) => {
  const [rows] = await pool.query(`${AUTH_USER_SELECT} WHERE u.id = ?`, [req.user.id])
  // Safety net: requireAuth already rejects deleted users, so this only triggers in a race with a delete
  if (rows.length === 0) {
    throw new HttpError(404, 'User not found')
  }
  res.json(publicUser(rows[0]))
})

// POST /api/auth/change-password { currentPassword, newPassword } → { message, user }
// Your own account only (the token says whose). Also the way out of a temporary password: requireAuth lets a flagged
// user reach this route, and it clears the flag.
// Sessions: every OTHER session of this user ends (other browsers and devices: their rows are revoked). The session
// that made the change stays as it is, cookie and all, so the person who changed the password stays logged in.
// session_version is not raised: that would end this session too.
router.post('/change-password', requireAuth, validate(schemas.changePassword), async (req, res) => {
  const { currentPassword, newPassword } = req.valid.body
  const [[user]] = await pool.query(`${AUTH_USER_SELECT} WHERE u.id = ?`, [req.user.id])

  // 400, not 401: the session is fine, only the typed password is wrong. A 401 would look like an expired login.
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    throw new HttpError(400, 'Current password is wrong', 'INVALID_CURRENT_PASSWORD')
  }
  if (newPassword === currentPassword) {
    throw new HttpError(400, 'New password must be different from the current one')
  }

  const passwordHash = await bcrypt.hash(newPassword, 10)
  // One transaction: the new password and the ended sessions are saved together or not at all
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(
      'UPDATE users SET password_hash = ?, must_change_password = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [passwordHash, user.id],
    )
    await revokeUserSessions(user.id, { keepSid: req.sessionId, db: conn })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }

  res.json({ message: 'Password changed', user: publicUser({ ...user, must_change_password: false }) })
})

// What a set-password link that can't be used answers, per state of its token (see src/passwordSetup.js)
const TOKEN_PROBLEMS = {
  invalid: ['This link is not valid. It may have been replaced by a newer one.', 'TOKEN_INVALID'],
  expired: ['This link has expired. Ask an admin or HR to send you a new one.', 'TOKEN_EXPIRED'],
  used: ['This link has already been used. Log in with the password you set.', 'TOKEN_USED'],
}

// GET /api/auth/set-password/validate?token= → 200 { status: 'valid', name, email, expires_at }
//                                           or 200 { status: 'expired' | 'used' | 'invalid', message, code }
// Public. Tells the set-password page whether to show the form, before the user types anything. It changes nothing.
router.get(
  '/set-password/validate',
  setPasswordRateLimit,
  validate(schemas.validateSetPasswordToken),
  async (req, res) => {
    const { status, row } = await lookUpToken(pool, req.valid.query.token)
    if (status === 'valid') {
      return res.json({ status, name: row.name, email: row.email, expires_at: row.expires_at })
    }
    const [message, code] = TOKEN_PROBLEMS[status]
    res.json({ status, message, code })
  },
)

// POST /api/auth/set-password { token, new_password } → 200 { message }
// Public (the user has no password yet, so no session; requireAuth and its must_change_password check don't apply).
// Sets the password (same rule as change-password), clears must_change_password, marks the link used and removes the
// user's other unused links. The user then logs in normally; no session is started here.
// A link that can't be used → 400 TOKEN_INVALID / TOKEN_EXPIRED / TOKEN_USED. A weak password → 400 with the rule.
// Sessions: like a reset, it ends any session the user still has (rows revoked, session_version raised; e.g. one
// opened with a temporary password after a reset), and clears a login lock.
router.post('/set-password', setPasswordRateLimit, validate(schemas.setPassword), async (req, res) => {
  const { token, new_password: newPassword } = req.valid.body
  const passwordHash = await bcrypt.hash(newPassword, 10)

  // The token row stays locked (FOR UPDATE) until the commit, so the same link sent twice at once works only once
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const { status, row } = await lookUpToken(conn, token, { forUpdate: true })
    if (status !== 'valid') {
      const [message, code] = TOKEN_PROBLEMS[status]
      throw new HttpError(400, message, code)
    }
    await conn.query(
      `UPDATE users SET password_hash = ?, must_change_password = FALSE, failed_login_count = 0, locked_until = NULL,
         session_version = session_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [passwordHash, row.user_id],
    )
    await conn.query('UPDATE password_setup_tokens SET used_at = ? WHERE id = ?', [new Date(Date.now()), row.id])
    await conn.query('DELETE FROM password_setup_tokens WHERE user_id = ? AND used_at IS NULL', [row.user_id])
    await revokeUserSessions(row.user_id, { db: conn })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }

  res.json({ message: 'Password set, please log in.' })
})

module.exports = router
