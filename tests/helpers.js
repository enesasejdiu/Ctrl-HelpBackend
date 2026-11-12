// Helpers for API tests. Everything here works on the test database only (see tests/setupEnv.js).
const request = require('supertest')
const bcrypt = require('bcryptjs')
const app = require('../src/app')
const pool = require('../src/db')
const settings = require('../src/settings')
const reference = require('../scripts/reference-data')
const { assertTestDbName } = require('./testDb')
const { step } = require('./slowHooks')
const notifications = require('../src/mail/notifications')
const { getMailer, resetMailer } = require('../src/mail/mailer')

// A supertest client for the app (src/app.js has no app.listen), e.g. await api.get('/api/health')
const api = request(app)

const DEFAULT_PASSWORD = 'password123'
let userCount = 0

// Empties audit_log, attachments, sessions, password_tokens, users, departments, tickets, comments and ticket_history,
// and puts the standard categories, priorities and company name back (restoreReferenceData). schema_migrations stays.
async function resetData() {
  assertTestDbName(process.env.DB_NAME) // second safety net: never empty a real database
  // FOREIGN_KEY_CHECKS is per connection, so every statement must run on the same one
  const connection = await step('resetData: get a pool connection', () => pool.getConnection())
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0')
    for (const table of [
      'audit_log',
      'attachments',
      'sessions',
      'password_tokens',
      'ticket_history',
      'comments',
      'tickets',
      'users',
      'departments',
    ]) {
      await step(`resetData: TRUNCATE ${table}`, () => connection.query(`TRUNCATE TABLE ${table}`))
    }
  } finally {
    await connection.query('SET FOREIGN_KEY_CHECKS = 1')
    connection.release()
  }
  await restoreReferenceData()
}

// Puts the standard categories and priorities back (with ids 1, 2, … in list order, so tests can send category_id: 1)
// and the built-in company name and auto_close_days (7), and clears the settings cache. Admins can change all of these through the API, and
// resetData() doesn't empty them, so without this one test file's changes would leak into the next (same database):
// tests/auth-enforcement.test.js calls every route as an admin, and its DELETE /api/categories/1 and
// DELETE /api/priorities/1 really deleted Hardware and Low. Empties tickets (and what hangs off them) too, since every
// ticket points at a category and a priority.
async function restoreReferenceData() {
  assertTestDbName(process.env.DB_NAME)
  const connection = await step('restoreReferenceData: get a pool connection', () => pool.getConnection())
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0')
    for (const table of ['attachments', 'ticket_history', 'comments', 'tickets', 'categories', 'priorities']) {
      await step(`restoreReferenceData: TRUNCATE ${table}`, () => connection.query(`TRUNCATE TABLE ${table}`))
    }
    for (const [index, [name, description]] of reference.categories.entries()) {
      await connection.query('INSERT INTO categories (name, description, sort_order) VALUES (?, ?, ?)', [
        name,
        description,
        index + 1,
      ])
    }
    for (const [name, level, hours] of reference.priorities) {
      await connection.query('INSERT INTO priorities (name, level, target_hours, is_default) VALUES (?, ?, ?, ?)', [
        name,
        level,
        hours,
        name === reference.defaultPriority,
      ])
    }
  } finally {
    await connection.query('SET FOREIGN_KEY_CHECKS = 1')
    connection.release()
  }
  await pool.query("UPDATE settings SET setting_value = 'TicketFlow' WHERE setting_key = 'company_name'")
  await pool.query("UPDATE settings SET setting_value = '7' WHERE setting_key = 'auto_close_days'")
  settings.clearCache()
}

// Inserts a user straight into the database. Returns the user's columns plus `password` (plain text), for loginAs.
async function createUser({
  role = 'employee',
  isActive = true,
  name,
  email,
  departmentId = null,
  jobTitle = null,
  password = DEFAULT_PASSWORD,
  mustChangePassword = false,
} = {}) {
  userCount += 1
  const user = {
    name: name || `Test ${role} ${userCount}`,
    email: email || `${role}${userCount}.${Date.now()}@test.local`,
    role,
    department_id: departmentId,
    job_title: jobTitle,
    is_active: isActive,
  }
  // Cost 4 instead of the app's 10: the hash still works with bcrypt.compare, and tests stay fast
  const passwordHash = await step('createUser: bcrypt.hash', () => bcrypt.hash(password, 4))
  const [result] = await step('createUser: INSERT INTO users', () =>
    pool.query(
      'INSERT INTO users (name, email, password_hash, role, department_id, job_title, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        user.name,
        user.email,
        passwordHash,
        user.role,
        user.department_id,
        user.job_title,
        user.is_active,
        mustChangePassword,
      ],
    ),
  )
  return { id: result.insertId, ...user, password }
}

// The tf_session cookie a response set (login, change-password), or undefined. The token is never in the body.
function sessionOf(res) {
  for (const line of res.headers['set-cookie'] || []) {
    const [pair] = line.split(';')
    const [name, ...value] = pair.trim().split('=')
    if (name === 'tf_session' && value.join('=')) return decodeURIComponent(value.join('='))
  }
  return undefined
}

// Logs in through the API, like the frontend does, and returns the session (the tf_session cookie's value)
async function loginAs(user) {
  const res = await step(`loginAs(${user.email})`, () =>
    api.post('/api/auth/login').send({ email: user.email, password: user.password }),
  )
  if (res.status !== 200) {
    throw new Error(`loginAs(${user.email}) failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return sessionOf(res)
}

// Headers that send a session the way a browser does: the tf_session cookie, plus a tf_csrf cookie and the matching
// X-CSRF-Token header (double-submit: the backend only checks that the two are equal, so any value works).
// Use with any method, e.g. api.post(path).set(auth(session)).send(body)
const TEST_CSRF = 'test-csrf-token'
const auth = (session) => ({ Cookie: `tf_session=${session}; tf_csrf=${TEST_CSRF}`, 'X-CSRF-Token': TEST_CSRF })

async function dbUser(id) {
  const [[row]] = await pool.query('SELECT * FROM users WHERE id = ?', [id])
  return row
}

// Inserts a department straight into the database and returns its id. Names are unique per run unless given.
let departmentCount = 0
async function createDepartment(name) {
  departmentCount += 1
  const [result] = await pool.query('INSERT INTO departments (name) VALUES (?)', [
    name || `Test department ${departmentCount}`,
  ])
  return result.insertId
}

// One user of every kind, logged in: admin, a second admin (for last-admin rules), hr, agent, employee, and a user who
// still has a temporary password (flagged). Each entry is the createUser() result plus its `token`.
async function createCallers() {
  const callers = {
    admin: await createUser({ role: 'admin' }),
    admin2: await createUser({ role: 'admin' }),
    hr: await createUser({ role: 'hr' }),
    agent: await createUser({ role: 'agent' }),
    employee: await createUser({ role: 'employee' }),
    flagged: await createUser({ role: 'admin', mustChangePassword: true }),
  }
  for (const user of Object.values(callers)) user.token = await loginAs(user)
  return callers
}

// Asserts an error response in the API's format: { message, code? } (plus any extra fields, e.g. user_count)
function expectError(res, status, code, message) {
  expect({ status: res.status, code: res.body.code }).toEqual({ status, code })
  expect(typeof res.body.message).toBe('string')
  expect(res.body.message.length).toBeGreaterThan(0)
  if (message !== undefined) expect(res.body.message).toEqual(message)
}

// Asserts that no password hash is anywhere in a response body (as a field, or as a bcrypt-looking value)
function expectNoPasswordHash(body) {
  const text = JSON.stringify(body ?? null)
  expect(text).not.toMatch(/password_hash/i)
  expect(text).not.toMatch(/\$2[aby]\$\d{2}\$/)
}

// Every row of the tables the API can change, for "nothing changed" assertions:
// expect(await dbSnapshot()).toEqual(before)
async function dbSnapshot() {
  const snapshot = {}
  for (const table of ['users', 'departments', 'tickets', 'comments', 'ticket_history', 'password_tokens']) {
    const [rows] = await pool.query(`SELECT * FROM ${table} ORDER BY id`)
    snapshot[table] = rows
  }
  return snapshot
}

// The emails sent so far in this test (nodemailer jsonTransport; nothing leaves the process), once the background
// notifications have finished. Each is { from, to, subject, text, html, link }. tests/setupAfterEnv.js empties the
// outbox after every test.
async function sentMail() {
  await notifications.settle()
  return [...getMailer().outbox]
}

// The token from the newest set-password email to this address
async function inviteTokenFor(email) {
  const invites = (await sentMail()).filter((mail) => mail.to === email && mail.link?.includes('/set-password?token='))
  if (invites.length === 0) throw new Error(`No set-password email to ${email}`)
  return new URL(invites.at(-1).link).searchParams.get('token')
}

// Email set up (on) or not (off, the default in tests): with it on, new and reset passwords go out as one-time links
// (password_delivery 'email'); off, they are temporary passwords. Nothing is ever sent: NODE_ENV=test keeps
// nodemailer's jsonTransport either way. Call it in a beforeEach/beforeAll, or use emailModeFor(describe-block).
function useEmail(on) {
  process.env.MAIL_ENABLED = on ? 'true' : ''
  process.env.SMTP_HOST = on ? 'smtp.test.invalid' : ''
  process.env.MAIL_FROM = on ? 'TicketFlow <no-reply@test.invalid>' : ''
  resetMailer()
}

// In a describe block: email is set up for its tests, and off again afterwards
function withEmail() {
  beforeEach(() => useEmail(true))
  afterEach(() => useEmail(false))
}

module.exports = {
  useEmail,
  withEmail,
  sentMail,
  inviteTokenFor,
  api,
  resetData,
  restoreReferenceData,
  createUser,
  loginAs,
  sessionOf,
  DEFAULT_PASSWORD,
  auth,
  TEST_CSRF,
  dbUser,
  createDepartment,
  createCallers,
  expectError,
  expectNoPasswordHash,
  dbSnapshot,
}
