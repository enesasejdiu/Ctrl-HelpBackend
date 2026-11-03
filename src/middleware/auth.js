// Authentication and authorization middleware.
// Clients send the JWT issued at login as "Authorization: Bearer <token>".
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { HttpError } = require('./errors');

// Verifies the token, then loads the user's CURRENT name, role and active status from the database,
// so role changes and deactivation take effect immediately instead of when the token expires.
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

  const [rows] = await pool.query('SELECT id, name, role, is_active FROM users WHERE id = ?', [payload.id]);
  const user = rows[0];
  // A deleted or deactivated account loses access right away, even with a still-valid token
  if (!user || !user.is_active) {
    throw new HttpError(401, 'Session expired, please log in again');
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

// Staff = anyone who works tickets (agents and admins)
function isStaff(user) {
  return user.role === 'agent' || user.role === 'admin';
}

module.exports = { requireAuth, requireRole, isStaff };
