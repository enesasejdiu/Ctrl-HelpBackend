// Authentication routes: register, login and "who am I".
// Mounted at /api/auth. Successful register/login return { token, user }; the client sends the token back
// as "Authorization: Bearer <token>" on later requests.
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

// The only user shape ever sent to clients; password_hash is deliberately left out
function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    department: user.department,
  };
}

// POST /api/auth/register: self-registration always creates an employee
router.post('/register', validate(schemas.register), async (req, res) => {
  const { name, email, password } = req.valid.body;
  const department = req.valid.body.department || null;

  const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length > 0) {
    throw new HttpError(409, 'An account with this email already exists');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  // role is hard-coded, and the schema refuses a "role" field in the request body
  const [result] = await pool.query(
    'INSERT INTO users (name, email, password_hash, role, department) VALUES (?, ?, ?, ?, ?)',
    [name, email, passwordHash, 'employee', department]
  );

  const user = { id: result.insertId, name, email, role: 'employee', department };
  res.status(201).json({ token: makeToken(user), user: publicUser(user) });
});

// POST /api/auth/login
router.post('/login', validate(schemas.login), async (req, res) => {
  const { email, password } = req.valid.body;

  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  const user = rows[0];

  // Same message for unknown email and wrong password, so attackers can't probe which emails exist
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new HttpError(401, 'Wrong email or password');
  }
  if (!user.is_active) {
    throw new HttpError(403, 'This account is deactivated');
  }

  res.json({ token: makeToken(user), user: publicUser(user) });
});

// GET /api/auth/me: the logged-in user's profile (the frontend calls this on page load to restore the session)
router.get('/me', requireAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  // Safety net: requireAuth already rejects deleted users, so this only triggers in a race with a delete
  if (rows.length === 0) {
    throw new HttpError(404, 'User not found');
  }
  res.json(publicUser(rows[0]));
});

module.exports = router;
