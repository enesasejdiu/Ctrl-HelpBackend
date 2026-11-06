// Ticket routes: list, create, view, and change status / priority / assignee.
// Mounted at /api/tickets; every route requires a logged-in user.
// Employees only ever see their own tickets; staff (agents and admins) see and manage all of them.
// Every change to status, priority or assignee is recorded in ticket_history.
const express = require('express');
const pool = require('../db');
const { HttpError } = require('../middleware/errors');
const { requireAuth, requireRole, isStaff } = require('../middleware/auth');
const { OVERDUE_SQL } = require('../overdue');

const router = express.Router();

const STATUSES = ['open', 'assigned', 'in_progress', 'waiting_for_user', 'resolved', 'closed', 'reopened'];

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
  JOIN priorities p ON p.id = t.priority_id`;

// MySQL returns booleans as 0/1; send real true/false to the client
function formatTicket(row) {
  return { ...row, is_overdue: Boolean(row.is_overdue) };
}

// Reads a body field as a trimmed string ('' if missing or not a string)
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Parses a positive integer id from a URL param or body field; null if invalid
function toId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Records one change in the ticket's audit trail; values are stored as display text (e.g. names, not ids)
async function logHistory(ticketId, userId, field, oldValue, newValue) {
  await pool.query(
    'INSERT INTO ticket_history (ticket_id, changed_by, field_changed, old_value, new_value) VALUES (?, ?, ?, ?, ?)',
    [ticketId, userId, field, oldValue, newValue]
  );
}

// Fetches one ticket and checks the user may see it (employees: only their own)
async function loadTicket(id, user) {
  const ticketId = toId(id);
  const [rows] = ticketId ? await pool.query(`${TICKET_SELECT} WHERE t.id = ?`, [ticketId]) : [[]];
  if (rows.length === 0) {
    throw new HttpError(404, 'Ticket not found');
  }
  const ticket = formatTicket(rows[0]);
  if (!isStaff(user) && ticket.requester_id !== user.id) {
    throw new HttpError(403, 'You can only view your own tickets');
  }
  return ticket;
}

router.use(requireAuth);

// GET /api/tickets?status=&priority=&category=&assigned=me|unassigned&q=&overdue=1
router.get('/', async (req, res) => {
  // text() ignores anything that isn't a single string, e.g. ?status=a&status=b (which Express turns into an array)
  const status = text(req.query.status);
  const priority = text(req.query.priority);
  const category = text(req.query.category);
  const assigned = text(req.query.assigned);
  const q = text(req.query.q);
  const overdue = text(req.query.overdue);

  // Filters are collected as SQL fragments with ? placeholders, and their values go into params
  const where = [];
  const params = [];

  if (!isStaff(req.user)) {
    where.push('t.requester_id = ?');
    params.push(req.user.id);
  }
  if (status) {
    where.push('t.status = ?');
    params.push(status);
  }
  if (priority) {
    where.push('t.priority_id = ?');
    params.push(priority);
  }
  if (category) {
    where.push('t.category_id = ?');
    params.push(category);
  }
  if (assigned === 'me') {
    where.push('t.assigned_to = ?');
    params.push(req.user.id);
  } else if (assigned === 'unassigned') {
    where.push('t.assigned_to IS NULL');
  }
  if (q) {
    where.push('(t.title LIKE ? OR t.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (overdue === '1') {
    where.push(OVERDUE_SQL);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // t.id breaks ties between tickets created in the same second
  const [rows] = await pool.query(
    `${TICKET_SELECT} ${whereSql} ORDER BY p.level DESC, t.created_at DESC, t.id DESC`,
    params
  );
  res.json(rows.map(formatTicket));
});

// POST /api/tickets { title, description, category_id, priority_id }
router.post('/', async (req, res) => {
  const body = req.body || {};
  const title = text(body.title);
  const description = text(body.description);
  const categoryId = toId(body.category_id);
  const priorityId = toId(body.priority_id);

  if (!title || !description || !categoryId || !priorityId) {
    throw new HttpError(400, 'Title, description, category and priority are required');
  }
  if (title.length > 150) {
    throw new HttpError(400, 'Title must be at most 150 characters');
  }

  const [categories] = await pool.query('SELECT id FROM categories WHERE id = ?', [categoryId]);
  if (categories.length === 0) {
    throw new HttpError(400, 'Invalid category');
  }
  const [priorities] = await pool.query('SELECT id FROM priorities WHERE id = ?', [priorityId]);
  if (priorities.length === 0) {
    throw new HttpError(400, 'Invalid priority');
  }

  const [result] = await pool.query(
    'INSERT INTO tickets (title, description, requester_id, category_id, priority_id) VALUES (?, ?, ?, ?, ?)',
    [title, description, req.user.id, categoryId, priorityId]
  );
  await logHistory(result.insertId, req.user.id, 'status', null, 'open');

  res.status(201).json(await loadTicket(result.insertId, req.user));
});

// GET /api/tickets/:id → ticket + comments + history (oldest first)
router.get('/:id', async (req, res) => {
  const ticket = await loadTicket(req.params.id, req.user);

  // Internal notes are staff-only
  const internalFilter = isStaff(req.user) ? '' : 'AND c.is_internal = FALSE';
  const [comments] = await pool.query(
    `SELECT c.*, u.name AS author_name, u.role AS author_role
     FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.ticket_id = ? ${internalFilter}
     ORDER BY c.created_at, c.id`,
    [ticket.id]
  );
  const [history] = await pool.query(
    `SELECT h.*, u.name AS changed_by_name
     FROM ticket_history h JOIN users u ON u.id = h.changed_by
     WHERE h.ticket_id = ?
     ORDER BY h.changed_at, h.id`,
    [ticket.id]
  );

  res.json({
    ...ticket,
    comments: comments.map((c) => ({ ...c, is_internal: Boolean(c.is_internal) })),
    history,
  });
});

// POST /api/tickets/:id/comments { content, is_internal }
router.post('/:id/comments', async (req, res) => {
  const ticket = await loadTicket(req.params.id, req.user);
  const content = text(req.body?.content);

  if (!content) {
    throw new HttpError(400, 'Comment cannot be empty');
  }
  // Only staff can write internal notes; an employee's is_internal flag is ignored
  const isInternal = isStaff(req.user) && req.body?.is_internal === true;

  const [result] = await pool.query(
    'INSERT INTO comments (ticket_id, user_id, content, is_internal) VALUES (?, ?, ?, ?)',
    [ticket.id, req.user.id, content, isInternal]
  );
  const [rows] = await pool.query(
    `SELECT c.*, u.name AS author_name, u.role AS author_role
     FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.id = ?`,
    [result.insertId]
  );

  res.status(201).json({ ...rows[0], is_internal: Boolean(rows[0].is_internal) });
});

// PATCH /api/tickets/:id/status { status, resolution? }
router.patch('/:id/status', async (req, res) => {
  const ticket = await loadTicket(req.params.id, req.user);
  const status = text(req.body?.status);

  if (!STATUSES.includes(status)) {
    throw new HttpError(400, `Status must be one of: ${STATUSES.join(', ')}`);
  }
  if (status === ticket.status) {
    throw new HttpError(400, `Ticket is already ${status}`);
  }

  // Employees may only confirm a fix (close it) or say it isn't fixed (reopen it)
  if (!isStaff(req.user)) {
    const canClose = status === 'closed' && ticket.status === 'resolved';
    const canReopen = status === 'reopened' && ['resolved', 'closed'].includes(ticket.status);
    if (!canClose && !canReopen) {
      throw new HttpError(403, 'You can only close or reopen your resolved tickets');
    }
  }

  const sets = ['status = ?'];
  const params = [status];

  if (status === 'resolved') {
    // A new note replaces the old one; otherwise keep the note from an earlier resolve
    const resolution = text(req.body?.resolution) || ticket.resolution;
    if (!resolution) {
      throw new HttpError(400, 'Please write a resolution note');
    }
    sets.push('resolution = ?', 'resolved_at = NOW()');
    params.push(resolution);
  } else if (status === 'closed') {
    // resolved_at stays: closed tickets still count as resolved in the statistics
    sets.push('closed_at = NOW()');
  } else {
    // Back to an unfinished status: the statistics treat resolved_at as "this ticket is resolved".
    // The resolution text stays, to show as the previous resolution and prefill the next one.
    sets.push('resolved_at = NULL');
  }
  if (status !== 'closed') {
    sets.push('closed_at = NULL');
  }

  await pool.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`, [...params, ticket.id]);
  await logHistory(ticket.id, req.user.id, 'status', ticket.status, status);

  res.json(await loadTicket(ticket.id, req.user));
});

// PATCH /api/tickets/:id/priority { priority_id } (staff only)
router.patch('/:id/priority', requireRole('agent', 'admin'), async (req, res) => {
  const ticket = await loadTicket(req.params.id, req.user);
  const priorityId = toId(req.body?.priority_id);

  const [rows] = priorityId ? await pool.query('SELECT id, name FROM priorities WHERE id = ?', [priorityId]) : [[]];
  if (rows.length === 0) {
    throw new HttpError(400, 'Invalid priority');
  }

  // Nothing to change or log if the priority is the same
  if (priorityId !== ticket.priority_id) {
    await pool.query('UPDATE tickets SET priority_id = ? WHERE id = ?', [priorityId, ticket.id]);
    await logHistory(ticket.id, req.user.id, 'priority', ticket.priority_name, rows[0].name);
  }

  res.json(await loadTicket(ticket.id, req.user));
});

// PATCH /api/tickets/:id/assign { assigned_to } (staff only; null = unassign)
router.patch('/:id/assign', requireRole('agent', 'admin'), async (req, res) => {
  const ticket = await loadTicket(req.params.id, req.user);
  const raw = req.body?.assigned_to;

  if (raw === undefined) {
    throw new HttpError(400, 'assigned_to is required (use null to unassign)');
  }
  const assigneeId = raw === null ? null : toId(raw);
  if (raw !== null && !assigneeId) {
    throw new HttpError(400, 'That user cannot be assigned tickets');
  }

  // Agents can take a ticket, or release one they hold, but not hand tickets to others
  if (req.user.role === 'agent') {
    const takingIt = assigneeId === req.user.id;
    const releasingOwn = assigneeId === null && ticket.assigned_to === req.user.id;
    if (!takingIt && !releasingOwn) {
      throw new HttpError(403, 'Agents can only assign tickets to themselves');
    }
  }

  let assigneeName = null;
  if (assigneeId !== null) {
    const [users] = await pool.query(
      "SELECT name FROM users WHERE id = ? AND is_active = TRUE AND role IN ('agent', 'admin')",
      [assigneeId]
    );
    if (users.length === 0) {
      throw new HttpError(400, 'That user cannot be assigned tickets');
    }
    assigneeName = users[0].name;
  }

  // Assigning moves a new/reopened ticket to "assigned"; unassigning moves it back to "open"
  let newStatus = ticket.status;
  if (assigneeId !== null && ['open', 'reopened'].includes(ticket.status)) {
    newStatus = 'assigned';
  } else if (assigneeId === null && ticket.status === 'assigned') {
    newStatus = 'open';
  }

  await pool.query('UPDATE tickets SET assigned_to = ?, status = ? WHERE id = ?', [assigneeId, newStatus, ticket.id]);
  if (assigneeId !== ticket.assigned_to) {
    await logHistory(ticket.id, req.user.id, 'assigned_to', ticket.assignee_name, assigneeName);
  }
  if (newStatus !== ticket.status) {
    await logHistory(ticket.id, req.user.id, 'status', ticket.status, newStatus);
  }

  res.json(await loadTicket(ticket.id, req.user));
});

module.exports = router;
