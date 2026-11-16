// Tests for POST /api/users/:id/reset-password: who may reset whom, the new temporary password, and what happens to
// the old password and to sessions from before the reset.
const bcrypt = require('bcryptjs')
const pool = require('../src/db')
const { captureLogs } = require('../src/logger')
const {
  api,
  resetData,
  createUser,
  loginAs,
  auth,
  dbUser,
  dbSnapshot,
  expectError,
  expectNoPasswordHash,
  sessionOf,
} = require('./helpers')

let admin, hr, adminToken, hrToken

beforeEach(async () => {
  await resetData()
  admin = await createUser({ role: 'admin' })
  hr = await createUser({ role: 'hr' })
  adminToken = await loginAs(admin)
  hrToken = await loginAs(hr)
})

describe('POST /api/users/:id/reset-password', () => {
  const reset = (id, token) => api.post(`/api/users/${id}/reset-password`).set(auth(token))

  test.each(['agent', 'hr', 'employee', 'admin'])('admin resets a(n) %s', async (role) => {
    const target = await createUser({ role })
    const res = await reset(target.id, adminToken)

    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ id: target.id, role, must_change_password: true })
    expect(res.body.user).not.toHaveProperty('password_hash')
    expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{12,}$/)
    expect((await dbUser(target.id)).must_change_password).toBe(1)
  })

  test('HR resets an employee', async () => {
    const target = await createUser()
    const res = await reset(target.id, hrToken)
    expect(res.status).toBe(200)
    expect(res.body.user.must_change_password).toBe(true)
  })

  test.each(['agent', 'admin', 'hr'])('HR resetting a(n) %s gets 403 and the password stays', async (role) => {
    const target = await createUser({ role })
    const before = (await dbUser(target.id)).password_hash
    const res = await reset(target.id, hrToken)
    expect(res.status).toBe(403)
    expect(res.body.message).toBe('HR can only reset passwords of employee accounts')
    expect((await dbUser(target.id)).password_hash).toBe(before)
  })

  test.each(['employee', 'agent'])('a(n) %s gets 403', async (role) => {
    const target = await createUser()
    const res = await reset(target.id, await loginAs(await createUser({ role })))
    expect(res.status).toBe(403)
  })

  test.each([
    ['admin', () => [admin, adminToken]],
    ['HR', () => [hr, hrToken]],
  ])('%s resetting their own account gets 403 and the password stays', async (_, who) => {
    const [me, token] = who()
    const before = (await dbUser(me.id)).password_hash
    const res = await reset(me.id, token)
    expect(res.status).toBe(403)
    expect(res.body.message).toBe('Use Change password for your own account')
    expect((await dbUser(me.id)).password_hash).toBe(before)
  })

  test('an unknown user returns 404', async () => {
    expect((await reset(999999, adminToken)).status).toBe(404)
  })

  test('a non-numeric id returns 400', async () => {
    const res = await reset('abc', adminToken)
    expect(res.status).toBe(400)
    expect(res.body.errors[0].field).toBe('id')
  })

  test('a deactivated account can be reset too', async () => {
    const target = await createUser({ isActive: false })
    expect((await reset(target.id, adminToken)).status).toBe(200)
  })

  test('the old password stops working, the new one logs in, and the user must change it', async () => {
    const target = await createUser()
    const oldToken = await loginAs(target)
    const res = await reset(target.id, adminToken)
    const { temporaryPassword } = res.body

    const oldLogin = await api.post('/api/auth/login').send({ email: target.email, password: target.password })
    expect(oldLogin.status).toBe(401)
    const newLogin = await api.post('/api/auth/login').send({ email: target.email, password: temporaryPassword })
    expect(newLogin.status).toBe(200)
    expect(newLogin.body.user.must_change_password).toBe(true)

    // Any session the user had before the reset is ended; the new login is blocked until they choose a password
    const ended = await api.get('/api/tickets').set(auth(oldToken))
    expectError(ended, 401, undefined, 'Session expired, please log in again')
    const blocked = await api.get('/api/tickets').set(auth(sessionOf(newLogin)))
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED')
  })

  test('every reset gives a different password', async () => {
    const target = await createUser()
    const a = await reset(target.id, adminToken)
    const b = await reset(target.id, adminToken)
    expect(a.body.temporaryPassword).not.toBe(b.body.temporaryPassword)
  })

  test.each([
    ['a chosen password', { password: 'MyChoice123' }, 'password', 'password is not allowed'],
    ['any other field', { notify: true }, 'notify', 'notify is not allowed'],
    ['a JSON array', [], 'body', 'Request body must be a JSON object'],
  ])('a body with %s returns 400 and the password stays', async (_, body, field, message) => {
    const target = await createUser()
    const before = (await dbUser(target.id)).password_hash
    const res = await api.post(`/api/users/${target.id}/reset-password`).set(auth(adminToken)).send(body)
    expect(res.status).toBe(400)
    expect(res.body.errors).toContainEqual({ field, message })
    expect((await dbUser(target.id)).password_hash).toBe(before)
  })

  test('an empty JSON body is the same as no body', async () => {
    const target = await createUser()
    const res = await api.post(`/api/users/${target.id}/reset-password`).set(auth(adminToken)).send({})
    expect(res.status).toBe(200)
  })

  test('an unknown user returns 404 before the body is looked at', async () => {
    const res = await api.post('/api/users/999999/reset-password').set(auth(adminToken)).send({ password: 'x' })
    expect(res.status).toBe(404)
  })

  test('without a token returns 401', async () => {
    const target = await createUser()
    expect((await api.post(`/api/users/${target.id}/reset-password`)).status).toBe(401)
  })

  test('stores only a bcrypt hash of the new password, and moves updated_at forward', async () => {
    const target = await createUser()
    await pool.query('UPDATE users SET updated_at = ? WHERE id = ?', ['2020-01-01 00:00:00', target.id])
    const res = await reset(target.id, adminToken)

    const row = await dbUser(target.id)
    expect(row.password_hash).not.toBe(res.body.temporaryPassword)
    expect(row.password_hash).toMatch(/^\$2[aby]\$10\$/)
    expect(await bcrypt.compare(res.body.temporaryPassword, row.password_hash)).toBe(true)
    expect(row.updated_at.getFullYear()).toBeGreaterThan(2020)
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|\$2[aby]\$/)
  })

  test("a session from before the reset can't use the app or change the password (it has ended)", async () => {
    const target = await createUser()
    const oldToken = await loginAs(target)
    await reset(target.id, adminToken)

    const change = await api
      .post('/api/auth/change-password')
      .set(auth(oldToken))
      .send({ currentPassword: target.password, newPassword: 'Attacker1234' })
    expectError(change, 401, undefined, 'Session expired, please log in again')
    for (const path of ['/api/tickets', '/api/meta', '/api/auth/me']) {
      expect([path, (await api.get(path).set(auth(oldToken))).status]).toEqual([path, 401])
    }
  })

  test('the temporary password is never written to the console', async () => {
    const target = await createUser()
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) =>
      jest.spyOn(console, level).mockImplementation(() => {}),
    )
    const captured = captureLogs() // the logger's lines (src/logger.js)
    try {
      const res = await reset(target.id, adminToken)
      expect(res.status).toBe(200)
      const written = [...spies.flatMap((spy) => spy.mock.calls.flat().map(String)), captured.text()].join('\n')
      expect(written).not.toContain(res.body.temporaryPassword)
    } finally {
      spies.forEach((spy) => spy.mockRestore())
      captured.restore()
    }
  })
})

describe('POST /api/users/:id/reset-password: refusals change nothing', () => {
  const reset = (id, token, body) => {
    const req = api.post(`/api/users/${id}/reset-password`).set(auth(token))
    return body === undefined ? req : req.send(body)
  }

  test.each([
    ['admin', () => [admin, adminToken]],
    ['HR', () => [hr, hrToken]],
  ])('%s resetting their own password is 403 and nothing changes', async (_, who) => {
    const [me, token] = who()
    const before = await dbSnapshot()
    expectError(await reset(me.id, token), 403, undefined, 'Use Change password for your own account')
    expect(await dbSnapshot()).toEqual(before)
  })

  test.each(['hr', 'admin'])('HR resetting a(n) %s user is 403 and nothing changes', async (role) => {
    const target = await createUser({ role })
    const before = await dbSnapshot()
    expectError(await reset(target.id, hrToken), 403, undefined, 'HR can only reset passwords of employee accounts')
    expect(await dbSnapshot()).toEqual(before)
  })

  test('a body (a chosen password) is 400 and nothing changes', async () => {
    const target = await createUser()
    const before = await dbSnapshot()
    const res = await reset(target.id, adminToken, { password: 'Chosen-pass1' })
    expectError(res, 400, undefined, 'password is not allowed')
    expect(await dbSnapshot()).toEqual(before)
  })

  test('an unknown id is 404 and nothing changes', async () => {
    const before = await dbSnapshot()
    expectError(await reset(999999, adminToken), 404, undefined, 'User not found')
    expect(await dbSnapshot()).toEqual(before)
  })

  // Email isn't set up in these tests, so a reset gives a temporary password (password-links.test.js has email mode)
  test('success returns the user and the temporary password, never a hash', async () => {
    const target = await createUser()
    const res = await reset(target.id, adminToken)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      user: expect.objectContaining({ id: target.id, must_change_password: true }),
      temporaryPassword: expect.stringMatching(/^[A-Za-z0-9]{12,}$/),
      password_delivery: 'temporary_password',
    })
    expectNoPasswordHash(res.body)
  })

  // Ended through users.session_version (migration 007)
  test("a reset ends the user's existing sessions", async () => {
    const target = await createUser()
    const oldToken = await loginAs(target)
    await reset(target.id, adminToken)
    expectError(
      await api.get('/api/auth/me').set(auth(oldToken)),
      401,
      undefined,
      'Session expired, please log in again',
    )
  })
})
