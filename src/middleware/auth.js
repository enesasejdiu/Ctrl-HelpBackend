// Authentication and authorization middleware.
// Clients send the JWT issued at login as "Authorization: Bearer <token>".
const jwt = require('jsonwebtoken');
const { HttpError } = require('./errors');

// Verifies the token and exposes the logged-in user as req.user = { id, name, role }
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new HttpError(401, 'Not logged in'));
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.id, name: payload.name, role: payload.role };
    next();
  } catch {
    // Covers malformed, tampered and expired tokens
    next(new HttpError(401, 'Session expired, please log in again'));
  }
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
