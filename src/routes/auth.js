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
const { loginRateLimit, setPasswordRateLimit, forgotPasswordRateLimit } = require('../middleware/rateLimit')
const { isEmailConfigured } = require('../mail/mailer')
const notify = require('../mail/notifications')
const { lookUpToken } = require('../passwordTokens')
const { newPassword: newPasswordRule } = require('../schemas/common')
const { SESSION_HOURS, SESSION_COOKIE, setSessionCookies, clearSessionCookies } = require('../session')
const { createSession, revokeSession, revokeUserSessions } = require('../sessionStore')
const { recordAudit } = require('../audit')
const { lockoutMinutes } = require('../lockout')
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

// Lockout: this many wrong passwords in a row lock the account for lockoutMinutes() (15, except in tests; see
// src/lockout.js and POST /login below)
const MAX_FAILED_LOGINS = 5

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
  const minutes = lockoutMinutes()
  const [locked] = await pool.query(
    `UPDATE users SET locked_until = NOW() + INTERVAL ? MINUTE, updated_at = updated_at
     WHERE id = ? AND failed_login_count >= ? AND locked_until IS NULL`,
    [minutes, user.id, MAX_FAILED_LOGINS],
  )
  return locked.affectedRows > 0 ? minutes * 60 : null
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
// passwords in a row lock the account for 15 minutes (lockoutMinutes(); 423 ACCOUNT_LOCKED, even with the right password). The lock
// ends by itself, after a successful login, or when an admin or HR resets the password.
router.post('/login', loginRateLimit, validate(schemas.login), async (req, res) => {
  const { email, password } = req.valid.body

  const [rows] = await pool.query(`${LOGIN_SELECT} WHERE u.email = ?`, [email])
  const user = rows[0]

  // Every refused login is logged with the email as typed and why, never the password
  const failed = (reason) =>
    recordAudit('login_failure', { targetUserId: user?.id ?? null, details: { email, reason }, req })

  // Same message for unknown email and wrong password, so attackers can't probe which emails exist
  if (!user) {
    await failed('unknown_email')
    throw new HttpError(401, 'Wrong email or password')
  }
  // Locked: refused before the password is even checked, so guessing is pointless until the lock runs out
  if (user.lock_seconds_left > 0) {
    await failed('locked')
    throw accountLocked(res, user.lock_seconds_left)
  }
  if (!(await bcrypt.compare(password, user.password_hash))) {
    const lockedFor = await recordWrongPassword(user)
    await failed('wrong_password')
    // The wrong password that locks the account already says so, instead of one more "wrong password"
    if (lockedFor) {
      await recordAudit('account_locked', {
        targetUserId: user.id,
        details: { email, minutes: lockedFor / 60 },
        req,
      })
      throw accountLocked(res, lockedFor)
    }
    throw new HttpError(401, 'Wrong email or password')
  }
  if (!user.is_active) {
    await failed('deactivated')
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
  await recordAudit('login_success', { actorId: user.id, targetUserId: user.id, details: { email }, req })
  setSessionCookies(res, makeToken(user, sid))
  res.json({ user: loggedIn })
})

// The token from the request's cookie, if it is genuine (signed by us): { id, sid, ... }. Expired tokens count too, so
// their row can still be revoked. A forged or garbled cookie gives null.
function tokenFromCookie(req) {
  const token = req.cookies?.[SESSION_COOKIE]
  if (!token) return null
  try {
    return jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true })
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
  const token = tokenFromCookie(req)
  // Logged only when it really ended a session (not for a second logout, or without one)
  if (token?.sid && (await revokeSession(token.sid))) {
    await recordAudit('logout', { actorId: token.id, targetUserId: token.id, req })
  }
  clearSessionCookies(res)
  res.status(204).end()
})

// POST /api/auth/logout-all → 204 (logged in). "Log out everywhere": ends every session of this user, in every browser
// and device, this one included, and clears this browser's cookies.
router.post('/logout-all', requireAuth, async (req, res) => {
  const ended = await revokeUserSessions(req.user.id)
  await recordAudit('logout_all', {
    actorId: req.user.id,
    targetUserId: req.user.id,
    details: { sessions_ended: ended },
    req,
  })
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
    const ended = await revokeUserSessions(user.id, { keepSid: req.sessionId, db: conn })
    await recordAudit('password_changed', {
      actorId: user.id,
      targetUserId: user.id,
      details: { other_sessions_ended: ended },
      req,
      db: conn,
    })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }

  res.json({ message: 'Password changed', user: publicUser({ ...user, must_change_password: false }) })
})

// What a one-time password link that can't be used answers, per state of its token (see src/passwordTokens.js)
const TOKEN_PROBLEMS = {
  invalid: ['This link is not valid. Ask your administrator or HR for a new link.', 'TOKEN_INVALID'],
  expired: ['This link has expired. Ask your administrator or HR for a new link.', 'TOKEN_EXPIRED'],
  used: ['This link has already been used. Ask your administrator or HR for a new link.', 'TOKEN_USED'],
}

// GET /api/auth/set-password/validate?token= → 200 { status, purpose, ... }
//   valid:                     { status: 'valid', purpose: 'setup' | 'reset', email, expires_at }
//   expired / used / invalid:  { status, purpose: null, message, code }
// Public. Tells the set-password page whether to show the form, before the user types anything. It changes nothing.
// An unknown token, one replaced by a newer link and one of a deactivated account all answer the same 'invalid'
// (one indexed lookup each), and a link that can't be used never reveals whose it is.
router.get(
  '/set-password/validate',
  setPasswordRateLimit,
  validate(schemas.validateSetPasswordToken),
  async (req, res) => {
    const { status, row } = await lookUpToken(pool, req.valid.query.token)
    if (status === 'valid') {
      return res.json({ status, purpose: row.purpose, email: row.email, expires_at: row.expires_at })
    }
    const [message, code] = TOKEN_PROBLEMS[status]
    res.json({ status, purpose: null, message, code })
  },
)

// POST /api/auth/set-password { token, new_password } → 200 { message }
// Public: the person has no usable password (a new account, or one reset by email), so no session. requireAuth and its
// must_change_password check don't apply.
// One transaction: check the token (locked, so the same link sent twice at once works only once), check the password
// rule, set the hash, clear must_change_password, mark the token used, and remove the user's other unused tokens.
// The user is not logged in: they log in afterwards with the new password.
//   400 TOKEN_INVALID / TOKEN_EXPIRED / TOKEN_USED   a link that can't be used
//   422 WEAK_PASSWORD { errors: [{ field: 'new_password', message }] }   the token stays unused
// Sessions: like a reset, it ends any session the user still has (rows revoked, session_version raised), and clears
// a login lock.
router.post('/set-password', setPasswordRateLimit, validate(schemas.setPassword), async (req, res) => {
  const { token, new_password: password } = req.valid.body

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const { status, row } = await lookUpToken(conn, token, { forUpdate: true })
    if (status !== 'valid') {
      const [message, code] = TOKEN_PROBLEMS[status]
      throw new HttpError(400, message, code)
    }
    // The shared rule (10–72 characters, a letter and a number), checked once the link is known to be good
    const rule = newPasswordRule.safeParse(password)
    if (!rule.success) {
      const message = rule.error.issues[0].message
      throw new HttpError(422, message, 'WEAK_PASSWORD', { errors: [{ field: 'new_password', message }] })
    }
    const passwordHash = await bcrypt.hash(password, 10)
    await conn.query(
      `UPDATE users SET password_hash = ?, must_change_password = FALSE, failed_login_count = 0, locked_until = NULL,
         session_version = session_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [passwordHash, row.user_id],
    )
    await conn.query('UPDATE password_tokens SET used_at = ? WHERE id = ?', [new Date(Date.now()), row.id])
    await conn.query('DELETE FROM password_tokens WHERE user_id = ? AND used_at IS NULL', [row.user_id])
    await revokeUserSessions(row.user_id, { db: conn })
    await recordAudit('password_set_with_link', {
      actorId: row.user_id,
      targetUserId: row.user_id,
      details: { purpose: row.purpose },
      req,
      db: conn,
    })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }

  res.json({ message: 'Password set, please log in.' })
})

// The one answer POST /api/auth/forgot-password gives, whether or not the email has an account
const FORGOT_PASSWORD_MESSAGE =
  "If there's an active account for that email, we've sent it a link to choose a new password. It expires in 48 hours."

// POST /api/auth/forgot-password { email } → 200 { message } (always the same message)
// Public, rate-limited per IP address. Only when email is set up; otherwise 409 EMAIL_NOT_CONFIGURED (ask an admin or
// HR for a reset). The account lookup and the email happen after the response (notifications.forgotPassword), so
// neither the answer nor its timing tells whether an account exists. The current password keeps working: only the
// emailed one-time link (purpose 'reset', 48 hours) can replace it, so asking for a reset can't lock anyone out.
router.post('/forgot-password', forgotPasswordRateLimit, validate(schemas.forgotPassword), (req, res) => {
  if (!isEmailConfigured()) {
    throw new HttpError(
      409,
      "Password reset by email isn't available. Ask your administrator or HR to reset your password.",
      'EMAIL_NOT_CONFIGURED',
    )
  }
  notify.forgotPassword({ email: req.valid.body.email, ip: req.ip })
  res.json({ message: FORGOT_PASSWORD_MESSAGE })
})

module.exports = router
