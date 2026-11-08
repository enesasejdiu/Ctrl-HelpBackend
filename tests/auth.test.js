// Tests for /api/auth: self-registration is gone, login and /me report must_change_password, change-password,
// and the rule that blocks a user with a temporary password until they change it.
const { api, resetData, createUser, loginAs } = require('./helpers');

beforeEach(resetData);

describe('self-registration', () => {
  test('POST /api/auth/register returns 404 and creates nothing', async () => {
    const res = await api.post('/api/auth/register').send({
      name: 'Someone',
      email: 'someone@test.local',
      password: 'password123',
    });
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/Route not found/);

    const login = await api.post('/api/auth/login').send({ email: 'someone@test.local', password: 'password123' });
    expect(login.status).toBe(401);
  });
});

describe('must_change_password', () => {
  test('login and /me return false for an account that has its own password', async () => {
    const user = await createUser();
    const login = await api.post('/api/auth/login').send({ email: user.email, password: user.password });
    expect(login.status).toBe(200);
    expect(login.body.user.must_change_password).toBe(false);
    expect(login.body.user).not.toHaveProperty('password_hash');

    const me = await api.get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.body.must_change_password).toBe(false);
  });

  test('an HR user can log in and /me shows the hr role', async () => {
    const hr = await createUser({ role: 'hr' });
    const token = await loginAs(hr);
    const me = await api.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: hr.id, role: 'hr', must_change_password: false });
  });
});

describe('POST /api/auth/change-password', () => {
  const NEW_PASSWORD = 'brand-new-pass1';
  const change = (token, body) =>
    api.post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send(body);

  test('without a token returns 401', async () => {
    const res = await api.post('/api/auth/change-password').send({ currentPassword: 'x', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });

  test('a wrong current password returns 401 and changes nothing', async () => {
    const user = await createUser();
    const res = await change(await loginAs(user), { currentPassword: 'not-my-password', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Current password is wrong');
    // The old password still works
    expect((await api.post('/api/auth/login').send({ email: user.email, password: user.password })).status).toBe(200);
  });

  test.each([
    ['too short', 'abc12345', 'New password must be at least 10 characters'],
    ['no number', 'onlyletters', 'New password must contain at least one number'],
    ['no letter', '1234567890', 'New password must contain at least one letter'],
    ['too long', `a1${'x'.repeat(71)}`, 'New password must be 72 characters or less'],
  ])('a weak new password (%s) returns 400 with a clear message', async (_, newPassword, message) => {
    const user = await createUser();
    const res = await change(await loginAs(user), { currentPassword: user.password, newPassword });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
  });

  test('the same password again returns 400', async () => {
    const user = await createUser({ password: 'same-password1' });
    const res = await change(await loginAs(user), { currentPassword: 'same-password1', newPassword: 'same-password1' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('New password must be different from the current one');
  });

  test.each([
    ['missing fields', {}, 'Current password is required'],
    ['an unknown field', { currentPassword: 'x', newPassword: NEW_PASSWORD, userId: 1 }, 'userId is not allowed'],
  ])('%s returns 400', async (_, body, message) => {
    const user = await createUser();
    const res = await change(await loginAs(user), body);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
  });

  test('success clears the flag, the new password logs in and the old one stops working', async () => {
    const user = await createUser({ mustChangePassword: true });
    const res = await change(await loginAs(user), { currentPassword: user.password, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, must_change_password: false });
    expect(res.body.user).not.toHaveProperty('password_hash');

    const oldLogin = await api.post('/api/auth/login').send({ email: user.email, password: user.password });
    expect(oldLogin.status).toBe(401);
    const newLogin = await api.post('/api/auth/login').send({ email: user.email, password: NEW_PASSWORD });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.user.must_change_password).toBe(false);
  });
});

describe('blocking until a temporary password is changed', () => {
  const PASSWORD_CHANGE_REQUIRED = {
    message: 'You must change your password before continuing',
    code: 'PASSWORD_CHANGE_REQUIRED',
  };
  const get = (path, token) => api.get(path).set('Authorization', `Bearer ${token}`);

  test('a flagged user can log in and use /me, but every other endpoint returns 403 PASSWORD_CHANGE_REQUIRED', async () => {
    const user = await createUser({ role: 'admin', mustChangePassword: true });
    const login = await api.post('/api/auth/login').send({ email: user.email, password: user.password });
    expect(login.status).toBe(200);
    expect(login.body.user.must_change_password).toBe(true);
    const token = login.body.token;

    expect((await get('/api/auth/me', token)).status).toBe(200);
    expect((await get('/api/auth/me/', token)).status).toBe(200);
    for (const path of ['/api/tickets', '/api/tickets?status=open', '/api/meta', '/api/users', '/api/stats']) {
      const res = await get(path, token);
      expect([path, res.status, res.body]).toEqual([path, 403, PASSWORD_CHANGE_REQUIRED]);
    }
    const create = await api
      .post('/api/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'x', description: 'y', category_id: 1, priority_id: 1 });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  test('after changing the password the same token works everywhere', async () => {
    const user = await createUser({ mustChangePassword: true });
    const token = await loginAs(user);
    expect((await get('/api/tickets', token)).status).toBe(403);

    const res = await api
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: user.password, newPassword: 'my-own-password9' });
    expect(res.status).toBe(200);
    expect((await get('/api/tickets', token)).status).toBe(200);
  });

  test('an account created by an admin is blocked until its temporary password is changed', async () => {
    const admin = await createUser({ role: 'admin' });
    const created = await api
      .post('/api/users')
      .set('Authorization', `Bearer ${await loginAs(admin)}`)
      .send({ name: 'New Person', email: 'new.person@test.local', role: 'employee' });
    const { temporaryPassword } = created.body;

    const login = await api.post('/api/auth/login').send({ email: 'new.person@test.local', password: temporaryPassword });
    expect((await get('/api/tickets', login.body.token)).body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    await api
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ currentPassword: temporaryPassword, newPassword: 'chosen-by-me1' });
    expect((await get('/api/tickets', login.body.token)).status).toBe(200);
  });

  test('an unflagged user is never blocked', async () => {
    const user = await createUser({ role: 'agent' });
    const token = await loginAs(user);
    for (const path of ['/api/auth/me', '/api/tickets', '/api/meta', '/api/users/agents']) {
      expect([path, (await get(path, token)).status]).toEqual([path, 200]);
    }
  });

  test('other errors never leak a code (e.g. a 404 has only a message)', async () => {
    const res = await api.get('/api/nope');
    expect(res.status).toBe(404);
    expect(Object.keys(res.body)).toEqual(['message']);
  });
});
