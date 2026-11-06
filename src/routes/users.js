// User management routes.
// Mounted at /api/users. Agents/admins can list who can be assigned tickets; only admins can see and change accounts.
const express = require('express');
const pool = require('../db');
const { HttpError } = require('../middleware/errors');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const schemas = require('../schemas/users');

const router = express.Router();

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
router.patch('/:id', requireRole('admin'), validate(schemas.updateUser), async (req, res) => {
  const { id } = req.valid.params;
  const { role, is_active: isActive } = req.valid.body;

  // Stops an admin from deactivating themselves or removing their own admin role
  if (id === req.user.id) {
    throw new HttpError(400, 'You cannot change your own account here');
  }

  const [existing] = await pool.query('SELECT id, name, role, is_active FROM users WHERE id = ?', [id]);
  if (existing.length === 0) {
    throw new HttpError(404, 'User not found');
  }
  const user = existing[0];

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

  // If this change means the user can no longer work tickets (demoted to employee or deactivated),
  // their unfinished tickets go back to the queue so they don't get stuck with someone who can't act on them
  const newRole = role ?? user.role;
  const newActive = isActive ?? Boolean(user.is_active);
  const stopsBeingStaff = user.role !== 'employee' && (newRole === 'employee' || !newActive);

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
