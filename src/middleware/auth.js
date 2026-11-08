// Authentication and authorization middleware.
// The JWT issued at login arrives in the httpOnly tf_session cookie (see src/session.js), or, for now, as
// "Authorization: Bearer <token>". Cookie-authenticated changes (POST/PATCH/PUT/DELETE) also need the CSRF header.
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { HttpError } = require('./errors');
const { SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER, csrfMatches } = require('../session');

// Methods that change something: with cookie authentication they need X-CSRF-Token equal to the tf_csrf cookie
const CSRF_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'];

// The only requests a user with a temporary password may make: see who they are, and change the password.
// Exact "METHOD /path" matches only (a trailing slash counts as the same path); no prefixes or wildcards.
// (POST /api/auth/logout needs no login at all, so it isn't affected.)
const ALLOWED_BEFORE_PASSWORD_CHANGE = ['GET /api/auth/me', 'POST /api/auth/change-password'];

// Verifies the token, then loads the user's CURRENT name, role and active status from the database,
// so role changes and deactivation take effect immediately instead of when the token expires.
// A user who still has a temporary password (must_change_password) is blocked everywhere else with 403.
// Exposes the logged-in user as req.user = { id, name, role }, and how they authenticated as req.authMethod.
//
// Where the token comes from: an "Authorization: Bearer" header if the request sends one, otherwise the tf_session
// cookie. Either way, an invalid token is a 401 (no trying the other one).
// Why the header goes first: clients that keep cookies but send the token themselves (Postman, Playwright's API
// helper) would otherwise be authenticated by whatever cookie they picked up at their last login, possibly another
// user, and their changes would fail the CSRF check. A header is always sent on purpose.
// CSRF: a cookie-authenticated POST/PATCH/PUT/DELETE must send X-CSRF-Token equal to the tf_csrf cookie, or it gets
// 403 CSRF_INVALID. The browser attaches cookies to requests that other sites trigger, but those sites can't read
// tf_csrf to put it in the header. Bearer requests skip the check: another site can't make a browser add that header.
async function requireAuth(req, res, next) {
  let token;
  let authMethod;
  // Bearer header, for clients that don't use the cookie yet: remove in step 3
  const [scheme, bearer] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Bearer' && bearer) {
    token = bearer;
    authMethod = 'bearer';
  } else if (req.cookies?.[SESSION_COOKIE]) {
    token = req.cookies[SESSION_COOKIE];
    authMethod = 'cookie';
  }

  if (!token) {
    throw new HttpError(401, 'Not logged in');
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    // Covers malformed, tampered and expired tokens
    throw new HttpError(401, 'Session expired, please log in again');
  }

  if (authMethod === 'cookie' && CSRF_METHODS.includes(req.method)) {
    if (!csrfMatches(req.cookies[CSRF_COOKIE], req.get(CSRF_HEADER))) {
      throw new HttpError(403, 'Missing or invalid CSRF token. Reload the page and try again.', 'CSRF_INVALID');
    }
  }

  const [rows] = await pool.query('SELECT id, name, role, is_active, must_change_password FROM users WHERE id = ?', [
    payload.id,
  ]);
  const user = rows[0];
  // A deleted or deactivated account loses access right away, even with a still-valid token
  if (!user || !user.is_active) {
    throw new HttpError(401, 'Session expired, please log in again');
  }

  if (user.must_change_password) {
    // baseUrl + path is the full path without the query string; a trailing slash counts as the same path
    const path = `${req.baseUrl}${req.path}`.replace(/\/+$/, '');
    if (!ALLOWED_BEFORE_PASSWORD_CHANGE.includes(`${req.method} ${path}`)) {
      throw new HttpError(403, 'You must change your password before continuing', 'PASSWORD_CHANGE_REQUIRED');
    }
  }

  req.user = { id: user.id, name: user.name, role: user.role };
  req.authMethod = authMethod;
  next();
}

// Allows the request only for the given roles; use after requireAuth, e.g. requireRole('admin')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new HttpError(403, 'You do not have permission for this action'));
    }
    next();
  };
}

// Staff = anyone who works tickets (agents and admins). HR is not staff: for tickets, HR is an employee.
function isStaff(user) {
  return user.role === 'agent' || user.role === 'admin';
}

module.exports = { requireAuth, requireRole, isStaff, ALLOWED_BEFORE_PASSWORD_CHANGE };
