// Authentication and authorization middleware.
// Clients send the JWT issued at login as "Authorization: Bearer <token>".
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { HttpError } = require('./errors');

// The only requests a user with a temporary password may make: see who they are, and change the password.
// Exact "METHOD /path" matches only (a trailing slash counts as the same path); no prefixes or wildcards.
// There is no logout or token refresh endpoint: logging out only forgets the token in the browser.
const ALLOWED_BEFORE_PASSWORD_CHANGE = ['GET /api/auth/me', 'POST /api/auth/change-password'];

// Verifies the token, then loads the user's CURRENT name, role and active status from the database,
// so role changes and deactivation take effect immediately instead of when the token expires.
// A user who still has a temporary password (must_change_password) is blocked everywhere else with 403.
// Exposes the logged-in user as req.user = { id, name, role }.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    throw new HttpError(401, 'Not logged in');
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    // Covers malformed, tampered and expired tokens
    throw new HttpError(401, 'Session expired, please log in again');
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
