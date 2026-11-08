// Helpers for API tests. Everything here works on the test database only (see tests/setupEnv.js).
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const pool = require('../src/db');
const { assertTestDbName } = require('./testDb');

// A supertest client for the app (src/app.js has no app.listen), e.g. await api.get('/api/health')
const api = request(app);

const DEFAULT_PASSWORD = 'password123';
let userCount = 0;

// Empties users, departments, tickets, comments and ticket_history. Categories, priorities and schema_migrations stay.
async function resetData() {
  assertTestDbName(process.env.DB_NAME); // second safety net: never empty a real database
  // FOREIGN_KEY_CHECKS is per connection, so every statement must run on the same one
  const connection = await pool.getConnection();
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of ['ticket_history', 'comments', 'tickets', 'users', 'departments']) {
      await connection.query(`TRUNCATE TABLE ${table}`);
    }
  } finally {
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    connection.release();
  }
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
  userCount += 1;
  const user = {
    name: name || `Test ${role} ${userCount}`,
    email: email || `${role}${userCount}.${Date.now()}@test.local`,
    role,
    department_id: departmentId,
    job_title: jobTitle,
    is_active: isActive,
  };
  // Cost 4 instead of the app's 10: the hash still works with bcrypt.compare, and tests stay fast
  const passwordHash = await bcrypt.hash(password, 4);
  const [result] = await pool.query(
    'INSERT INTO users (name, email, password_hash, role, department_id, job_title, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [user.name, user.email, passwordHash, user.role, user.department_id, user.job_title, user.is_active, mustChangePassword]
  );
  return { id: result.insertId, ...user, password };
}

// Logs in through the API, like the frontend does, and returns the token
async function loginAs(user) {
  const res = await api.post('/api/auth/login').send({ email: user.email, password: user.password });
  if (res.status !== 200) {
    throw new Error(`loginAs(${user.email}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

// The Authorization header for a token, e.g. api.get(path).set(auth(token))
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function dbUser(id) {
  const [[row]] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  return row;
}

// Inserts a department straight into the database and returns its id. Names are unique per run unless given.
let departmentCount = 0;
async function createDepartment(name) {
  departmentCount += 1;
  const [result] = await pool.query('INSERT INTO departments (name) VALUES (?)', [name || `Test department ${departmentCount}`]);
  return result.insertId;
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
  };
  for (const user of Object.values(callers)) user.token = await loginAs(user);
  return callers;
}

// Asserts an error response in the API's format: { message, code? } (plus any extra fields, e.g. user_count)
function expectError(res, status, code, message) {
  expect({ status: res.status, code: res.body.code }).toEqual({ status, code });
  expect(typeof res.body.message).toBe('string');
  expect(res.body.message.length).toBeGreaterThan(0);
  if (message !== undefined) expect(res.body.message).toEqual(message);
}

// Asserts that no password hash is anywhere in a response body (as a field, or as a bcrypt-looking value)
function expectNoPasswordHash(body) {
  const text = JSON.stringify(body ?? null);
  expect(text).not.toMatch(/password_hash/i);
  expect(text).not.toMatch(/\$2[aby]\$\d{2}\$/);
}

// Every row of the tables the API can change, for "nothing changed" assertions:
// expect(await dbSnapshot()).toEqual(before)
async function dbSnapshot() {
  const snapshot = {};
  for (const table of ['users', 'departments', 'tickets', 'comments', 'ticket_history']) {
    const [rows] = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
    snapshot[table] = rows;
  }
  return snapshot;
}

module.exports = {
  api,
  resetData,
  createUser,
  loginAs,
  DEFAULT_PASSWORD,
  auth,
  dbUser,
  createDepartment,
  createCallers,
  expectError,
  expectNoPasswordHash,
  dbSnapshot,
};
