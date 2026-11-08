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

// Empties users, tickets, comments and ticket_history. Categories, priorities and schema_migrations stay.
async function resetData() {
  assertTestDbName(process.env.DB_NAME); // second safety net: never empty a real database
  // FOREIGN_KEY_CHECKS is per connection, so every statement must run on the same one
  const connection = await pool.getConnection();
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of ['ticket_history', 'comments', 'tickets', 'users']) {
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
  department = null,
  password = DEFAULT_PASSWORD,
  mustChangePassword = false,
} = {}) {
  userCount += 1;
  const user = {
    name: name || `Test ${role} ${userCount}`,
    email: email || `${role}${userCount}.${Date.now()}@test.local`,
    role,
    department,
    is_active: isActive,
  };
  // Cost 4 instead of the app's 10: the hash still works with bcrypt.compare, and tests stay fast
  const passwordHash = await bcrypt.hash(password, 4);
  const [result] = await pool.query(
    'INSERT INTO users (name, email, password_hash, role, department, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [user.name, user.email, passwordHash, user.role, user.department, user.is_active, mustChangePassword]
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

module.exports = { api, resetData, createUser, loginAs, DEFAULT_PASSWORD };
