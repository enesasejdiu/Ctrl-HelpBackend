// Test data factories, on top of createUser() in tests/helpers.js: a logged-in user of any role, one of every role,
// and tickets with a chosen requester and assignee. Inserted straight into the test database (callers must have run
// assertThrowawayDb() from ./guard.js first).
const pool = require('../../src/db')
const { createUser, loginAs } = require('../helpers')

const ROLES = ['admin', 'hr', 'agent', 'employee']

// A user of `role`, logged in (user.token is the session). Overrides go to createUser (name, email, isActive, ...).
async function userWithRole(role, overrides = {}) {
  const user = await createUser({ role, ...overrides })
  if (user.is_active && !overrides.mustChangePassword) user.token = await loginAs(user)
  return user
}

// One logged-in user of every role: { admin, hr, agent, employee }
async function oneOfEachRole(overrides = {}) {
  const users = {}
  for (const role of ROLES) users[role] = await userWithRole(role, overrides[role])
  return users
}

let ticketCount = 0
// A ticket raised by `requester` (a user or id), optionally assigned. Returns the row as stored.
async function createTicket({
  requester,
  assignee = null,
  title,
  description = 'Created by a test factory',
  status,
  priorityLevel,
  createdAt,
} = {}) {
  ticketCount += 1
  const idOf = (user) => (user && typeof user === 'object' ? user.id : user)
  const [[category]] = await pool.query('SELECT id FROM categories ORDER BY id LIMIT 1')
  const [[priority]] = priorityLevel
    ? await pool.query('SELECT id FROM priorities WHERE level = ?', [priorityLevel])
    : await pool.query('SELECT id FROM priorities WHERE is_default = TRUE LIMIT 1')
  const [result] = await pool.query(
    `INSERT INTO tickets (title, description, requester_id, assigned_to, category_id, priority_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      title ?? `Factory ticket ${ticketCount}`,
      description,
      idOf(requester),
      idOf(assignee),
      category.id,
      priority.id,
      status ?? (assignee ? 'assigned' : 'open'),
      createdAt ?? new Date(),
    ],
  )
  const [[row]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [result.insertId])
  return row
}

module.exports = { ROLES, userWithRole, oneOfEachRole, createTicket }
