// User management routes.
// Mounted at /api/users. Agents/admins can list who can be assigned tickets.
// Admins and HR create, list and change accounts. HR only creates and changes employees, and never changes roles.
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { HttpError } = require('../middleware/errors');
const { requireAuth, requireRole, isStaff } = require('../middleware/auth');
const validate = require('../middleware/validate');
const schemas = require('../schemas/users');

const router = express.Router();

// Columns safe to send to the client; password_hash is never selected
const USER_COLUMNS = 'id, name, email, role, department, is_active, must_change_password, created_at';

// MySQL returns booleans as 0/1; send real true/false to the client
function formatUser(row) {
  return { ...row, is_active: Boolean(row.is_active), must_change_password: Boolean(row.must_change_password) };
}

// Letters and digits, minus look-alikes (0/O, 1/l/I), so the password can be read out or copied from a note
const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TEMP_PASSWORD_LENGTH = 14;

// A random temporary password with at least one letter and one digit.
// crypto.randomInt is cryptographically secure, unlike Math.random.
function makeTemporaryPassword() {
  for (;;) {
    const password = Array.from(
      { length: TEMP_PASSWORD_LENGTH },
      () => PASSWORD_CHARS[crypto.randomInt(PASSWORD_CHARS.length)]
    ).join('');
    // Draws without a letter or without a digit are very rare; just draw again
    if (/[a-zA-Z]/.test(password) && /\d/.test(password)) return password;
  }
}

router.use(requireAuth);

// GET /api/users/agents → active agents and admins, for the "Assign to" dropdown
router.get('/agents', requireRole('agent', 'admin'), async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, name FROM users WHERE is_active = TRUE AND role IN ('agent', 'admin') ORDER BY name"
  );
  res.json(rows);
});

// GET /api/users → every account, newest first (admin and HR)
router.get('/', requireRole('admin', 'hr'), async (req, res) => {
  const [rows] = await pool.query(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at DESC, id DESC`);
  res.json(rows.map(formatUser));
});

// POST /api/users { name, email, role, department? } (admin and HR) → 201 { user, temporaryPassword }
// The server makes a temporary password and returns it only in this response; only its hash is stored.
router.post('/', requireRole('admin', 'hr'), validate(schemas.createUser), async (req, res) => {
  const { name, email, role } = req.valid.body;
  const department = req.valid.body.department || null;

  if (req.user.role === 'hr' && role !== 'employee') {
    throw new HttpError(403, 'HR can only create employee accounts');
  }

  const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length > 0) {
    throw new HttpError(409, 'An account with this email already exists');
  }

  const temporaryPassword = makeTemporaryPassword();
  const passwordHash = await bcrypt.hash(temporaryPassword, 10);
  let result;
  try {
    [result] = await pool.query(
      'INSERT INTO users (name, email, password_hash, role, department, must_change_password) VALUES (?, ?, ?, ?, ?, TRUE)',
      [name, email, passwordHash, role, department]
    );
  } catch (err) {
    // Two requests for the same email at once: both pass the check above, and the UNIQUE index stops the second
    if (err.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'An account with this email already exists');
    throw err;
  }

  const [rows] = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [result.insertId]);
  res.status(201).json({ user: formatUser(rows[0]), temporaryPassword });
});

// PATCH /api/users/:id { role?, is_active? } (admin; HR only is_active, and only for employees)
router.patch('/:id', requireRole('admin', 'hr'), validate(schemas.updateUser), async (req, res) => {
  const { id } = req.valid.params;
  const { role, is_active: isActive } = req.valid.body;

  // Stops an admin from deactivating themselves or removing their own admin role
  if (id === req.user.id) {
    throw new HttpError(400, 'You cannot change your own account here');
  }

  const isHr = req.user.role === 'hr';
  if (isHr && role !== undefined) {
    throw new HttpError(403, 'HR cannot change roles');
  }

  const [existing] = await pool.query('SELECT id, name, role, is_active FROM users WHERE id = ?', [id]);
  if (existing.length === 0) {
    throw new HttpError(404, 'User not found');
  }
  const user = existing[0];

  // HR looks after employee accounts; staff and other HR/admin accounts stay with the admins
  if (isHr && user.role !== 'employee') {
    throw new HttpError(403, 'HR can only change employee accounts');
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

  // If this change means the user can no longer work tickets (moved to a non-staff role such as employee or HR,
  // or deactivated), their unfinished tickets go back to the queue so they don't get stuck with someone who
  // can't act on them
  const newRole = role ?? user.role;
  const newActive = isActive ?? Boolean(user.is_active);
  const stopsBeingStaff = isStaff(user) && !(isStaff({ role: newRole }) && newActive);

  // A transaction so the user change and the ticket release happen together or not at all
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);

    if (stopsBeingStaff) {
      const [tickets] = await conn.query(
        "SELECT id, status FROM tickets WHERE assigned_to = ? AND status NOT IN ('resolved', 'closed')",
        [id]
      );
      for (const ticket of tickets) {
        // Same rule as unassigning on the ticket page: "assigned" goes back to "open", other statuses stay
        const newStatus = ticket.status === 'assigned' ? 'open' : ticket.status;
        await conn.query('UPDATE tickets SET assigned_to = NULL, status = ? WHERE id = ?', [newStatus, ticket.id]);
        await conn.query(
          'INSERT INTO ticket_history (ticket_id, changed_by, field_changed, old_value, new_value) VALUES (?, ?, ?, ?, ?)',
          [ticket.id, req.user.id, 'assigned_to', user.name, null]
        );
        if (newStatus !== ticket.status) {
          await conn.query(
            'INSERT INTO ticket_history (ticket_id, changed_by, field_changed, old_value, new_value) VALUES (?, ?, ?, ?, ?)',
            [ticket.id, req.user.id, 'status', ticket.status, newStatus]
          );
        }
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const [rows] = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]);
  res.json(formatUser(rows[0]));
});

module.exports = router;
