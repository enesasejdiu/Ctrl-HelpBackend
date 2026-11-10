// Authentication and authorization middleware.
// The JWT issued at login arrives only in the httpOnly tf_session cookie (see src/session.js). Changes
// (POST/PATCH/PUT/DELETE) also need the CSRF header. An Authorization header is ignored.
const jwt = require('jsonwebtoken')
const pool = require('../db')
const { HttpError } = require('./errors')
const { SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER, csrfMatches } = require('../session')
const { findActiveSession } = require('../sessionStore')

// Methods that change something: with cookie authentication they need X-CSRF-Token equal to the tf_csrf cookie
const CSRF_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE']

// The only requests a user with a temporary password may make: see who they are, and change the password.
// Exact "METHOD /path" matches only (a trailing slash counts as the same path); no prefixes or wildcards.
// (POST /api/auth/logout needs no login at all, so it isn't affected.)
const ALLOWED_BEFORE_PASSWORD_CHANGE = ['GET /api/auth/me', 'POST /api/auth/change-password']

// Verifies the token, then loads the user's CURRENT name, role and active status from the database,
// so role changes and deactivation take effect immediately instead of when the token expires.
// Two more checks end sessions, both with 401 "Session expired, please log in again":
//   * the server-side session: the token's "sid" must be a row in sessions (src/sessionStore.js) for this user that
//     isn't revoked or expired. Logout, "log out everywhere", a password change (other sessions), a reset,
//     deactivation and a role change revoke rows, so a copied token stops working at once. A token without sid
//     (issued before migration 008) is refused.
//   * session_version: a reset, deactivation or role change also raises users.session_version, and every token issued
//     before that no longer matches (kept as a second, independent check).
// A user who still has a temporary password (must_change_password) is blocked everywhere else with 403.
// Exposes the logged-in user as req.user = { id, name, role }, and the session id as req.sessionId.
//
// The token comes only from the tf_session cookie; there is no "Authorization: Bearer" any more, so a header alone
// is a 401 "Not logged in".
// CSRF: a POST/PATCH/PUT/DELETE must send X-CSRF-Token equal to the tf_csrf cookie, or it gets 403 CSRF_INVALID.
// The browser attaches cookies to requests that other sites trigger, but those sites can't read tf_csrf to put it in
// the header.
async function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE]

  if (!token) {
    throw new HttpError(401, 'Not logged in')
  }

  let payload
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    // Covers malformed, tampered and expired tokens
    throw new HttpError(401, 'Session expired, please log in again')
  }

  if (CSRF_METHODS.includes(req.method)) {
    if (!csrfMatches(req.cookies[CSRF_COOKIE], req.get(CSRF_HEADER))) {
      throw new HttpError(403, 'Missing or invalid CSRF token. Reload the page and try again.', 'CSRF_INVALID')
    }
  }

  const [rows] = await pool.query(
    'SELECT id, name, role, is_active, must_change_password, session_version FROM users WHERE id = ?',
    [payload.id],
  )
  const user = rows[0]
  // A deleted or deactivated account loses access right away, even with a still-valid token
  if (!user || !user.is_active) {
    throw new HttpError(401, 'Session expired, please log in again')
  }
  // Ended sessions (1): a reset, deactivation or role change raises users.session_version, and every token issued
  // before that no longer matches. Tokens from before migration 007 carry no version and count as 0.
  if ((payload.session_version ?? 0) !== user.session_version) {
    throw new HttpError(401, 'Session expired, please log in again')
  }
  // Ended sessions (2): the server-side session must exist, belong to this user, and be neither revoked nor expired
  const session = await findActiveSession(payload.sid)
  if (!session || !session.active || session.user_id !== user.id) {
    throw new HttpError(401, 'Session expired, please log in again')
  }

  if (user.must_change_password) {
    // baseUrl + path is the full path without the query string; a trailing slash counts as the same path
    const path = `${req.baseUrl}${req.path}`.replace(/\/+$/, '')
    if (!ALLOWED_BEFORE_PASSWORD_CHANGE.includes(`${req.method} ${path}`)) {
      throw new HttpError(403, 'You must change your password before continuing', 'PASSWORD_CHANGE_REQUIRED')
    }
  }

  req.user = { id: user.id, name: user.name, role: user.role }
  req.sessionId = payload.sid
  next()
}

// Allows the request only for the given roles; use after requireAuth, e.g. requireRole('admin')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new HttpError(403, 'You do not have permission for this action'))
    }
    next()
  }
}

// Staff = anyone who works tickets (agents and admins). HR is not staff: for tickets, HR is an employee.
function isStaff(user) {
  return user.role === 'agent' || user.role === 'admin'
}

module.exports = { requireAuth, requireRole, isStaff, ALLOWED_BEFORE_PASSWORD_CHANGE }
