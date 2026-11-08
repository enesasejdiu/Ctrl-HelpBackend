// Tests for /api/users: creating accounts (admin and HR), listing them, and HR's limits when changing them.
// Also checks that HR is treated as an employee everywhere else (tickets, stats).
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const { api, resetData, createUser, loginAs } = require('./helpers');

const auth = (token) => ({ Authorization: `Bearer ${token}` });
let emailCount = 0;
// A valid POST /api/users body; emails stay unique within a test
function newUserBody(role, extra = {}) {
  emailCount += 1;
  return { name: `New ${role}`, email: `new.${role}.${emailCount}@test.local`, role, ...extra };
}
async function userCount() {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM users');
  return n;
}
async function dbUser(id) {
  const [[row]] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  return row;
}

let admin, hr, adminToken, hrToken;

beforeEach(async () => {
  await resetData();
  admin = await createUser({ role: 'admin' });
  hr = await createUser({ role: 'hr' });
  adminToken = await loginAs(admin);
  hrToken = await loginAs(hr);
});

describe('POST /api/users', () => {
  test.each(['employee', 'agent', 'hr', 'admin'])('admin creates a %s with a temporary password', async (role) => {
    const body = newUserBody(role, { department: '  IT  ' });
    const res = await api.post('/api/users').set(auth(adminToken)).send(body);

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      name: body.name,
      email: body.email,
      role,
      department: 'IT', // trimmed
      is_active: true,
      must_change_password: true,
    });
    expect(res.body.user).not.toHaveProperty('password_hash');

    // 12+ characters, letters and digits only, at least one of each
    const { temporaryPassword } = res.body;
    expect(temporaryPassword).toMatch(/^[A-Za-z0-9]{12,}$/);
    expect(temporaryPassword).toMatch(/[A-Za-z]/);
    expect(temporaryPassword).toMatch(/\d/);

    // Only the bcrypt hash is stored, never the password itself
    const row = await dbUser(res.body.user.id);
    expect(row.password_hash).not.toBe(temporaryPassword);
    expect(await bcrypt.compare(temporaryPassword, row.password_hash)).toBe(true);
    expect(row.must_change_password).toBe(1);
  });

  test('HR creates an employee', async () => {
    const res = await api.post('/api/users').set(auth(hrToken)).send(newUserBody('employee'));
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ role: 'employee', must_change_password: true });
  });

  test.each(['agent', 'admin', 'hr'])('HR creating a %s gets 403 and nothing is saved', async (role) => {
    const before = await userCount();
    const res = await api.post('/api/users').set(auth(hrToken)).send(newUserBody(role));
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('HR can only create employee accounts');
    expect(await userCount()).toBe(before);
  });

  test.each(['employee', 'agent'])('a(n) %s gets 403', async (role) => {
    const token = await loginAs(await createUser({ role }));
    const before = await userCount();
    const res = await api.post('/api/users').set(auth(token)).send(newUserBody('employee'));
    expect(res.status).toBe(403);
    expect(await userCount()).toBe(before);
  });

  test('without a token returns 401', async () => {
    const res = await api.post('/api/users').send(newUserBody('employee'));
    expect(res.status).toBe(401);
  });

  test('an existing email returns 409, also with different case and spaces', async () => {
    const existing = await createUser({ email: 'taken@test.local' });
    const before = await userCount();
    for (const email of [existing.email, '  TAKEN@Test.Local ']) {
      const res = await api.post('/api/users').set(auth(adminToken)).send(newUserBody('employee', { email }));
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('An account with this email already exists');
    }
    expect(await userCount()).toBe(before);
  });

  test('the email is stored trimmed and lowercased', async () => {
    const res = await api
      .post('/api/users')
      .set(auth(adminToken))
      .send(newUserBody('employee', { email: '  Mixed.Case@Test.Local ' }));
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('mixed.case@test.local');
  });

  test.each([
    ['name missing', { name: undefined }, 'name', 'Name is required'],
    ['bad email', { email: 'not-an-email' }, 'email', 'Enter a valid email'],
    ['role missing', { role: undefined }, 'role', 'Role is required'],
    ['unknown role', { role: 'superuser' }, 'role', 'Invalid role'],
    ['password sent', { password: 'chosen-by-client' }, 'password', 'password is not allowed'],
    ['flag sent', { must_change_password: false }, 'must_change_password', 'must_change_password is not allowed'],
  ])('invalid body (%s) returns 400', async (_, change, field, message) => {
    const before = await userCount();
    const res = await api.post('/api/users').set(auth(adminToken)).send(newUserBody('employee', change));
    expect(res.status).toBe(400);
    expect(res.body.errors).toContainEqual({ field, message });
    expect(await userCount()).toBe(before);
  });

  test('the temporary password logs in, and the user must change it', async () => {
    const created = await api.post('/api/users').set(auth(hrToken)).send(newUserBody('employee'));
    const { user, temporaryPassword } = created.body;

    const login = await api.post('/api/auth/login').send({ email: user.email, password: temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ id: user.id, must_change_password: true });

    const me = await api.get('/api/auth/me').set(auth(login.body.token));
    expect(me.body.must_change_password).toBe(true);
  });

  test('every new account gets a different temporary password', async () => {
    const a = await api.post('/api/users').set(auth(adminToken)).send(newUserBody('employee'));
    const b = await api.post('/api/users').set(auth(adminToken)).send(newUserBody('employee'));
    expect(a.body.temporaryPassword).not.toBe(b.body.temporaryPassword);
  });
});

describe('GET /api/users', () => {
  test.each([
    ['admin', () => adminToken],
    ['hr', () => hrToken],
  ])('%s sees every account, without password hashes', async (_, token) => {
    const employee = await createUser();
    const res = await api.get('/api/users').set(auth(token()));
    expect(res.status).toBe(200);
    expect(res.body.map((u) => u.id).sort()).toEqual([admin.id, hr.id, employee.id].sort());
    for (const u of res.body) {
      expect(u).not.toHaveProperty('password_hash');
      expect(typeof u.must_change_password).toBe('boolean');
    }
  });

  test.each(['employee', 'agent'])('a(n) %s gets 403', async (role) => {
    const token = await loginAs(await createUser({ role }));
    const res = await api.get('/api/users').set(auth(token));
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/users/:id as HR', () => {
  test('HR deactivates and reactivates an employee', async () => {
    const employee = await createUser();

    const off = await api.patch(`/api/users/${employee.id}`).set(auth(hrToken)).send({ is_active: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ id: employee.id, is_active: false });

    const on = await api.patch(`/api/users/${employee.id}`).set(auth(hrToken)).send({ is_active: true });
    expect(on.status).toBe(200);
    expect(on.body.is_active).toBe(true);
  });

  test.each(['agent', 'admin', 'hr'])('HR changing a(n) %s account gets 403', async (role) => {
    const other = await createUser({ role });
    const res = await api.patch(`/api/users/${other.id}`).set(auth(hrToken)).send({ is_active: false });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('HR can only change employee accounts');
    expect((await dbUser(other.id)).is_active).toBe(1);
  });

  test.each(['agent', 'employee'])('HR sending a role (even "%s") gets 403', async (role) => {
    const employee = await createUser();
    const res = await api.patch(`/api/users/${employee.id}`).set(auth(hrToken)).send({ role });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('HR cannot change roles');
    expect((await dbUser(employee.id)).role).toBe('employee');
  });

  test('HR cannot change their own account', async () => {
    const res = await api.patch(`/api/users/${hr.id}`).set(auth(hrToken)).send({ is_active: false });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/users/:id as admin', () => {
  test('admin can make someone HR and change HR accounts', async () => {
    const employee = await createUser();
    const promoted = await api.patch(`/api/users/${employee.id}`).set(auth(adminToken)).send({ role: 'hr' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.role).toBe('hr');

    const off = await api.patch(`/api/users/${hr.id}`).set(auth(adminToken)).send({ is_active: false });
    expect(off.status).toBe(200);
  });

  test('changing an unknown user returns 404', async () => {
    const res = await api.patch('/api/users/999999').set(auth(adminToken)).send({ is_active: false });
    expect(res.status).toBe(404);
  });

  test('moving an agent to HR unassigns their unfinished tickets', async () => {
    const agent = await createUser({ role: 'agent' });
    const requester = await createUser();
    const ticketId = await createTicket(await loginAs(requester));
    await api.patch(`/api/tickets/${ticketId}/assign`).set(auth(adminToken)).send({ assigned_to: agent.id });

    const res = await api.patch(`/api/users/${agent.id}`).set(auth(adminToken)).send({ role: 'hr' });
    expect(res.status).toBe(200);
    const [[ticket]] = await pool.query('SELECT assigned_to, status FROM tickets WHERE id = ?', [ticketId]);
    expect(ticket).toEqual({ assigned_to: null, status: 'open' });
  });
});

// Creates a ticket through the API and returns its id
async function createTicket(token) {
  const [[category]] = await pool.query('SELECT id FROM categories LIMIT 1');
  const [[priority]] = await pool.query('SELECT id FROM priorities LIMIT 1');
  const res = await api
    .post('/api/tickets')
    .set(auth(token))
    .send({ title: 'Test ticket', description: 'Something broke', category_id: category.id, priority_id: priority.id });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe('HR is an employee for tickets and stats', () => {
  test('HR creates tickets and sees only their own', async () => {
    const other = await createUser();
    const otherTicket = await createTicket(await loginAs(other));
    const ownTicket = await createTicket(hrToken);

    const list = await api.get('/api/tickets').set(auth(hrToken));
    expect(list.status).toBe(200);
    expect(list.body.map((t) => t.id)).toEqual([ownTicket]);

    const own = await api.get(`/api/tickets/${ownTicket}`).set(auth(hrToken));
    expect(own.status).toBe(200);
    const foreign = await api.get(`/api/tickets/${otherTicket}`).set(auth(hrToken));
    expect(foreign.status).toBe(403);
  });

  test('HR gets 403 on the stats, the agent list, priority and assignment', async () => {
    const ticketId = await createTicket(hrToken);
    const [[priority]] = await pool.query('SELECT id FROM priorities ORDER BY level DESC LIMIT 1');

    expect((await api.get('/api/stats').set(auth(hrToken))).status).toBe(403);
    expect((await api.get('/api/users/agents').set(auth(hrToken))).status).toBe(403);
    const prio = await api.patch(`/api/tickets/${ticketId}/priority`).set(auth(hrToken)).send({ priority_id: priority.id });
    expect(prio.status).toBe(403);
    const assign = await api.patch(`/api/tickets/${ticketId}/assign`).set(auth(hrToken)).send({ assigned_to: hr.id });
    expect(assign.status).toBe(403);
  });

  test("HR can't write or read internal notes", async () => {
    const ticketId = await createTicket(hrToken);
    const own = await api
      .post(`/api/tickets/${ticketId}/comments`)
      .set(auth(hrToken))
      .send({ content: 'Trying an internal note', is_internal: true });
    expect(own.status).toBe(201);
    expect(own.body.is_internal).toBe(false);

    await api
      .post(`/api/tickets/${ticketId}/comments`)
      .set(auth(adminToken))
      .send({ content: 'Staff only', is_internal: true });
    const res = await api.get(`/api/tickets/${ticketId}`).set(auth(hrToken));
    expect(res.body.comments.map((c) => c.content)).toEqual(['Trying an internal note']);
  });

  test('HR can only close or reopen their own resolved ticket, like an employee', async () => {
    const ticketId = await createTicket(hrToken);
    const res = await api.patch(`/api/tickets/${ticketId}/status`).set(auth(hrToken)).send({ status: 'in_progress' });
    expect(res.status).toBe(403);
  });
});
