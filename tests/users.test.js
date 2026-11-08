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
// resetData() leaves departments alone, so each one gets a name of its own
let departmentCount = 0;
async function createDepartment() {
  departmentCount += 1;
  const [result] = await pool.query('INSERT INTO departments (name) VALUES (?)', [`Department ${departmentCount}`]);
  return result.insertId;
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
    const departmentId = await createDepartment();
    const body = newUserBody(role, { department_id: departmentId });
    const res = await api.post('/api/users').set(auth(adminToken)).send(body);

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      name: body.name,
      email: body.email,
      role,
      department_id: departmentId,
      department_name: `Department ${departmentCount}`,
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
    ['old free-text department sent', { department: 'IT' }, 'department', 'department is not allowed'],
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

  test('HR leaving out the role creates an employee', async () => {
    const { role, ...body } = newUserBody('employee');
    expect(role).toBe('employee');
    const res = await api.post('/api/users').set(auth(hrToken)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('employee');
  });

  test('an admin leaving out the role gets 400 and nothing is saved', async () => {
    const { role, ...body } = newUserBody('employee');
    expect(role).toBe('employee');
    const before = await userCount();
    const res = await api.post('/api/users').set(auth(adminToken)).send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Role is required', errors: [{ field: 'role', message: 'Role is required' }] });
    expect(await userCount()).toBe(before);
  });

  test('saves department_id and job_title, and returns them', async () => {
    const departmentId = await createDepartment();
    const res = await api
      .post('/api/users')
      .set(auth(adminToken))
      .send(newUserBody('employee', { department_id: departmentId, job_title: '  Accountant ' }));

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ department_id: departmentId, job_title: 'Accountant' });
    const row = await dbUser(res.body.user.id);
    expect([row.department_id, row.job_title]).toEqual([departmentId, 'Accountant']);
  });

  test('department_id and job_title can be left out, and are then empty', async () => {
    const res = await api.post('/api/users').set(auth(adminToken)).send(newUserBody('employee'));
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ department_id: null, job_title: null });
  });

  test('a department_id that does not exist returns 400 and nothing is saved', async () => {
    const before = await userCount();
    const res = await api.post('/api/users').set(auth(adminToken)).send(newUserBody('employee', { department_id: 999999 }));
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([{ field: 'department_id', message: 'Department not found' }]);
    expect(await userCount()).toBe(before);
  });

  test.each([
    ['department_id not a number', { department_id: 'IT' }, 'department_id', 'Department id must be a number'],
    ['department_id zero', { department_id: 0 }, 'department_id', 'Department id must be a positive number'],
    ['job_title too long', { job_title: 'x'.repeat(256) }, 'job_title', 'Job title must be 255 characters or less'],
  ])('invalid body (%s) returns 400', async (_, change, field, message) => {
    const res = await api.post('/api/users').set(auth(adminToken)).send(newUserBody('employee', change));
    expect(res.status).toBe(400);
    expect(res.body.errors).toContainEqual({ field, message });
  });

  test('the response never contains a password hash', async () => {
    const res = await api.post('/api/users').set(auth(adminToken)).send(newUserBody('agent'));
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|\$2[aby]\$/);
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

  test('HR cannot change their own account (HR only changes employees)', async () => {
    const res = await api.patch(`/api/users/${hr.id}`).set(auth(hrToken)).send({ is_active: false });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('HR can only change employee accounts');
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

describe('POST /api/users/:id/reset-password', () => {
  const reset = (id, token) => api.post(`/api/users/${id}/reset-password`).set(auth(token));

  test.each(['agent', 'hr', 'employee', 'admin'])('admin resets a(n) %s', async (role) => {
    const target = await createUser({ role });
    const res = await reset(target.id, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: target.id, role, must_change_password: true });
    expect(res.body.user).not.toHaveProperty('password_hash');
    expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{12,}$/);
    expect((await dbUser(target.id)).must_change_password).toBe(1);
  });

  test('HR resets an employee', async () => {
    const target = await createUser();
    const res = await reset(target.id, hrToken);
    expect(res.status).toBe(200);
    expect(res.body.user.must_change_password).toBe(true);
  });

  test.each(['agent', 'admin', 'hr'])('HR resetting a(n) %s gets 403 and the password stays', async (role) => {
    const target = await createUser({ role });
    const before = (await dbUser(target.id)).password_hash;
    const res = await reset(target.id, hrToken);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('HR can only reset passwords of employee accounts');
    expect((await dbUser(target.id)).password_hash).toBe(before);
  });

  test.each(['employee', 'agent'])('a(n) %s gets 403', async (role) => {
    const target = await createUser();
    const res = await reset(target.id, await loginAs(await createUser({ role })));
    expect(res.status).toBe(403);
  });

  test.each([
    ['admin', () => [admin, adminToken]],
    ['HR', () => [hr, hrToken]],
  ])('%s resetting their own account gets 403 and the password stays', async (_, who) => {
    const [me, token] = who();
    const before = (await dbUser(me.id)).password_hash;
    const res = await reset(me.id, token);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Use Change password for your own account');
    expect((await dbUser(me.id)).password_hash).toBe(before);
  });

  test('an unknown user returns 404', async () => {
    expect((await reset(999999, adminToken)).status).toBe(404);
  });

  test('a non-numeric id returns 400', async () => {
    const res = await reset('abc', adminToken);
    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe('id');
  });

  test('a deactivated account can be reset too', async () => {
    const target = await createUser({ isActive: false });
    expect((await reset(target.id, adminToken)).status).toBe(200);
  });

  test('the old password stops working, the new one logs in, and the user must change it', async () => {
    const target = await createUser();
    const oldToken = await loginAs(target);
    const res = await reset(target.id, adminToken);
    const { temporaryPassword } = res.body;

    const oldLogin = await api.post('/api/auth/login').send({ email: target.email, password: target.password });
    expect(oldLogin.status).toBe(401);
    const newLogin = await api.post('/api/auth/login').send({ email: target.email, password: temporaryPassword });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.user.must_change_password).toBe(true);

    // Any session the user still has is blocked until they choose a new password
    const blocked = await api.get('/api/tickets').set(auth(oldToken));
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  test('every reset gives a different password', async () => {
    const target = await createUser();
    const a = await reset(target.id, adminToken);
    const b = await reset(target.id, adminToken);
    expect(a.body.temporaryPassword).not.toBe(b.body.temporaryPassword);
  });

  test.each([
    ['a chosen password', { password: 'MyChoice123' }, 'password', 'password is not allowed'],
    ['any other field', { notify: true }, 'notify', 'notify is not allowed'],
    ['a JSON array', [], 'body', 'Request body must be a JSON object'],
  ])('a body with %s returns 400 and the password stays', async (_, body, field, message) => {
    const target = await createUser();
    const before = (await dbUser(target.id)).password_hash;
    const res = await api.post(`/api/users/${target.id}/reset-password`).set(auth(adminToken)).send(body);
    expect(res.status).toBe(400);
    expect(res.body.errors).toContainEqual({ field, message });
    expect((await dbUser(target.id)).password_hash).toBe(before);
  });

  test('an empty JSON body is the same as no body', async () => {
    const target = await createUser();
    const res = await api.post(`/api/users/${target.id}/reset-password`).set(auth(adminToken)).send({});
    expect(res.status).toBe(200);
  });

  test('an unknown user returns 404 before the body is looked at', async () => {
    const res = await api.post('/api/users/999999/reset-password').set(auth(adminToken)).send({ password: 'x' });
    expect(res.status).toBe(404);
  });

  test('without a token returns 401', async () => {
    const target = await createUser();
    expect((await api.post(`/api/users/${target.id}/reset-password`)).status).toBe(401);
  });

  test('stores only a bcrypt hash of the new password, and moves updated_at forward', async () => {
    const target = await createUser();
    await pool.query('UPDATE users SET updated_at = ? WHERE id = ?', ['2020-01-01 00:00:00', target.id]);
    const res = await reset(target.id, adminToken);

    const row = await dbUser(target.id);
    expect(row.password_hash).not.toBe(res.body.temporaryPassword);
    expect(row.password_hash).toMatch(/^\$2[aby]\$10\$/);
    expect(await bcrypt.compare(res.body.temporaryPassword, row.password_hash)).toBe(true);
    expect(row.updated_at.getFullYear()).toBeGreaterThan(2020);
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|\$2[aby]\$/);
  });

  test("a session from before the reset can't use the app or change the password without the new one", async () => {
    const target = await createUser();
    const oldToken = await loginAs(target);
    await reset(target.id, adminToken);

    const change = await api
      .post('/api/auth/change-password')
      .set(auth(oldToken))
      .send({ currentPassword: target.password, newPassword: 'Attacker1234' });
    expect(change.status).toBe(400);
    expect(change.body.code).toBe('INVALID_CURRENT_PASSWORD');
    for (const path of ['/api/tickets', '/api/meta']) {
      expect((await api.get(path).set(auth(oldToken))).status).toBe(403);
    }
  });

  test('the temporary password is never written to the console', async () => {
    const target = await createUser();
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
    try {
      const res = await reset(target.id, adminToken);
      expect(res.status).toBe(200);
      const written = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n');
      expect(written).not.toContain(res.body.temporaryPassword);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

describe('PATCH /api/users/:id edits name and email', () => {
  const patch = (id, token, body) => api.patch(`/api/users/${id}`).set(auth(token)).send(body);

  test.each([
    ['name', { name: '  Renamed Person  ' }, { name: 'Renamed Person' }],
    ['email', { email: '  New.Address@Test.Local ' }, { email: 'new.address@test.local' }],
    ['job title', { job_title: ' Analyst ' }, { job_title: 'Analyst' }],
    ['job title to empty', { job_title: '   ' }, { job_title: null }],
  ])('admin edits %s', async (_, body, expected) => {
    const target = await createUser({ role: 'agent' });
    const res = await patch(target.id, adminToken, body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: target.id, ...expected });
    expect(res.body).not.toHaveProperty('password_hash');
    const row = await dbUser(target.id);
    for (const [key, value] of Object.entries(expected)) expect(row[key]).toBe(value);
  });

  test('admin edits several fields at once, and the user logs in with the new email', async () => {
    const target = await createUser();
    const departmentId = await createDepartment();
    const res = await patch(target.id, adminToken, { name: 'Both Changed', email: 'both@test.local', department_id: departmentId });
    expect(res.status).toBe(200);
    const login = await api.post('/api/auth/login').send({ email: 'both@test.local', password: target.password });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({
      name: 'Both Changed',
      department_id: departmentId,
      department_name: `Department ${departmentCount}`,
    });
  });

  test('admin edits their own details, but not their own role or active status', async () => {
    const own = await patch(admin.id, adminToken, { name: 'Head Admin', job_title: 'Director' });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ name: 'Head Admin', job_title: 'Director', role: 'admin' });

    for (const body of [{ role: 'agent' }, { is_active: false }, { name: 'X', role: 'employee' }]) {
      const res = await patch(admin.id, adminToken, body);
      expect(res.status).toBe(403);
      expect(res.body.message).toBe('You cannot change your own role or active status');
    }
    expect((await dbUser(admin.id)).name).toBe('Head Admin');
  });

  test("HR edits an employee's details", async () => {
    const employee = await createUser();
    const res = await patch(employee.id, hrToken, { name: 'Edited By HR', email: 'edited.by.hr@test.local', job_title: 'Clerk' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Edited By HR', email: 'edited.by.hr@test.local', job_title: 'Clerk' });
  });

  test.each(['agent', 'admin', 'hr'])("HR editing a(n) %s's details gets 403 and nothing changes", async (role) => {
    const other = await createUser({ role, name: 'Original Name' });
    const res = await patch(other.id, hrToken, { name: 'Hacked' });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('HR can only change employee accounts');
    expect((await dbUser(other.id)).name).toBe('Original Name');
  });

  test('HR sending a role together with details gets 403 and nothing changes', async () => {
    const employee = await createUser({ name: 'Original Name' });
    const res = await patch(employee.id, hrToken, { name: 'New Name', role: 'employee' });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('HR cannot change roles');
    expect((await dbUser(employee.id)).name).toBe('Original Name');
  });

  test("HR can't edit their own details (HR only edits employees)", async () => {
    const res = await patch(hr.id, hrToken, { name: 'Me Myself' });
    expect(res.status).toBe(403);
  });

  test('an email used by someone else returns 409, also with different case and spaces', async () => {
    await createUser({ email: 'taken@test.local' });
    const target = await createUser({ email: 'mine@test.local' });
    for (const email of ['taken@test.local', '  TAKEN@Test.Local ']) {
      const res = await patch(target.id, adminToken, { email });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('An account with this email already exists');
    }
    expect((await dbUser(target.id)).email).toBe('mine@test.local');
  });

  test('keeping your current email (any case) is not a conflict', async () => {
    const target = await createUser({ email: 'same@test.local' });
    const res = await patch(target.id, adminToken, { email: 'SAME@test.local' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('same@test.local');
  });

  test.each([
    ['invalid email', { email: 'not-an-email' }, 'email', 'Enter a valid email'],
    ['empty name', { name: '   ' }, 'name', 'Name is required'],
    ['the old free-text department', { department: 'IT' }, 'department', 'department is not allowed'],
    ['unknown field', { password: 'sneaky123' }, 'password', 'password is not allowed'],
  ])('%s returns 400', async (_, body, field, message) => {
    const target = await createUser();
    const res = await patch(target.id, adminToken, body);
    expect(res.status).toBe(400);
    expect(res.body.errors).toContainEqual({ field, message });
  });

  test('an empty body returns 400', async () => {
    const target = await createUser();
    const res = await patch(target.id, adminToken, {});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(
      'Send at least one of name, email, department_id, job_title, role or is_active to change'
    );
  });
});

describe('PATCH /api/users/:id: department_id, job_title, order of checks, timestamps', () => {
  const patch = (id, token, body) => api.patch(`/api/users/${id}`).set(auth(token)).send(body);

  test.each(['employee', 'hr', 'admin'])('admin edits every field of a(n) %s', async (role) => {
    const target = await createUser({ role });
    const departmentId = await createDepartment();
    const body = {
      name: 'All Fields',
      email: `all.fields.${role}@test.local`,
      department_id: departmentId,
      job_title: 'Team Lead',
    };
    const res = await patch(target.id, adminToken, body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: target.id, role, ...body });
  });

  test('HR edits department_id and job_title of an employee', async () => {
    const employee = await createUser();
    const departmentId = await createDepartment();
    const res = await patch(employee.id, hrToken, { department_id: departmentId, job_title: 'Clerk' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ department_id: departmentId, job_title: 'Clerk' });
  });

  test('null clears department_id and job_title', async () => {
    const employee = await createUser();
    await patch(employee.id, adminToken, { department_id: await createDepartment(), job_title: 'Clerk' });

    const res = await patch(employee.id, adminToken, { department_id: null, job_title: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ department_id: null, job_title: null });
    const row = await dbUser(employee.id);
    expect([row.department_id, row.job_title]).toEqual([null, null]);
  });

  test('a partial update leaves every other field as it was', async () => {
    const departmentId = await createDepartment();
    const target = await createUser({ name: 'Keep Me', departmentId });
    await patch(target.id, adminToken, { job_title: 'Engineer' });
    const before = await dbUser(target.id);

    const res = await patch(target.id, adminToken, { job_title: 'Senior Engineer' });
    expect(res.status).toBe(200);
    const after = await dbUser(target.id);
    const { job_title: _old, updated_at: _a, ...restBefore } = before;
    const { job_title: changed, updated_at: _b, ...restAfter } = after;
    expect(changed).toBe('Senior Engineer');
    expect(restAfter).toEqual(restBefore);
  });

  test('a department_id that does not exist returns 400 and nothing changes', async () => {
    const target = await createUser({ name: 'Unchanged' });
    const res = await patch(target.id, adminToken, { name: 'Changed', department_id: 999999 });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([{ field: 'department_id', message: 'Department not found' }]);
    expect((await dbUser(target.id)).name).toBe('Unchanged');
  });

  test.each([
    ['must_change_password', { must_change_password: false }],
    ['last_login_at', { last_login_at: '2026-01-01T00:00:00Z' }],
    ['created_at', { created_at: '2020-01-01T00:00:00Z' }],
    ['id', { id: 1 }],
    ['password_hash', { password_hash: 'x' }],
  ])('sending %s returns 400 naming the field', async (field, body) => {
    const target = await createUser();
    const res = await patch(target.id, adminToken, body);
    expect(res.status).toBe(400);
    expect(res.body.errors).toContainEqual({ field, message: `${field} is not allowed` });
  });

  test('an unknown user returns 404, even when the body is invalid', async () => {
    const res = await patch(999999, adminToken, { email: 'not-an-email', password: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('User not found');
  });

  test('HR sending an invalid role still gets 403, not a validation error', async () => {
    const employee = await createUser();
    const res = await patch(employee.id, hrToken, { role: 'superuser' });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('HR cannot change roles');
  });

  test('an employee gets 403 and no token gets 401', async () => {
    const target = await createUser();
    const employeeToken = await loginAs(await createUser());
    expect((await patch(target.id, employeeToken, { name: 'Nope' })).status).toBe(403);
    expect((await api.patch(`/api/users/${target.id}`).send({ name: 'Nope' })).status).toBe(401);
    expect((await dbUser(target.id)).name).not.toBe('Nope');
  });

  test('returns last_login_at and updated_at, moves updated_at forward, and never the password hash', async () => {
    const target = await createUser();
    await pool.query('UPDATE users SET updated_at = ? WHERE id = ?', ['2020-01-01 00:00:00', target.id]);

    const res = await patch(target.id, adminToken, { name: target.name }); // same value: still an edit
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('last_login_at', null);
    expect(new Date(res.body.updated_at).getFullYear()).toBeGreaterThan(2020);
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|\$2[aby]\$/);
  });
});

describe('PATCH /api/users/:id never removes the last active admin', () => {
  const patch = (id, token, body) => api.patch(`/api/users/${id}`).set(auth(token)).send(body);

  test('an admin changes another admin to another role', async () => {
    const other = await createUser({ role: 'admin' });
    const res = await patch(other.id, adminToken, { role: 'agent' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('agent');
  });

  // With the API's other rules (no changing your own role, HR never touches admins) the only way to reach zero admins
  // is two admins demoting each other at the same moment. The test holds a lock on the users table so both requests
  // are waiting at once, then lets them go: the second must see the first one's change and get 409.
  test.each([
    ['role', { role: 'agent' }],
    ['active status', { is_active: false }],
  ])('two admins removing each other (%s) at the same moment: one succeeds, the other gets 409', async (_, body) => {
    await pool.query("UPDATE users SET role = 'employee' WHERE role = 'admin'"); // only the two below are admins
    const a = await createUser({ role: 'admin' });
    const b = await createUser({ role: 'admin' });
    const [tokenA, tokenB] = [await loginAs(a), await loginAs(b)];

    const blocker = await pool.getConnection();
    let results;
    try {
      await blocker.beginTransaction();
      await blocker.query("SELECT id FROM users WHERE role = 'admin' FOR UPDATE");

      const requests = Promise.all([patch(b.id, tokenA, body), patch(a.id, tokenB, body)]);
      // Wait until both requests are queued behind the lock
      for (let i = 0; i < 100; i += 1) {
        const [[{ waiting }]] = await blocker.query(
          "SELECT COUNT(*) AS waiting FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT'"
        );
        if (waiting >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await blocker.commit();
      results = await requests;
    } finally {
      blocker.release();
    }

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409).body.message).toBe(
      'This is the last active admin. Make someone else an admin first'
    );
    const [[{ admins }]] = await pool.query(
      "SELECT COUNT(*) AS admins FROM users WHERE role = 'admin' AND is_active = TRUE"
    );
    expect(admins).toBe(1);
  });
});
