// User management routes.
// Mounted at /api/users. Agents/admins can list who can be assigned tickets.
// Admins and HR create, list and change accounts. HR only creates and changes employees, and never changes roles.
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { HttpError } = require('../middleware/errors');
const { requireAuth, requireRole, isStaff } = require('../middleware/auth');
const validate = require('../middleware/validate');
const schemas = require('../schemas/users');
const { makeTemporaryPassword } = require('../temporaryPassword');

const router = express.Router();

// Columns safe to send to the client (password_hash is never selected), with the department's name joined in.
// The old free-text users.department column is no longer read or written (see migrations/005).
const USER_SELECT = `
  SELECT u.id, u.name, u.email, u.role, u.department_id, d.name AS department_name, u.job_title, u.is_active,
         u.must_change_password, u.last_login_at, u.created_at, u.updated_at
  FROM users u
  LEFT JOIN departments d ON d.id = u.department_id`;

async function findUser(id) {
  const [rows] = await pool.query(`${USER_SELECT} WHERE u.id = ?`, [id]);
  return formatUser(rows[0]);
}

// MySQL returns booleans as 0/1; send real true/false to the client
function formatUser(row) {
  return { ...row, is_active: Boolean(row.is_active), must_change_password: Boolean(row.must_change_password) };
}

// A 400 for one field, in the same { message, errors } shape as validate() uses, for checks that need the database
function fieldError(res, field, message) {
  return res.status(400).json({ message, errors: [{ field, message }] });
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
  const [rows] = await pool.query(`${USER_SELECT} ORDER BY u.created_at DESC, u.id DESC`);
  res.json(rows.map(formatUser));
});

// POST /api/users { name, email, role, department_id?, job_title? } (admin and HR)
// → 201 { user, temporaryPassword }. HR may leave out role (it means employee); admins must send it.
// The server makes a temporary password and returns it only in this response; only its hash is stored.
router.post('/', requireRole('admin', 'hr'), validate(schemas.createUser), async (req, res) => {
  const { name, email } = req.valid.body;
  const isHr = req.user.role === 'hr';
  const role = req.valid.body.role ?? (isHr ? 'employee' : undefined);
  const departmentId = req.valid.body.department_id ?? null;
  const jobTitle = req.valid.body.job_title || null;

  if (!role) {
    return fieldError(res, 'role', 'Role is required');
  }
  if (isHr && role !== 'employee') {
    throw new HttpError(403, 'HR can only create employee accounts');
  }

  if (departmentId !== null) {
    const [departments] = await pool.query('SELECT id FROM departments WHERE id = ?', [departmentId]);
    if (departments.length === 0) {
      return fieldError(res, 'department_id', 'Department not found');
    }
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
      `INSERT INTO users (name, email, password_hash, role, department_id, job_title, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
      [name, email, passwordHash, role, departmentId, jobTitle]
    );
  } catch (err) {
    // Two requests for the same email at once: both pass the check above, and the UNIQUE index stops the second
    if (err.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'An account with this email already exists');
    // The department was deleted between the check above and the insert
    if (err.code === 'ER_NO_REFERENCED_ROW_2') return fieldError(res, 'department_id', 'Department not found');
    throw err;
  }

  res.status(201).json({ user: await findUser(result.insertId), temporaryPassword });
});

// Step 1 of a reset: who may reset whom. Runs before the body is looked at.
async function checkResetAllowed(req, res, next) {
  const { id } = req.valid.params;

  // Your own password needs your current one, so it goes through POST /api/auth/change-password instead
  if (id === req.user.id) {
    throw new HttpError(403, 'Use Change password for your own account');
  }

  const [existing] = await pool.query('SELECT id, role FROM users WHERE id = ?', [id]);
  if (existing.length === 0) {
    throw new HttpError(404, 'User not found');
  }
  if (req.user.role === 'hr' && existing[0].role !== 'employee') {
    throw new HttpError(403, 'HR can only reset passwords of employee accounts');
  }
  next();
}

// POST /api/users/:id/reset-password (admin and HR), no body → 200 { user, temporaryPassword }
// Replaces the password with a new temporary one (the old one stops working at once) and sets must_change_password,
// so the user has to choose their own at the next login. Deactivated accounts can be reset too.
// Sessions: tokens are stateless JWTs and can't be revoked, but requireAuth reloads the user on every request and
// refuses everything except /auth/me and /auth/change-password while must_change_password is set, so a session from
// before the reset can do nothing without the new temporary password.
router.post(
  '/:id/reset-password',
  requireRole('admin', 'hr'),
  validate(schemas.resetPassword),
  checkResetAllowed,
  validate(schemas.resetPasswordBody),
  async (req, res) => {
    const { id } = req.valid.params;

    const temporaryPassword = makeTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);
    // One statement, so the new hash and the flag are saved together or not at all
    await pool.query(
      'UPDATE users SET password_hash = ?, must_change_password = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [passwordHash, id]
    );

    res.json({ user: await findUser(id), temporaryPassword });
  }
);

// Step 1 of PATCH: the user must exist (404 comes before any problem with the body), and the caller must be allowed to
// change them. HR may only change employees, and may not send a role at all, whatever its value.
async function loadEditableUser(req, res, next) {
  const { id } = req.valid.params;
  const [existing] = await pool.query('SELECT id, name, role, is_active FROM users WHERE id = ?', [id]);
  if (existing.length === 0) {
    throw new HttpError(404, 'User not found');
  }

  const isHr = req.user.role === 'hr';
  // HR looks after employee accounts; staff and other HR/admin accounts stay with the admins
  if (isHr && existing[0].role !== 'employee') {
    throw new HttpError(403, 'HR can only change employee accounts');
  }
  // Checked on the raw body, before validation, so even an invalid role from HR is a 403
  if (isHr && req.body && Object.hasOwn(req.body, 'role')) {
    throw new HttpError(403, 'HR cannot change roles');
  }

  req.target = existing[0];
  next();
}

// PATCH /api/users/:id { name?, email?, department_id?, job_title?, role?, is_active? } → the updated user
// Only the fields sent change. Admin: anyone, including their own details (but not their own role or active status),
// and never the last active admin's role or active status. HR: employee accounts only, and never a role.
// Step 2, once the body is valid
async function editUser(req, res) {
  const { id } = req.valid.params;
  const { name, email, department_id: departmentId, job_title: jobTitle, role } = req.valid.body;
  const isActive = req.valid.body.is_active;
  const user = req.target;

  // Stops an admin from deactivating themselves or removing their own admin role (and locking themselves out)
  if (id === req.user.id && (role !== undefined || isActive !== undefined)) {
    throw new HttpError(403, 'You cannot change your own role or active status');
  }

  // Emails are unique: check before writing, so the answer is a clear 409 rather than a database error
  if (email !== undefined) {
    const [taken] = await pool.query('SELECT id FROM users WHERE email = ? AND id <> ?', [email, id]);
    if (taken.length > 0) {
      throw new HttpError(409, 'An account with this email already exists');
    }
  }

  if (departmentId !== undefined && departmentId !== null) {
    const [departments] = await pool.query('SELECT id FROM departments WHERE id = ?', [departmentId]);
    if (departments.length === 0) {
      return fieldError(res, 'department_id', 'Department not found');
    }
  }

  // Only update the fields that were sent. updated_at is set explicitly, because MySQL's ON UPDATE only fires when a
  // value actually changes, and an edit that saves the same values is still an edit.
  const sets = ['updated_at = CURRENT_TIMESTAMP'];
  const params = [];
  if (name !== undefined) {
    sets.push('name = ?');
    params.push(name);
  }
  if (email !== undefined) {
    sets.push('email = ?');
    params.push(email);
  }
  if (departmentId !== undefined) {
    sets.push('department_id = ?');
    params.push(departmentId);
  }
  if (jobTitle !== undefined) {
    sets.push('job_title = ?');
    params.push(jobTitle || null); // an empty job title is stored as "none"
  }
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
  const stopsBeingActiveAdmin = user.role === 'admin' && Boolean(user.is_active) && !(newRole === 'admin' && newActive);

  // A transaction so the checks below, the user change and the ticket release happen together or not at all
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Never leave the system without an active admin. FOR UPDATE locks the admin rows until this commits, so two
    // admins demoting each other at the same moment are handled one after the other, and the second one sees the
    // first one's change
    if (stopsBeingActiveAdmin) {
      const [admins] = await conn.query(
        "SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE AND id <> ? FOR UPDATE",
        [id]
      );
      if (admins.length === 0) {
        throw new HttpError(409, 'This is the last active admin. Make someone else an admin first');
      }
    }

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
    // Two requests taking the same email at once: both pass the check above, and the UNIQUE index stops the second
    if (err.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'An account with this email already exists');
    // The department was deleted between the check above and the update
    if (err.code === 'ER_NO_REFERENCED_ROW_2') return fieldError(res, 'department_id', 'Department not found');
    throw err;
  } finally {
    conn.release();
  }

  res.json(await findUser(id));
}

router.patch(
  '/:id',
  requireRole('admin', 'hr'),
  validate(schemas.updateUserParams),
  loadEditableUser,
  validate(schemas.updateUser),
  editUser
);

module.exports = router;
