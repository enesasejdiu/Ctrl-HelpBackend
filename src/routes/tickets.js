// Ticket routes: list, create, view, and change status / priority / assignee.
// Mounted at /api/tickets; every route requires a logged-in user.
// Employees only ever see their own tickets; staff (agents and admins) see and manage all of them.
// Every change to status, priority or assignee is recorded in ticket_history.
// Emails (src/mail/notifications.js) go out after a change is saved, in the background: a new ticket, an assignment,
// a comment and a resolve each notify the people involved. A failed email never fails the request.
const express = require('express')
const pool = require('../db')
const { HttpError } = require('../middleware/errors')
const { requireAuth, requireRole, isStaff } = require('../middleware/auth')
const validate = require('../middleware/validate')
const { OVERDUE_SQL } = require('../overdue')
const schemas = require('../schemas/tickets')
const { addComment } = require('../schemas/comments')
const notify = require('../mail/notifications')
const { statusSets } = require('../ticketStatus')
const settings = require('../settings')
const { canSeeTicket, listAttachments } = require('../attachments')
const { receiveFiles, uploadAttachments, listTicketAttachments } = require('./attachments')

const router = express.Router()

// Base query for a ticket with all its display names; append WHERE / ORDER BY as needed
const TICKET_SELECT = `
  SELECT t.*,
    requester.name AS requester_name,
    assignee.name AS assignee_name,
    c.name AS category_name,
    p.name AS priority_name,
    p.level AS priority_level,
    p.target_hours,
    ${OVERDUE_SQL} AS is_overdue
  FROM tickets t
  JOIN users requester ON requester.id = t.requester_id
  LEFT JOIN users assignee ON assignee.id = t.assigned_to
  JOIN categories c ON c.id = t.category_id
  JOIN priorities p ON p.id = t.priority_id`

// MySQL returns booleans as 0/1; send real true/false to the client
function formatTicket(row) {
  return { ...row, is_overdue: Boolean(row.is_overdue) }
}

// Records one change in the ticket's audit trail; values are stored as display text (e.g. names, not ids)
async function logHistory(ticketId, userId, field, oldValue, newValue) {
  await pool.query(
    'INSERT INTO ticket_history (ticket_id, changed_by, field_changed, old_value, new_value) VALUES (?, ?, ?, ?, ?)',
    [ticketId, userId, field, oldValue, newValue],
  )
}

// Fetches one ticket and checks the user may see it (employees: only their own)
async function loadTicket(id, user) {
  const [rows] = await pool.query(`${TICKET_SELECT} WHERE t.id = ?`, [id])
  if (rows.length === 0) {
    throw new HttpError(404, 'Ticket not found')
  }
  const ticket = formatTicket(rows[0])
  if (!canSeeTicket(user, ticket.requester_id)) {
    throw new HttpError(403, 'You can only view your own tickets')
  }
  return ticket
}

router.use(requireAuth)

// GET /api/tickets?status=&priority=&category=&assigned=me|unassigned&q=&overdue=1
router.get('/', validate(schemas.listTickets), async (req, res) => {
  const { status, priority, category, assigned, q, overdue } = req.valid.query

  // Filters are collected as SQL fragments with ? placeholders, and their values go into params
  const where = []
  const params = []

  if (!isStaff(req.user)) {
    where.push('t.requester_id = ?')
    params.push(req.user.id)
  }
  if (status) {
    where.push('t.status = ?')
    params.push(status)
  }
  if (priority) {
    where.push('t.priority_id = ?')
    params.push(priority)
  }
  if (category) {
    where.push('t.category_id = ?')
    params.push(category)
  }
  if (assigned === 'me') {
    where.push('t.assigned_to = ?')
    params.push(req.user.id)
  } else if (assigned === 'unassigned') {
    where.push('t.assigned_to IS NULL')
  }
  if (q) {
    where.push('(t.title LIKE ? OR t.description LIKE ?)')
    params.push(`%${q}%`, `%${q}%`)
  }
  if (overdue) {
    where.push(OVERDUE_SQL)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  // t.id breaks ties between tickets created in the same second
  const [rows] = await pool.query(
    `${TICKET_SELECT} ${whereSql} ORDER BY p.level DESC, t.created_at DESC, t.id DESC`,
    params,
  )
  res.json(rows.map(formatTicket))
})

// An archived category or priority can't be given to a ticket (old tickets that have one keep it)
const inactive = (what) =>
  new HttpError(422, `This ${what} is archived and can't be chosen`, `${what.toUpperCase()}_INACTIVE`, {
    errors: [{ field: `${what}_id`, message: `This ${what} is archived and can't be chosen` }],
  })

// POST /api/tickets { title, description, category_id, priority_id? }
// priority_id left out: the default priority. Unknown ids → 400 Invalid category/priority; archived ones → 422
// CATEGORY_INACTIVE / PRIORITY_INACTIVE.
router.post('/', validate(schemas.createTicket), async (req, res) => {
  const { title, description, category_id: categoryId } = req.valid.body

  const category = await settings.usableCategory(categoryId)
  if (category.problem === 'missing') throw new HttpError(400, 'Invalid category')
  if (category.problem === 'inactive') throw inactive('category')

  let priorityId = req.valid.body.priority_id
  if (priorityId == null) {
    const fallback = await settings.defaultPriority()
    if (!fallback) throw new HttpError(400, 'Choose a priority (no default priority is set)')
    priorityId = fallback.id
  } else {
    const priority = await settings.usablePriority(priorityId)
    if (priority.problem === 'missing') throw new HttpError(400, 'Invalid priority')
    if (priority.problem === 'inactive') throw inactive('priority')
  }

  const [result] = await pool.query(
    'INSERT INTO tickets (title, description, requester_id, category_id, priority_id) VALUES (?, ?, ?, ?, ?)',
    [title, description, req.user.id, categoryId, priorityId],
  )
  await logHistory(result.insertId, req.user.id, 'status', null, 'open')
  notify.ticketCreated({ ticketId: result.insertId, actorId: req.user.id })

  res.status(201).json(await loadTicket(result.insertId, req.user))
})

// GET /api/tickets/:id → ticket + comments + history (oldest first)
router.get('/:id', validate(schemas.getTicket), async (req, res) => {
  const ticket = await loadTicket(req.valid.params.id, req.user)

  // Internal notes are staff-only
  const internalFilter = isStaff(req.user) ? '' : 'AND c.is_internal = FALSE'
  const [comments] = await pool.query(
    `SELECT c.*, u.name AS author_name, u.role AS author_role
     FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.ticket_id = ? ${internalFilter}
     ORDER BY c.created_at, c.id`,
    [ticket.id],
  )
  const [history] = await pool.query(
    `SELECT h.*, COALESCE(u.name, 'System') AS changed_by_name
     FROM ticket_history h LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.ticket_id = ?
     ORDER BY h.changed_at, h.id`,
    [ticket.id],
  )

  res.json({
    ...ticket,
    comments: comments.map((c) => ({ ...c, is_internal: Boolean(c.is_internal) })),
    history,
    attachments: await listAttachments(pool, ticket.id),
  })
})

// Attachments belong to a ticket, so the same rule decides who may list or add them: the requester and staff.
// The ticket is checked BEFORE the upload is read, so nobody can make the server read files for a ticket they can't see.
async function loadVisibleTicket(req, res, next) {
  req.ticket = await loadTicket(req.valid.params.id, req.user)
  next()
}

// GET /api/tickets/:id/attachments → [{ id, ticket_id, original_name, mime_type, size_bytes, uploaded_by, created_at }]
router.get('/:id/attachments', validate(schemas.getTicket), loadVisibleTicket, listTicketAttachments)

// POST /api/tickets/:id/attachments (multipart, field "files", 1–5 files of up to 10 MB) → 201 the new attachments.
// See routes/attachments.js for the checks and errors.
router.post('/:id/attachments', validate(schemas.getTicket), loadVisibleTicket, receiveFiles, uploadAttachments)

// POST /api/tickets/:id/comments { content, is_internal }
router.post('/:id/comments', validate(addComment), async (req, res) => {
  const ticket = await loadTicket(req.valid.params.id, req.user)
  const { content, is_internal: wantsInternal } = req.valid.body

  // Only staff can write internal notes; an employee's is_internal flag is ignored
  const isInternal = isStaff(req.user) && wantsInternal === true

  const [result] = await pool.query(
    'INSERT INTO comments (ticket_id, user_id, content, is_internal) VALUES (?, ?, ?, ?)',
    [ticket.id, req.user.id, content, isInternal],
  )
  const [rows] = await pool.query(
    `SELECT c.*, u.name AS author_name, u.role AS author_role
     FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.id = ?`,
    [result.insertId],
  )
  // Internal notes send nothing (see notifications.commentAdded)
  notify.commentAdded({ commentId: result.insertId, actorId: req.user.id })

  res.status(201).json({ ...rows[0], is_internal: Boolean(rows[0].is_internal) })
})

// PATCH /api/tickets/:id/status { status, resolution? }
router.patch('/:id/status', validate(schemas.updateStatus), async (req, res) => {
  const ticket = await loadTicket(req.valid.params.id, req.user)
  const { status } = req.valid.body

  if (status === ticket.status) {
    throw new HttpError(400, `Ticket is already ${status}`)
  }

  // Employees may only confirm a fix (close it) or say it isn't fixed (reopen it)
  if (!isStaff(req.user)) {
    const canClose = status === 'closed' && ticket.status === 'resolved'
    const canReopen = status === 'reopened' && ['resolved', 'closed'].includes(ticket.status)
    if (!canClose && !canReopen) {
      throw new HttpError(403, 'You can only close or reopen your resolved tickets')
    }
  }

  // The status and its timestamps (resolved_at, closed_at) come from src/ticketStatus.js, like every status change.
  // Going back to an unfinished status keeps the resolution text, to show as the previous resolution and prefill the
  // next one.
  const { sets, params } = statusSets(status)

  if (status === 'resolved') {
    // A new note replaces the old one; otherwise keep the note from an earlier resolve
    const resolution = req.valid.body.resolution || ticket.resolution
    if (!resolution) {
      throw new HttpError(400, 'Please write a resolution note')
    }
    sets.push('resolution = ?')
    params.push(resolution)
  }

  await pool.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`, [...params, ticket.id])
  await logHistory(ticket.id, req.user.id, 'status', ticket.status, status)
  if (status === 'resolved') {
    notify.ticketResolved({ ticketId: ticket.id, actorId: req.user.id })
  }

  res.json(await loadTicket(ticket.id, req.user))
})

// PATCH /api/tickets/:id/priority { priority_id } (staff only)
router.patch('/:id/priority', requireRole('agent', 'admin'), validate(schemas.updatePriority), async (req, res) => {
  const ticket = await loadTicket(req.valid.params.id, req.user)
  const { priority_id: priorityId } = req.valid.body

  const priority = await settings.usablePriority(priorityId)
  if (priority.problem === 'missing') {
    throw new HttpError(400, 'Invalid priority')
  }

  // Nothing to change or log if the priority is the same (a ticket may keep an archived one it already has)
  if (priorityId !== ticket.priority_id) {
    if (priority.problem === 'inactive') throw inactive('priority')
    await pool.query('UPDATE tickets SET priority_id = ? WHERE id = ?', [priorityId, ticket.id])
    await logHistory(ticket.id, req.user.id, 'priority', ticket.priority_name, priority.row.name)
  }

  res.json(await loadTicket(ticket.id, req.user))
})

// PATCH /api/tickets/:id/assign { assigned_to } (staff only; null = unassign)
router.patch('/:id/assign', requireRole('agent', 'admin'), validate(schemas.assignTicket), async (req, res) => {
  const ticket = await loadTicket(req.valid.params.id, req.user)
  const { assigned_to: assigneeId } = req.valid.body

  // Agents can take a ticket, or release one they hold, but not hand tickets to others
  if (req.user.role === 'agent') {
    const takingIt = assigneeId === req.user.id
    const releasingOwn = assigneeId === null && ticket.assigned_to === req.user.id
    if (!takingIt && !releasingOwn) {
      throw new HttpError(403, 'Agents can only assign tickets to themselves')
    }
  }

  let assigneeName = null
  if (assigneeId !== null) {
    const [users] = await pool.query(
      "SELECT name FROM users WHERE id = ? AND is_active = TRUE AND role IN ('agent', 'admin')",
      [assigneeId],
    )
    if (users.length === 0) {
      throw new HttpError(400, 'That user cannot be assigned tickets')
    }
    assigneeName = users[0].name
  }

  // Assigning moves a new/reopened ticket to "assigned"; unassigning moves it back to "open"
  let newStatus = ticket.status
  if (assigneeId !== null && ['open', 'reopened'].includes(ticket.status)) {
    newStatus = 'assigned'
  } else if (assigneeId === null && ticket.status === 'assigned') {
    newStatus = 'open'
  }

  // The status (and its timestamps) only changes when it moves; src/ticketStatus.js knows what that means
  const change = newStatus !== ticket.status ? statusSets(newStatus) : { sets: [], params: [] }
  await pool.query(`UPDATE tickets SET ${['assigned_to = ?', ...change.sets].join(', ')} WHERE id = ?`, [
    assigneeId,
    ...change.params,
    ticket.id,
  ])
  if (assigneeId !== ticket.assigned_to) {
    await logHistory(ticket.id, req.user.id, 'assigned_to', ticket.assignee_name, assigneeName)
    // The new assignee hears about it (not when they took the ticket themselves; notifications skip the actor)
    if (assigneeId !== null) {
      notify.ticketAssigned({ ticketId: ticket.id, assigneeId, actorId: req.user.id })
    }
  }
  if (newStatus !== ticket.status) {
    await logHistory(ticket.id, req.user.id, 'status', ticket.status, newStatus)
  }

  res.json(await loadTicket(ticket.id, req.user))
})

module.exports = router
