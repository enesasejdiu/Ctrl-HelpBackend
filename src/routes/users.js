// User management routes.
// Mounted at /api/users. Agents/admins can list who can be assigned tickets.
// Admins and HR create, list and change accounts. HR only creates and changes employees, and never changes roles.
// Passwords for new and reset accounts are delivered one of two ways, decided by the server's settings only
// (isEmailConfigured() in src/mail/mailer.js), and every such response says which with password_delivery:
//   'email'               email is set up: a one-time link (src/passwordTokens.js) goes to the user; no password
//                         is ever shown to the admin or HR
//   'temporary_password'  email is not set up: a temporary password is returned once (temporaryPassword), as before
const express = require('express')
const bcrypt = require('bcryptjs')
const pool = require('../db')
const { HttpError } = require('../middleware/errors')
const { requireAuth, requireRole, isStaff } = require('../middleware/auth')
const validate = require('../middleware/validate')
const schemas = require('../schemas/users')
const { makeTemporaryPassword } = require('../temporaryPassword')
const { issueToken, latestPurpose, unusablePasswordHash } = require('../passwordTokens')
const { isEmailConfigured } = require('../mail/mailer')
const notify = require('../mail/notifications')

const EMAIL = 'email'
const TEMPORARY_PASSWORD = 'temporary_password'
const { revokeUserSessions } = require('../sessionStore')
const { recordAudit } = require('../audit')
const { statusSets } = require('../ticketStatus')

const router = express.Router()

// Columns safe to send to the client (password_hash is never selected), with the department's name joined in.
// The old free-text users.department column is no longer read or written (see migrations/005).
const USER_SELECT = `
  SELECT u.id, u.name, u.email, u.role, u.department_id, d.name AS department_name, u.job_title, u.is_active,
         u.must_change_password, u.last_login_at, u.created_at, u.updated_at
  FROM users u
  LEFT JOIN departments d ON d.id = u.department_id`

async function findUser(id) {
  const [rows] = await pool.query(`${USER_SELECT} WHERE u.id = ?`, [id])
  return formatUser(rows[0])
}

// MySQL returns booleans as 0/1; send real true/false to the client
function formatUser(row) {
  return { ...row, is_active: Boolean(row.is_active), must_change_password: Boolean(row.must_change_password) }
}

// A 400 for one field, in the same { message, errors } shape as validate() uses, for checks that need the database
function fieldError(res, field, message) {
  return res.status(400).json({ message, errors: [{ field, message }] })
}

router.use(requireAuth)

// GET /api/users/agents → active agents and admins, for the "Assign to" dropdown
router.get('/agents', requireRole('agent', 'admin'), async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, name FROM users WHERE is_active = TRUE AND role IN ('agent', 'admin') ORDER BY name",
  )
  res.json(rows)
})

// GET /api/users → every account, newest first (admin and HR)
router.get('/', requireRole('admin', 'hr'), async (req, res) => {
  const [rows] = await pool.query(`${USER_SELECT} ORDER BY u.created_at DESC, u.id DESC`)
  res.json(rows.map(formatUser))
})

// POST /api/users { name, email, role, department_id?, job_title? } (admin and HR)
// HR may leave out role (it means employee); admins must send it.
// Email set up → 201 { user, password_delivery: 'email' }. The account starts with a password nobody knows (so it
//   can't be logged into), and the new user gets a one-time 'setup' link (48 hours). The user row and the token are
//   saved together; the email goes out after the commit, in the background, and a failed email doesn't undo the
//   account (send a new link with POST /api/users/:id/resend-link).
// Not set up → 201 { user, temporaryPassword, password_delivery: 'temporary_password' }: the temporary password is
//   returned only in this response (only its hash is stored), and the user must change it at the first login.
router.post('/', requireRole('admin', 'hr'), validate(schemas.createUser), async (req, res) => {
  const { name, email } = req.valid.body
  const isHr = req.user.role === 'hr'
  const role = req.valid.body.role ?? (isHr ? 'employee' : undefined)
  const departmentId = req.valid.body.department_id ?? null
  const jobTitle = req.valid.body.job_title || null

  if (!role) {
    return fieldError(res, 'role', 'Role is required')
  }
  if (isHr && role !== 'employee') {
    throw new HttpError(403, 'HR can only create employee accounts')
  }

  if (departmentId !== null) {
    const [departments] = await pool.query('SELECT id FROM departments WHERE id = ?', [departmentId])
    if (departments.length === 0) {
      return fieldError(res, 'department_id', 'Department not found')
    }
  }

  const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email])
  if (existing.length > 0) {
    throw new HttpError(409, 'An account with this email already exists')
  }

  const byEmail = isEmailConfigured()
  const temporaryPassword = byEmail ? null : makeTemporaryPassword()
  const passwordHash = byEmail ? await unusablePasswordHash() : await bcrypt.hash(temporaryPassword, 10)
  const conn = await pool.getConnection()
  let userId
  let link = null
  try {
    await conn.beginTransaction()
    const [result] = await conn.query(
      `INSERT INTO users (name, email, password_hash, role, department_id, job_title, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
      [name, email, passwordHash, role, departmentId, jobTitle],
    )
    userId = result.insertId
    if (byEmail) link = await issueToken(conn, userId, 'setup')
    // Saved with the account; never a password, the link or its token
    await recordAudit('user_created', {
      actorId: req.user.id,
      targetUserId: userId,
      details: { email, role, department_id: departmentId, delivery: byEmail ? EMAIL : TEMPORARY_PASSWORD },
      req,
      db: conn,
    })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    // Two requests for the same email at once: both pass the check above, and the UNIQUE index stops the second
    if (err.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'An account with this email already exists')
    // The department was deleted between the check above and the insert
    if (err.code === 'ER_NO_REFERENCED_ROW_2') return fieldError(res, 'department_id', 'Department not found')
    throw err
  } finally {
    conn.release()
  }

  const user = await findUser(userId)
  if (!byEmail) {
    return res.status(201).json({ user, temporaryPassword, password_delivery: TEMPORARY_PASSWORD })
  }
  // Only after the commit, and not awaited
  notify.passwordLink({ userId, token: link.token, purpose: 'setup', actorId: req.user.id })
  res.status(201).json({ user, password_delivery: EMAIL })
})

// Who may send whom a password link (resend-link) or reset their password: HR only employees, and nobody themselves
// (your own password needs your current one: POST /api/auth/change-password). Runs before the body is looked at.
async function loadTarget(req, action) {
  const { id } = req.valid.params
  if (id === req.user.id) {
    throw new HttpError(403, 'Use Change password for your own account')
  }
  const [[target]] = await pool.query('SELECT id, role, is_active, must_change_password FROM users WHERE id = ?', [id])
  if (!target) {
    throw new HttpError(404, 'User not found')
  }
  if (req.user.role === 'hr' && target.role !== 'employee') {
    throw new HttpError(403, `HR can only ${action} employee accounts`)
  }
  return target
}

// POST /api/users/:id/resend-link { purpose? } (admin and HR; HR only for employees) → 200 { user, password_delivery }
// A fresh one-time link, e.g. when the first one expired or the email got lost; the old link stops working.
// purpose: 'setup' or 'reset'; left out, it is the purpose of the user's last link (or 'setup' if there was none).
// Only while the user still has no password of their own (must_change_password); otherwise 409 PASSWORD_ALREADY_SET
// (a forgotten password goes through reset-password instead). 409 EMAIL_NOT_CONFIGURED when email isn't set up
// (there is no link to send: use reset-password for a new temporary password), 409 ACCOUNT_DEACTIVATED.
router.post('/:id/resend-link', requireRole('admin', 'hr'), validate(schemas.resendLink), async (req, res) => {
  const { id } = req.valid.params
  const target = await loadTarget(req, 'send links to')
  if (!isEmailConfigured()) {
    throw new HttpError(
      409,
      'Email is not set up, so no link can be sent. Use Reset password for a temporary password',
      'EMAIL_NOT_CONFIGURED',
    )
  }
  if (!target.is_active) {
    throw new HttpError(409, 'This account is deactivated. Reactivate it first', 'ACCOUNT_DEACTIVATED')
  }
  if (!target.must_change_password) {
    throw new HttpError(409, 'This user has already set a password. Use Reset password instead', 'PASSWORD_ALREADY_SET')
  }

  // Locks the user row, so two resends at the same moment run one after the other and only the newest link works
  const conn = await pool.getConnection()
  let link
  let purpose
  try {
    await conn.beginTransaction()
    await conn.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [id])
    purpose = req.valid.body.purpose ?? (await latestPurpose(conn, id)) ?? 'setup'
    link = await issueToken(conn, id, purpose)
    await recordAudit('invite_resent', { actorId: req.user.id, targetUserId: id, details: { purpose }, req, db: conn })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }

  notify.passwordLink({ userId: id, token: link.token, purpose, actorId: req.user.id })
  res.json({ user: await findUser(id), password_delivery: EMAIL })
})

// Step 1 of a reset: who may reset whom. Runs before the body is looked at.
async function checkResetAllowed(req, res, next) {
  const { id } = req.valid.params

  // Your own password needs your current one, so it goes through POST /api/auth/change-password instead
  if (id === req.user.id) {
    throw new HttpError(403, 'Use Change password for your own account')
  }

  const [existing] = await pool.query('SELECT id, role FROM users WHERE id = ?', [id])
  if (existing.length === 0) {
    throw new HttpError(404, 'User not found')
  }
  if (req.user.role === 'hr' && existing[0].role !== 'employee') {
    throw new HttpError(403, 'HR can only reset passwords of employee accounts')
  }
  next()
}

// POST /api/users/:id/reset-password (admin and HR), no body
// The old password stops working at once, must_change_password is set, and the account is unlocked (wrong-password
// count and lock cleared). Deactivated accounts can be reset too.
// Email set up → 200 { user, password_delivery: 'email' }: the password becomes one nobody knows, and the user gets a
//   one-time 'reset' link (48 hours) by email after the commit, to choose a new one.
// Not set up → 200 { user, temporaryPassword, password_delivery: 'temporary_password' }: a new temporary password,
//   returned only here, which the user must change at the next login.
// Sessions: either way every session the user had ends at once (rows revoked, session_version raised; 401 on the next
// request).
router.post(
  '/:id/reset-password',
  requireRole('admin', 'hr'),
  validate(schemas.resetPassword),
  checkResetAllowed,
  validate(schemas.resetPasswordBody),
  async (req, res) => {
    const { id } = req.valid.params

    const byEmail = isEmailConfigured()
    const temporaryPassword = byEmail ? null : makeTemporaryPassword()
    const passwordHash = byEmail ? await unusablePasswordHash() : await bcrypt.hash(temporaryPassword, 10)
    let link = null
    // One transaction: the new hash and flag, and every session of the user ended (their rows revoked, and
    // session_version raised), are saved together or not at all. It also unlocks the account (wrong-password count
    // and lock cleared), so the user can log in with the temporary password straight away.
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      await conn.query(
        `UPDATE users SET password_hash = ?, must_change_password = TRUE, failed_login_count = 0, locked_until = NULL,
           session_version = session_version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [passwordHash, id],
      )
      const ended = await revokeUserSessions(id, { db: conn })
      if (byEmail) link = await issueToken(conn, id, 'reset')
      // Never the temporary password, the link or its token
      await recordAudit('password_reset', {
        actorId: req.user.id,
        targetUserId: id,
        details: { sessions_ended: ended, delivery: byEmail ? EMAIL : TEMPORARY_PASSWORD },
        req,
        db: conn,
      })
      await conn.commit()
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }

    const user = await findUser(id)
    if (!byEmail) {
      return res.json({ user, temporaryPassword, password_delivery: TEMPORARY_PASSWORD })
    }
    // Only after the commit, and not awaited
    notify.passwordLink({ userId: id, token: link.token, purpose: 'reset', actorId: req.user.id })
    res.json({ user, password_delivery: EMAIL })
  },
)

// Step 1 of PATCH: the user must exist (404 comes before any problem with the body), and the caller must be allowed to
// change them. HR may only change employees, and may not send a role at all, whatever its value.
async function loadEditableUser(req, res, next) {
  const { id } = req.valid.params
  const [existing] = await pool.query('SELECT id, name, role, is_active FROM users WHERE id = ?', [id])
  if (existing.length === 0) {
    throw new HttpError(404, 'User not found')
  }

  const isHr = req.user.role === 'hr'
  // HR looks after employee accounts; staff and other HR/admin accounts stay with the admins
  if (isHr && existing[0].role !== 'employee') {
    throw new HttpError(403, 'HR can only change employee accounts')
  }
  // Checked on the raw body, before validation, so even an invalid role from HR is a 403
  if (isHr && req.body && Object.hasOwn(req.body, 'role')) {
    throw new HttpError(403, 'HR cannot change roles')
  }

  req.target = existing[0]
  next()
}

// PATCH /api/users/:id { name?, email?, department_id?, job_title?, role?, is_active? } → the updated user
// Only the fields sent change. Admin: anyone, including their own details (but not their own role or active status),
// and never the last active admin's role or active status. HR: employee accounts only, and never a role.
// Step 2, once the body is valid
async function editUser(req, res) {
  const { id } = req.valid.params
  const { name, email, department_id: departmentId, job_title: jobTitle, role } = req.valid.body
  const isActive = req.valid.body.is_active
  const user = req.target

  // Stops an admin from deactivating themselves or removing their own admin role (and locking themselves out)
  if (id === req.user.id && (role !== undefined || isActive !== undefined)) {
    throw new HttpError(403, 'You cannot change your own role or active status')
  }

  // Emails are unique: check before writing, so the answer is a clear 409 rather than a database error
  if (email !== undefined) {
    const [taken] = await pool.query('SELECT id FROM users WHERE email = ? AND id <> ?', [email, id])
    if (taken.length > 0) {
      throw new HttpError(409, 'An account with this email already exists')
    }
  }

  if (departmentId !== undefined && departmentId !== null) {
    const [departments] = await pool.query('SELECT id FROM departments WHERE id = ?', [departmentId])
    if (departments.length === 0) {
      return fieldError(res, 'department_id', 'Department not found')
    }
  }

  // Only update the fields that were sent. updated_at is set explicitly, because MySQL's ON UPDATE only fires when a
  // value actually changes, and an edit that saves the same values is still an edit.
  const sets = ['updated_at = CURRENT_TIMESTAMP']
  const params = []
  if (name !== undefined) {
    sets.push('name = ?')
    params.push(name)
  }
  if (email !== undefined) {
    sets.push('email = ?')
    params.push(email)
  }
  if (departmentId !== undefined) {
    sets.push('department_id = ?')
    params.push(departmentId)
  }
  if (jobTitle !== undefined) {
    sets.push('job_title = ?')
    params.push(jobTitle || null) // an empty job title is stored as "none"
  }
  if (role !== undefined) {
    sets.push('role = ?')
    params.push(role)
  }
  if (isActive !== undefined) {
    sets.push('is_active = ?')
    params.push(isActive)
  }
  // A role change or deactivation ends the user's sessions (requireAuth refuses tokens with the old session_version).
  // Saving the same role, or deactivating an account that is already inactive, ends nothing. Reactivating doesn't
  // either: the user simply logs in again.
  const roleChanges = role !== undefined && role !== user.role
  const deactivates = isActive === false && Boolean(user.is_active)
  if (roleChanges || deactivates) {
    sets.push('session_version = session_version + 1')
  }

  // If this change means the user can no longer work tickets (moved to a non-staff role such as employee or HR,
  // or deactivated), their unfinished tickets go back to the queue so they don't get stuck with someone who
  // can't act on them
  const newRole = role ?? user.role
  const newActive = isActive ?? Boolean(user.is_active)
  const stopsBeingStaff = isStaff(user) && !(isStaff({ role: newRole }) && newActive)
  const stopsBeingActiveAdmin = user.role === 'admin' && Boolean(user.is_active) && !(newRole === 'admin' && newActive)

  // A transaction so the checks below, the user change and the ticket release happen together or not at all
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // Never leave the system without an active admin. FOR UPDATE locks the admin rows until this commits, so two
    // admins demoting each other at the same moment are handled one after the other, and the second one sees the
    // first one's change
    if (stopsBeingActiveAdmin) {
      const [admins] = await conn.query(
        "SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE AND id <> ? FOR UPDATE",
        [id],
      )
      if (admins.length === 0) {
        throw new HttpError(409, 'This is the last active admin. Make someone else an admin first')
      }
    }

    await conn.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, id])

    // A role change or deactivation ends all of the user's sessions (rows revoked; session_version is raised above too)

    if (roleChanges || deactivates) await revokeUserSessions(id, { db: conn })

    // Audit log, in the same transaction: which detail fields were sent (names only, not their values), and the role
    // and active-status changes as their own events. Nothing is logged for a refused change (it rolls back).
    const editedFields = ['name', 'email', 'department_id', 'job_title'].filter(
      (field) => req.valid.body[field] !== undefined,
    )
    const audit = (action, details) =>
      recordAudit(action, { actorId: req.user.id, targetUserId: id, details, req, db: conn })
    if (editedFields.length > 0) await audit('user_updated', { fields: editedFields })
    if (roleChanges) await audit('role_changed', { from: user.role, to: role })
    if (isActive !== undefined && isActive !== Boolean(user.is_active)) {
      await audit(isActive ? 'user_activated' : 'user_deactivated', null)
    }

    if (stopsBeingStaff) {
      const [tickets] = await conn.query(
        "SELECT id, status FROM tickets WHERE assigned_to = ? AND status NOT IN ('resolved', 'closed')",
        [id],
      )
      for (const ticket of tickets) {
        // Same rule as unassigning on the ticket page: "assigned" goes back to "open", other statuses stay
        const newStatus = ticket.status === 'assigned' ? 'open' : ticket.status
        const change = newStatus !== ticket.status ? statusSets(newStatus) : { sets: [], params: [] }
        await conn.query(`UPDATE tickets SET ${['assigned_to = NULL', ...change.sets].join(', ')} WHERE id = ?`, [
          ...change.params,
          ticket.id,
        ])
        await conn.query(
          'INSERT INTO ticket_history (ticket_id, changed_by, field_changed, old_value, new_value) VALUES (?, ?, ?, ?, ?)',
          [ticket.id, req.user.id, 'assigned_to', user.name, null],
        )
        if (newStatus !== ticket.status) {
          await conn.query(
            'INSERT INTO ticket_history (ticket_id, changed_by, field_changed, old_value, new_value) VALUES (?, ?, ?, ?, ?)',
            [ticket.id, req.user.id, 'status', ticket.status, newStatus],
          )
        }
      }
    }

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    // Two requests taking the same email at once: both pass the check above, and the UNIQUE index stops the second
    if (err.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'An account with this email already exists')
    // The department was deleted between the check above and the update
    if (err.code === 'ER_NO_REFERENCED_ROW_2') return fieldError(res, 'department_id', 'Department not found')
    throw err
  } finally {
    conn.release()
  }

  res.json(await findUser(id))
}

router.patch(
  '/:id',
  requireRole('admin', 'hr'),
  validate(schemas.updateUserParams),
  loadEditableUser,
  validate(schemas.updateUser),
  editUser,
)

module.exports = router
