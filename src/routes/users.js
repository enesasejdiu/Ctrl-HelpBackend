// User management routes.
// Mounted at /api/users. Agents/admins can list who can be assigned tickets; only admins can see and change accounts.
const express = require('express');
const pool = require('../db');
const { HttpError } = require('../middleware/errors');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const ROLES = ['employee', 'agent', 'admin'];

// Columns safe to send to the client; password_hash is never selected
const USER_COLUMNS = 'id, name, email, role, department, is_active, created_at';

// MySQL returns booleans as 0/1; send real true/false to the client
function formatUser(row) {
  return { ...row, is_active: Boolean(row.is_active) };
}

router.use(requireAuth);

// GET /api/users/agents → active agents and admins, for the "Assign to" dropdown
router.get('/agents', requireRole('agent', 'admin'), async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, name FROM users WHERE is_active = TRUE AND role IN ('agent', 'admin') ORDER BY name"
  );
  res.json(rows);
});

// GET /api/users → every account, newest first (admin only)
router.get('/', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at DESC, id DESC`);
  res.json(rows.map(formatUser));
});

// PATCH /api/users/:id { role?, is_active? } (admin only)
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const { role, is_active: isActive } = req.body || {};

  // Stops an admin from deactivating themselves or removing their own admin role
  if (id === req.user.id) {
    throw new HttpError(400, 'You cannot change your own account here');
  }
  if (role === undefined && isActive === undefined) {
    throw new HttpError(400, 'Send a role and/or is_active to change');
  }
  if (role !== undefined && !ROLES.includes(role)) {
    throw new HttpError(400, 'Invalid role');
  }
  if (isActive !== undefined && typeof isActive !== 'boolean') {
    throw new HttpError(400, 'is_active must be true or false');
  }

  const [existing] = Number.isInteger(id) ? await pool.query('SELECT id FROM users WHERE id = ?', [id]) : [[]];
  if (existing.length === 0) {
    throw new HttpError(404, 'User not found');
  }

  // Only update the fields that were sent
  const sets = [];
  const params = [];
  if (role !== undefined) {
    sets.push('role = ?');
    params.push(role);
  }
  if (isActive !== undefined) {
    sets.push('is_active = ?');
    params.push(isActive);
  }
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);

  const [rows] = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]);
  res.json(formatUser(rows[0]));
});

module.exports = router;
