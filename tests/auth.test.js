// Tests for /api/auth: self-registration is gone, and login and /me report must_change_password.
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
