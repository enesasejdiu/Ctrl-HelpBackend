// Authentication routes: register, login and "who am I".
// Mounted at /api/auth. Successful register/login return { token, user }; the client sends the token back
// as "Authorization: Bearer <token>" on later requests.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { HttpError } = require('../middleware/errors');
const { requireAuth } = require('../middleware/auth');

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

// Reads a body field as a trimmed string ('' if missing or not a string), so bad input gives a 400, not a crash
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// POST /api/auth/register: self-registration always creates an employee
router.post('/register', async (req, res) => {
  const body = req.body || {};
  const name = text(body.name);
  // Emails are stored lowercase so "Ann@x.com" and "ann@x.com" are the same account
  const email = text(body.email).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : ''; // not trimmed: spaces are allowed
  const department = text(body.department) || null;

  if (!name || !email || !password) {
    throw new HttpError(400, 'Name, email and password are required');
  }
  if (password.length < 6) {
    throw new HttpError(400, 'Password must be at least 6 characters');
  }

  const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length > 0) {
    throw new HttpError(409, 'An account with this email already exists');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  // role is hard-coded: a "role" field in the request body is ignored
  const [result] = await pool.query(
    'INSERT INTO users (name, email, password_hash, role, department) VALUES (?, ?, ?, ?, ?)',
    [name, email, passwordHash, 'employee', department]
  );

  const user = { id: result.insertId, name, email, role: 'employee', department };
  res.status(201).json({ token: makeToken(user), user: publicUser(user) });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const email = text(req.body?.email).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  const user = rows[0];

  // Same message for unknown email and wrong password, so attackers can't probe which emails exist
  if (!user || !password || !(await bcrypt.compare(password, user.password_hash))) {
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
