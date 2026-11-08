// Authentication routes: login, "who am I" and change password.
// Mounted at /api/auth. A successful login returns { token, user }; the client sends the token back
// as "Authorization: Bearer <token>" on later requests.
// There is no self-registration: admins and HR create accounts with POST /api/users.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { HttpError } = require('../middleware/errors');
const { requireAuth } = require('../middleware/auth');
const validate = require('../middleware/validate');
const schemas = require('../schemas/auth');

const router = express.Router();

// Signed token identifying the user. requireAuth only trusts the id from it and reloads name/role from the DB;
// name and role are included so the frontend can show them without an extra request.
function makeToken(user) {
  return jwt.sign({ id: user.id, name: user.name, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
  });
}

// What these routes load about a user: the public fields, plus the password hash and active flag for the checks.
// The department comes from departments; the old free-text users.department is no longer read (see migrations/005).
const AUTH_USER_SELECT = `
  SELECT u.id, u.name, u.email, u.role, u.password_hash, u.is_active, u.must_change_password,
         u.department_id, d.name AS department_name, u.job_title, u.created_at, u.last_login_at
  FROM users u
  LEFT JOIN departments d ON d.id = u.department_id`;

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
  };
}

// POST /api/auth/login → { token, must_change_password, user }
// A user with a temporary password logs in normally; must_change_password tells the client to send them to the
// change-password screen, and requireAuth blocks everything else until they do.
router.post('/login', validate(schemas.login), async (req, res) => {
  const { email, password } = req.valid.body;

  const [rows] = await pool.query(`${AUTH_USER_SELECT} WHERE u.email = ?`, [email]);
  const user = rows[0];

  // Same message for unknown email and wrong password, so attackers can't probe which emails exist
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new HttpError(401, 'Wrong email or password');
  }
  if (!user.is_active) {
    throw new HttpError(403, 'This account is deactivated');
  }

  // Only a successful login counts; the failed attempts above never get here
  await pool.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
  // Read back the stored value, so the user returned here matches what /me returns right after
  const [[{ last_login_at: lastLoginAt }]] = await pool.query('SELECT last_login_at FROM users WHERE id = ?', [user.id]);

  const loggedIn = publicUser({ ...user, last_login_at: lastLoginAt });
  res.json({ token: makeToken(user), must_change_password: loggedIn.must_change_password, user: loggedIn });
});

// GET /api/auth/me: the logged-in user's profile (the frontend calls this on page load to restore the session)
router.get('/me', requireAuth, async (req, res) => {
  const [rows] = await pool.query(`${AUTH_USER_SELECT} WHERE u.id = ?`, [req.user.id]);
  // Safety net: requireAuth already rejects deleted users, so this only triggers in a race with a delete
  if (rows.length === 0) {
    throw new HttpError(404, 'User not found');
  }
  res.json(publicUser(rows[0]));
});

// POST /api/auth/change-password { currentPassword, newPassword } → { message, user }
// Your own account only (the token says whose). Also the way out of a temporary password: requireAuth lets a flagged
// user reach this route, and it clears the flag.
// Sessions: tokens are stateless JWTs that can't be revoked, so other sessions keep working until they expire; the
// token used for this request stays valid.
router.post('/change-password', requireAuth, validate(schemas.changePassword), async (req, res) => {
  const { currentPassword, newPassword } = req.valid.body;
  const [[user]] = await pool.query(`${AUTH_USER_SELECT} WHERE u.id = ?`, [req.user.id]);

  // 400, not 401: the session is fine, only the typed password is wrong. A 401 would look like an expired login.
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    throw new HttpError(400, 'Current password is wrong', 'INVALID_CURRENT_PASSWORD');
  }
  if (newPassword === currentPassword) {
    throw new HttpError(400, 'New password must be different from the current one');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  // One statement, so the new hash and the cleared flag are saved together or not at all
  await pool.query(
    'UPDATE users SET password_hash = ?, must_change_password = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [passwordHash, user.id]
  );
  res.json({ message: 'Password changed', user: publicUser({ ...user, must_change_password: false }) });
});

module.exports = router;
