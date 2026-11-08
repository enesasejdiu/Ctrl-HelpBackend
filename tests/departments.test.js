// Tests for /api/departments: listing with user counts, create/rename/delete for admin and HR, name rules, and
// deleting only empty departments (also when a user is being assigned at the same moment).
const pool = require('../src/db');
const { api, resetData, createUser, loginAs } = require('./helpers');

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const list = (token) => api.get('/api/departments').set(auth(token));
const create = (token, body) => api.post('/api/departments').set(auth(token)).send(body);
const rename = (token, id, body) => api.patch(`/api/departments/${id}`).set(auth(token)).send(body);
const remove = (token, id) => api.delete(`/api/departments/${id}`).set(auth(token));

async function insertDepartment(name) {
  const [result] = await pool.query('INSERT INTO departments (name) VALUES (?)', [name]);
  return result.insertId;
}
async function putInDepartment(user, departmentId) {
  await pool.query('UPDATE users SET department_id = ? WHERE id = ?', [departmentId, user.id]);
}
async function departmentNames() {
  const [rows] = await pool.query('SELECT name FROM departments ORDER BY name');
  return rows.map((r) => r.name);
}

let adminToken, hrToken, employeeToken;

beforeEach(async () => {
  await resetData();
  adminToken = await loginAs(await createUser({ role: 'admin' }));
  hrToken = await loginAs(await createUser({ role: 'hr' }));
  employeeToken = await loginAs(await createUser({ role: 'employee' }));
});

describe('GET /api/departments', () => {
  test.each(['employee', 'agent', 'hr', 'admin'])('a(n) %s sees every department, sorted, with user counts', async (role) => {
    const sales = await insertDepartment('Sales');
    const it = await insertDepartment('IT');
    await insertDepartment('Finance');
    for (let i = 0; i < 2; i += 1) await putInDepartment(await createUser(), it);
    await putInDepartment(await createUser(), sales);

    const res = await list(await loginAs(await createUser({ role })));
    expect(res.status).toBe(200);
    expect(res.body.map((d) => [d.name, d.user_count])).toEqual([
      ['Finance', 0],
      ['IT', 2],
      ['Sales', 1],
    ]);
    expect(Object.keys(res.body[0]).sort()).toEqual(['created_at', 'id', 'name', 'updated_at', 'user_count']);
  });

  test('an empty list is []', async () => {
    expect((await list(employeeToken)).body).toEqual([]);
  });
});

describe('POST /api/departments', () => {
  test.each([
    ['admin', () => adminToken],
    ['hr', () => hrToken],
  ])('%s creates a department; spaces are trimmed and collapsed', async (_, token) => {
    const res = await create(token(), { name: '  Human    Resources ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: expect.any(Number), name: 'Human Resources', user_count: 0 });
    expect(res.body.created_at).toBeTruthy();
    expect(await departmentNames()).toEqual(['Human Resources']);
  });

  test('an employee gets 403 and no token gets 401; nothing is created', async () => {
    expect((await create(employeeToken, { name: 'Sales' })).status).toBe(403);
    expect((await api.post('/api/departments').send({ name: 'Sales' })).status).toBe(401);
    expect(await departmentNames()).toEqual([]);
  });

  test.each([
    ['missing', {}, 'name', 'Name is required'],
    ['null', { name: null }, 'name', 'Name is required'],
    ['empty', { name: '' }, 'name', 'Name is required'],
    ['only spaces', { name: '    ' }, 'name', 'Name is required'],
    ['too long', { name: 'x'.repeat(101) }, 'name', 'Name must be 100 characters or less'],
    ['not text', { name: 42 }, 'name', 'Name must be text'],
    ['an extra field', { name: 'Sales', head_id: 1 }, 'head_id', 'head_id is not allowed'],
  ])('a name that is %s returns 400', async (_, body, field, message) => {
    const res = await create(adminToken, body);
    expect(res.status).toBe(400);
    expect(res.body.errors).toContainEqual({ field, message });
    expect(await departmentNames()).toEqual([]);
  });

  test('100 characters after trimming is fine', async () => {
    const res = await create(adminToken, { name: `  ${'x'.repeat(100)}  ` });
    expect(res.status).toBe(201);
  });

  test.each(['Sales', 'sales', 'SALES', '  sales  '])('"%s" when "Sales" exists returns 409 DEPARTMENT_NAME_TAKEN', async (name) => {
    await insertDepartment('Sales');
    const res = await create(adminToken, { name });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ message: 'A department with this name already exists', code: 'DEPARTMENT_NAME_TAKEN' });
    expect(await departmentNames()).toEqual(['Sales']);
  });
});

describe('PATCH /api/departments/:id', () => {
  test.each([
    ['admin', () => adminToken],
    ['hr', () => hrToken],
  ])('%s renames a department and updated_at moves', async (_, token) => {
    const id = await insertDepartment('Sales');
    await pool.query('UPDATE departments SET updated_at = ? WHERE id = ?', ['2020-01-01 00:00:00', id]);

    const res = await rename(token(), id, { name: ' Sales  and Marketing ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, name: 'Sales and Marketing', user_count: 0 });
    expect(new Date(res.body.updated_at).getFullYear()).toBeGreaterThan(2020);
  });

  test('renaming to its own name is a 200 no-op', async () => {
    const id = await insertDepartment('Sales');
    await pool.query('UPDATE departments SET updated_at = ? WHERE id = ?', ['2020-01-01 00:00:00', id]);
    const res = await rename(adminToken, id, { name: 'Sales' });
    expect(res.status).toBe(200);
    expect(new Date(res.body.updated_at).getFullYear()).toBe(2020);
  });

  test('changing only the letter case is allowed', async () => {
    const id = await insertDepartment('sales');
    const res = await rename(adminToken, id, { name: 'Sales' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Sales');
  });

  test("another department's name, in any case, returns 409 and nothing changes", async () => {
    await insertDepartment('Sales');
    const id = await insertDepartment('Finance');
    for (const name of ['Sales', 'sALES']) {
      const res = await rename(adminToken, id, { name });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DEPARTMENT_NAME_TAKEN');
    }
    expect(await departmentNames()).toEqual(['Finance', 'Sales']);
  });

  test.each([
    ['only spaces', { name: '  ' }],
    ['missing', {}],
    ['too long', { name: 'x'.repeat(101) }],
    ['an extra field', { name: 'New', id: 5 }],
  ])('a body with %s returns 400', async (_, body) => {
    const id = await insertDepartment('Sales');
    expect((await rename(adminToken, id, body)).status).toBe(400);
    expect(await departmentNames()).toEqual(['Sales']);
  });

  test('an employee gets 403, no token gets 401, an unknown id gets 404', async () => {
    const id = await insertDepartment('Sales');
    expect((await rename(employeeToken, id, { name: 'X' })).status).toBe(403);
    expect((await api.patch(`/api/departments/${id}`).send({ name: 'X' })).status).toBe(401);
    expect((await rename(adminToken, 999999, { name: 'X' })).status).toBe(404);
    expect((await rename(adminToken, 999999, {})).status).toBe(404); // 404 before the body is looked at
    expect(await departmentNames()).toEqual(['Sales']);
  });
});

describe('DELETE /api/departments/:id', () => {
  test.each([
    ['admin', () => adminToken],
    ['hr', () => hrToken],
  ])('%s deletes an empty department: 204, and it is gone from the list', async (_, token) => {
    const id = await insertDepartment('Sales');
    const res = await remove(token(), id);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect((await list(employeeToken)).body).toEqual([]);
  });

  test('a department with users returns 409 DEPARTMENT_NOT_EMPTY with the count, and nothing changes', async () => {
    const id = await insertDepartment('Sales');
    const users = [await createUser(), await createUser()];
    for (const user of users) await putInDepartment(user, id);

    const res = await remove(adminToken, id);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      message: 'Move the users out of this department before deleting it',
      code: 'DEPARTMENT_NOT_EMPTY',
      user_count: 2,
    });
    expect(await departmentNames()).toEqual(['Sales']);
    const [rows] = await pool.query('SELECT department_id FROM users WHERE id IN (?)', [users.map((u) => u.id)]);
    expect(rows.map((r) => r.department_id)).toEqual([id, id]);
  });

  test('an employee gets 403, no token gets 401, an unknown id gets 404', async () => {
    const id = await insertDepartment('Sales');
    expect((await remove(employeeToken, id)).status).toBe(403);
    expect((await api.delete(`/api/departments/${id}`)).status).toBe(401);
    expect((await remove(adminToken, 999999)).status).toBe(404);
    expect(await departmentNames()).toEqual(['Sales']);
  });

  // The FK is ON DELETE SET NULL, so a delete racing an assignment could otherwise silently unassign the user.
  // The test starts the assignment in its own transaction, sends the delete while it is still open, then commits.
  test('a user assigned at the same moment is counted, not silently unassigned', async () => {
    const id = await insertDepartment('Sales');
    const user = await createUser();

    const assigner = await pool.getConnection();
    let res;
    try {
      await assigner.beginTransaction();
      await assigner.query('UPDATE users SET department_id = ? WHERE id = ?', [id, user.id]);

      // .then() sends the request now (supertest only sends once something waits for it)
      const deleting = remove(adminToken, id).then((response) => response);
      // Wait until the delete is queued behind the assignment's lock
      for (let i = 0; i < 100; i += 1) {
        const [[{ waiting }]] = await assigner.query(
          "SELECT COUNT(*) AS waiting FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT'"
        );
        if (waiting >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await assigner.commit();
      res = await deleting;
    } finally {
      assigner.release();
    }

    expect(res.status).toBe(409);
    expect(res.body.user_count).toBe(1);
    const [[row]] = await pool.query('SELECT department_id FROM users WHERE id = ?', [user.id]);
    expect(row.department_id).toBe(id);
  });

  test('an assignment that comes after the delete has started fails instead of pointing at nothing', async () => {
    const id = await insertDepartment('Sales');
    const user = await createUser();

    // Hold the department row the way the delete does, then try to assign a user to it from the API
    const deleter = await pool.getConnection();
    let assign;
    try {
      await deleter.beginTransaction();
      await deleter.query('SELECT id FROM departments WHERE id = ? FOR UPDATE', [id]);
      const assigning = api
        .patch(`/api/users/${user.id}`)
        .set(auth(adminToken))
        .send({ department_id: id })
        .then((response) => response); // sends it now, see above
      for (let i = 0; i < 100; i += 1) {
        const [[{ waiting }]] = await deleter.query(
          "SELECT COUNT(*) AS waiting FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT'"
        );
        if (waiting >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await deleter.query('DELETE FROM departments WHERE id = ?', [id]);
      await deleter.commit();
      assign = await assigning;
    } finally {
      deleter.release();
    }

    expect(assign.status).toBe(400);
    expect(assign.body.errors).toEqual([{ field: 'department_id', message: 'Department not found' }]);
    const [[row]] = await pool.query('SELECT department_id FROM users WHERE id = ?', [user.id]);
    expect(row.department_id).toBeNull();
  });
});

describe('users and deleted departments', () => {
  test('POST /api/users and PATCH /api/users/:id with a deleted department return 400', async () => {
    const id = await insertDepartment('Temporary');
    expect((await remove(adminToken, id)).status).toBe(204);

    const created = await api
      .post('/api/users')
      .set(auth(adminToken))
      .send({ name: 'New Person', email: 'new.person@test.local', role: 'employee', department_id: id });
    expect(created.status).toBe(400);
    expect(created.body.errors).toEqual([{ field: 'department_id', message: 'Department not found' }]);

    const target = await createUser();
    const patched = await api.patch(`/api/users/${target.id}`).set(auth(adminToken)).send({ department_id: id });
    expect(patched.status).toBe(400);
    expect(patched.body.errors).toEqual([{ field: 'department_id', message: 'Department not found' }]);
  });
});
