// Tests for POST /api/auth/change-password: the password rule, a wrong current password, clearing
// must_change_password, sessions, and that generated temporary passwords always pass the rule.
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const { newPassword } = require('../src/schemas/common');
const { makeTemporaryPassword } = require('../src/temporaryPassword');
const { api, resetData, createUser, loginAs, auth, dbUser, dbSnapshot, expectError } = require('./helpers');

beforeEach(resetData);

describe('POST /api/auth/change-password', () => {
  const NEW_PASSWORD = 'brand-new-pass1';
  const change = (token, body) =>
    api.post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send(body);

  test('without a token returns 401', async () => {
    const res = await api.post('/api/auth/change-password').send({ currentPassword: 'x', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });

  test('a wrong current password returns 400 INVALID_CURRENT_PASSWORD, changes nothing, and keeps the session', async () => {
    const user = await createUser({ mustChangePassword: true });
    const token = await loginAs(user);
    const before = await dbUser(user.id);

    const res = await change(token, { currentPassword: 'not-my-password', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Current password is wrong', code: 'INVALID_CURRENT_PASSWORD' });

    expect(await dbUser(user.id)).toEqual(before);
    expect((await api.get('/api/auth/me').set(auth(token))).status).toBe(200);
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

  test('success says so, stores only a bcrypt hash, clears the flag in the database and moves updated_at', async () => {
    const user = await createUser({ mustChangePassword: true });
    await pool.query('UPDATE users SET updated_at = ? WHERE id = ?', ['2020-01-01 00:00:00', user.id]);
    const res = await change(await loginAs(user), { currentPassword: user.password, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Password changed');
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|\$2[aby]\$/);
    const row = await dbUser(user.id);
    expect(row.password_hash).toMatch(/^\$2[aby]\$10\$/);
    expect(await bcrypt.compare(NEW_PASSWORD, row.password_hash)).toBe(true);
    expect(row.must_change_password).toBe(0);
    expect(row.updated_at.getFullYear()).toBeGreaterThan(2020);
  });

  // The exact cases from the password rule: 10+ characters, at least one letter and one digit
  test.each([
    ['9 characters', 'abcde1234', 400, 'New password must be at least 10 characters'],
    ['10 letters, no digit', 'abcdefghij', 400, 'New password must contain at least one number'],
    ['10 digits, no letter', '0123456789', 400, 'New password must contain at least one letter'],
    ['abcde12345', 'abcde12345', 200, undefined],
    ['72 characters', `a1${'x'.repeat(70)}`, 200, undefined],
  ])('new password: %s → %i', async (_, newPassword, status, message) => {
    const user = await createUser();
    const res = await change(await loginAs(user), { currentPassword: user.password, newPassword });
    expect(res.status).toBe(status);
    if (message) expect(res.body.errors).toContainEqual({ field: 'newPassword', message });
  });

  test('the person who changed it stays logged in: the response carries a fresh token that works everywhere', async () => {
    const user = await createUser({ mustChangePassword: true });
    const token = await loginAs(user);
    const res = await change(token, { currentPassword: user.password, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.token).not.toBe(token);
    expect((await api.get('/api/tickets').set(auth(res.body.token))).status).toBe(200);
    // The token sent with the change belonged to the old password, so it has ended like every other session
    expect((await api.get('/api/tickets').set(auth(token))).status).toBe(401);
  });

  test('neither password is ever written to the console', async () => {
    const user = await createUser();
    const token = await loginAs(user);
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
    try {
      await change(token, { currentPassword: 'wrong-password1', newPassword: NEW_PASSWORD }); // the failing path too
      await change(token, { currentPassword: user.password, newPassword: NEW_PASSWORD });
      const written = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n');
      for (const secret of [user.password, NEW_PASSWORD, 'wrong-password1']) expect(written).not.toContain(secret);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

describe('temporary passwords and the password rule', () => {
  test('10,000 generated temporary passwords all pass the rule users must follow', () => {
    for (let i = 0; i < 10000; i += 1) {
      const password = makeTemporaryPassword();
      const result = newPassword.safeParse(password);
      if (!result.success) throw new Error(`"${password}" fails the rule: ${result.error.issues[0].message}`);
    }
  });
});

describe('POST /api/auth/change-password: more rules', () => {
  const change = (token, body) => api.post('/api/auth/change-password').set(auth(token)).send(body);

  test.each([
    ['abcd1234 (8 characters)', 'abcd1234', 'New password must be at least 10 characters'],
    ['abcde1234 (9 characters)', 'abcde1234', 'New password must be at least 10 characters'],
    ['abcdefghij (no digit)', 'abcdefghij', 'New password must contain at least one number'],
    ['1234567890 (no letter)', '1234567890', 'New password must contain at least one letter'],
  ])('a new password %s is refused and nothing changes', async (_, password, message) => {
    const user = await createUser({ mustChangePassword: true });
    const token = await loginAs(user);
    const before = await dbSnapshot();
    const res = await change(token, { currentPassword: user.password, newPassword: password });
    expectError(res, 400, undefined, message);
    expect(await dbSnapshot()).toEqual(before);
  });

  test('only the current password sent (new one missing) is refused and nothing changes', async () => {
    const user = await createUser();
    const token = await loginAs(user);
    const before = await dbSnapshot();
    const res = await change(token, { currentPassword: user.password });
    expectError(res, 400, undefined, 'New password is required');
    expect(await dbSnapshot()).toEqual(before);
  });

  test('the same password again is refused and nothing changes', async () => {
    const user = await createUser({ password: 'Same-password1', mustChangePassword: true });
    const token = await loginAs(user);
    const before = await dbSnapshot();
    const res = await change(token, { currentPassword: 'Same-password1', newPassword: 'Same-password1' });
    expectError(res, 400, undefined, 'New password must be different from the current one');
    expect(await dbSnapshot()).toEqual(before);
  });

  test('a wrong current password is 400 INVALID_CURRENT_PASSWORD (not 401) and nothing changes', async () => {
    const user = await createUser({ mustChangePassword: true });
    const token = await loginAs(user);
    const before = await dbSnapshot();
    const res = await change(token, { currentPassword: 'Not-my-password1', newPassword: 'Brand-new-pass1' });
    expectError(res, 400, 'INVALID_CURRENT_PASSWORD', 'Current password is wrong');
    expect(await dbSnapshot()).toEqual(before);
  });

  // Ended through users.session_version (migration 007); the changer continues with the fresh token from the response
  test('changing the password ends the other sessions, and the changer stays logged in', async () => {
    const user = await createUser();
    const current = await loginAs(user);
    const other = await loginAs(user);
    const res = await change(current, { currentPassword: user.password, newPassword: 'Brand-new-pass1' });
    expect(res.status).toBe(200);
    expectError(await api.get('/api/auth/me').set(auth(other)), 401, undefined, 'Session expired, please log in again');
    expect((await api.get('/api/auth/me').set(auth(res.body.token))).status).toBe(200);
  });
});
