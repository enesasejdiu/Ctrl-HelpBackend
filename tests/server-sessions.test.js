// Server-side sessions (migration 008, src/sessionStore.js): login creates a sessions row whose id is the JWT's "sid";
// requireAuth refuses a token whose row is missing, revoked or expired; logout revokes the row, so even a copy of the
// token stops working; logout-all revokes every row of the user; password change, reset, deactivation and role change
// revoke rows; cleanup deletes rows that ended more than 7 days ago.
const { spawnSync } = require('child_process')
const path = require('path')
const jwt = require('jsonwebtoken')
const pool = require('../src/db')
const { cleanupSessions, startSessionCleanup } = require('../src/sessionStore')
const { api, resetData, createUser, loginAs, auth, sessionOf, expectError, TEST_CSRF } = require('./helpers')

beforeEach(resetData)

const ENDED = 'Session expired, please log in again'
const me = (session) => api.get('/api/auth/me').set(auth(session))
const logout = (session) => api.post('/api/auth/logout').set(auth(session))
const sidOf = (session) => jwt.decode(session).sid
const sessionRows = async (userId) =>
  (await pool.query('SELECT id, revoked_at FROM sessions WHERE user_id = ? ORDER BY created_at, id', [userId]))[0]

describe('login creates a server-side session', () => {
  test('one row per login: 43-character URL-safe id in the JWT as sid, 8 hours, with ip and user agent', async () => {
    const user = await createUser()
    const res = await api
      .post('/api/auth/login')
      .set('User-Agent', 'TicketFlow test browser')
      .send({ email: user.email, password: user.password })
    const session = sessionOf(res)
    const { sid, iat, exp } = jwt.decode(session)

    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(exp - iat).toBe(8 * 60 * 60)
    const [[row]] = await pool.query(
      `SELECT user_id, revoked_at, ip, user_agent, TIMESTAMPDIFF(MINUTE, created_at, expires_at) AS minutes
       FROM sessions WHERE id = ?`,
      [sid],
    )
    expect(row).toMatchObject({
      user_id: user.id,
      revoked_at: null,
      user_agent: 'TicketFlow test browser',
      minutes: 480,
    })
    expect(row.ip).toEqual(expect.any(String))
  })

  test('every login is its own session', async () => {
    const user = await createUser()
    const a = await loginAs(user)
    const b = await loginAs(user)
    expect(sidOf(a)).not.toBe(sidOf(b))
    expect(await sessionRows(user.id)).toHaveLength(2)
  })

  test('a very long user agent is cut to 255 characters', async () => {
    const user = await createUser()
    const res = await api
      .post('/api/auth/login')
      .set('User-Agent', 'x'.repeat(400))
      .send({ email: user.email, password: user.password })
    const [[row]] = await pool.query('SELECT user_agent FROM sessions WHERE id = ?', [sidOf(sessionOf(res))])
    expect(row.user_agent).toHaveLength(255)
  })

  test('a failed login creates no session', async () => {
    const user = await createUser()
    await api.post('/api/auth/login').send({ email: user.email, password: 'wrong-password1' })
    expect(await sessionRows(user.id)).toHaveLength(0)
  })
})

describe('POST /api/auth/logout ends the session on the server', () => {
  test('the SAME token, copied before logout, is refused afterwards (401)', async () => {
    const user = await createUser()
    const session = await loginAs(user)
    const copied = session // e.g. taken from the browser before logging out
    expect((await me(copied)).status).toBe(200)

    const res = await logout(session)
    expect(res.status).toBe(204)
    expectError(await me(copied), 401, undefined, ENDED)
    const [[row]] = await pool.query('SELECT revoked_at FROM sessions WHERE id = ?', [sidOf(session)])
    expect(row.revoked_at).not.toBeNull()
  })

  test('also clears both cookies', async () => {
    const res = await logout(await loginAs(await createUser()))
    const cleared = (res.headers['set-cookie'] || []).map((line) => line.split('=')[0])
    expect(cleared.sort()).toEqual(['tf_csrf', 'tf_session'])
  })

  test("ends only this session: the user's other sessions keep working", async () => {
    const user = await createUser()
    const laptop = await loginAs(user)
    const phone = await loginAs(user)
    await logout(laptop)
    expect((await me(phone)).status).toBe(200)
  })

  test.each([
    ['no session at all', null],
    ['a garbled cookie', 'not-a-token'],
  ])('works with %s (still 204)', async (_, cookie) => {
    const req = api.post('/api/auth/logout')
    const res = cookie ? await req.set('Cookie', `tf_session=${cookie}`) : await req
    expect(res.status).toBe(204)
  })

  test('works when the session is already gone: logged out twice, or its row deleted (still 204)', async () => {
    const user = await createUser()
    const session = await loginAs(user)
    expect((await logout(session)).status).toBe(204)
    expect((await logout(session)).status).toBe(204)

    const other = await loginAs(user)
    await pool.query('DELETE FROM sessions WHERE id = ?', [sidOf(other)])
    expect((await logout(other)).status).toBe(204)
  })

  test('an expired token still revokes its row', async () => {
    const user = await createUser()
    const { sid } = jwt.decode(await loginAs(user))
    const expired = jwt.sign({ id: user.id, sid, session_version: 0 }, process.env.JWT_SECRET, { expiresIn: -10 })
    expect((await logout(expired)).status).toBe(204)
    const [[row]] = await pool.query('SELECT revoked_at FROM sessions WHERE id = ?', [sid])
    expect(row.revoked_at).not.toBeNull()
  })

  test('a forged token (wrong signature) revokes nothing', async () => {
    const user = await createUser()
    const real = await loginAs(user)
    const forged = jwt.sign({ id: user.id, sid: sidOf(real) }, 'not-the-secret')
    expect((await logout(forged)).status).toBe(204)
    expect((await me(real)).status).toBe(200)
  })
})

describe('POST /api/auth/logout-all ends every session of the user', () => {
  test('this one and a second browser are both logged out; other users are not', async () => {
    const user = await createUser()
    const colleague = await createUser()
    const thisBrowser = await loginAs(user)
    const secondBrowser = await loginAs(user)
    const colleagueSession = await loginAs(colleague)

    const res = await api.post('/api/auth/logout-all').set(auth(thisBrowser))
    expect(res.status).toBe(204)
    expect((res.headers['set-cookie'] || []).some((line) => line.startsWith('tf_session=;'))).toBe(true)

    expectError(await me(thisBrowser), 401, undefined, ENDED)
    expectError(await me(secondBrowser), 401, undefined, ENDED)
    expect((await me(colleagueSession)).status).toBe(200)
    expect((await sessionRows(user.id)).every((row) => row.revoked_at !== null)).toBe(true)
  })

  test('needs a session (401) and the CSRF header (403)', async () => {
    expect((await api.post('/api/auth/logout-all')).status).toBe(401)
    const session = await loginAs(await createUser())
    const noCsrf = await api.post('/api/auth/logout-all').set('Cookie', `tf_session=${session}; tf_csrf=${TEST_CSRF}`)
    expect(noCsrf.status).toBe(403)
    expect(noCsrf.body.code).toBe('CSRF_INVALID')
    expect((await me(session)).status).toBe(200)
  })

  test('after it, a new login works again', async () => {
    const user = await createUser()
    await api.post('/api/auth/logout-all').set(auth(await loginAs(user)))
    expect((await me(await loginAs(user))).status).toBe(200)
  })
})

describe('changes to the account end sessions', () => {
  test('a password change keeps the current session and ends the others', async () => {
    const user = await createUser()
    const current = await loginAs(user)
    const other = await loginAs(user)
    const res = await api
      .post('/api/auth/change-password')
      .set(auth(current))
      .send({ currentPassword: user.password, newPassword: 'Brand-new-pass1' })
    expect(res.status).toBe(200)
    expect((await me(current)).status).toBe(200)
    expectError(await me(other), 401, undefined, ENDED)
  })

  test.each([
    ['a password reset', (id, admin) => api.post(`/api/users/${id}/reset-password`).set(auth(admin)).send()],
    ['deactivation', (id, admin) => api.patch(`/api/users/${id}`).set(auth(admin)).send({ is_active: false })],
    ['a role change', (id, admin) => api.patch(`/api/users/${id}`).set(auth(admin)).send({ role: 'agent' })],
  ])('%s revokes every session row of the user', async (_, act) => {
    const admin = await loginAs(await createUser({ role: 'admin' }))
    const user = await createUser()
    const a = await loginAs(user)
    const b = await loginAs(user)

    expect((await act(user.id, admin)).status).toBe(200)
    expect((await sessionRows(user.id)).map((row) => row.revoked_at !== null)).toEqual([true, true])
    expectError(await me(a), 401, undefined, ENDED)
    expectError(await me(b), 401, undefined, ENDED)
    expect((await me(admin)).status).toBe(200)
  })

  test('a refused role change (HR, or an admin changing their own role: 403) revokes nothing', async () => {
    const admin = await createUser({ role: 'admin' })
    const adminSession = await loginAs(admin)
    const hr = await loginAs(await createUser({ role: 'hr' }))
    expect((await api.patch(`/api/users/${admin.id}`).set(auth(hr)).send({ role: 'agent' })).status).toBe(403)
    expect((await api.patch(`/api/users/${admin.id}`).set(auth(adminSession)).send({ role: 'agent' })).status).toBe(403)
    expect((await sessionRows(admin.id)).every((row) => row.revoked_at === null)).toBe(true)
  })
})

describe('requireAuth needs an active session row', () => {
  test('an expired row is refused (401) even with a valid JWT', async () => {
    const session = await loginAs(await createUser())
    await pool.query('UPDATE sessions SET expires_at = NOW() - INTERVAL 1 SECOND WHERE id = ?', [sidOf(session)])
    expect(() => jwt.verify(session, process.env.JWT_SECRET)).not.toThrow() // the JWT itself is still valid
    expectError(await me(session), 401, undefined, ENDED)
  })

  test('a JWT without sid is refused (tokens from before migration 008)', async () => {
    const user = await createUser()
    const noSid = jwt.sign(
      { id: user.id, name: user.name, role: user.role, session_version: 0 },
      process.env.JWT_SECRET,
      {
        expiresIn: '1h',
      },
    )
    expectError(await me(noSid), 401, undefined, ENDED)
  })

  test("a JWT with an unknown sid, or with another user's sid, is refused", async () => {
    const user = await createUser()
    const other = await createUser()
    const sign = (sid) =>
      jwt.sign({ id: user.id, session_version: 0, sid }, process.env.JWT_SECRET, { expiresIn: '1h' })
    expectError(await me(sign('A'.repeat(43))), 401, undefined, ENDED)
    expectError(await me(sign(sidOf(await loginAs(other)))), 401, undefined, ENDED)
  })

  test('last_seen_at is updated at most once a minute', async () => {
    const session = await loginAs(await createUser())
    const sid = sidOf(session)
    const secondsAgo = async () =>
      (
        await pool.query('SELECT TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) AS s FROM sessions WHERE id = ?', [sid])
      )[0][0].s

    await pool.query('UPDATE sessions SET last_seen_at = NOW() - INTERVAL 30 SECOND WHERE id = ?', [sid])
    await me(session)
    expect(await secondsAgo()).toBeGreaterThanOrEqual(30) // under a minute: not written again

    await pool.query('UPDATE sessions SET last_seen_at = NOW() - INTERVAL 2 MINUTE WHERE id = ?', [sid])
    await me(session)
    expect(await secondsAgo()).toBeLessThan(5) // over a minute: written now
  })

  test('deleting a user deletes their sessions (ON DELETE CASCADE)', async () => {
    const user = await createUser()
    await loginAs(user)
    await pool.query('DELETE FROM users WHERE id = ?', [user.id])
    expect(await sessionRows(user.id)).toHaveLength(0)
  })
})

// Polls until `condition()` is true (the cleanup runs asynchronously), failing after 3 seconds
async function waitUntil(condition) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > 3000) throw new Error('waitUntil: timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('cleanup of old sessions', () => {
  // Rows with fixed ages, relative to the database clock
  async function insertSession(id, userId, { expiresAgo = null, revokedAgo = null } = {}) {
    const expires = expiresAgo === null ? 'NOW() + INTERVAL 1 HOUR' : `NOW() - INTERVAL ${expiresAgo} DAY`
    const revoked = revokedAgo === null ? 'NULL' : `NOW() - INTERVAL ${revokedAgo} DAY`
    await pool.query(
      `INSERT INTO sessions (id, user_id, expires_at, revoked_at) VALUES (?, ?, ${expires}, ${revoked})`,
      [id.padEnd(43, '_'), userId],
    )
  }

  async function insertAll() {
    const user = await createUser()
    await insertSession('active', user.id)
    await insertSession('expired_6_days', user.id, { expiresAgo: 6 })
    await insertSession('expired_8_days', user.id, { expiresAgo: 8 })
    await insertSession('revoked_1_day', user.id, { revokedAgo: 1 })
    await insertSession('revoked_8_days', user.id, { revokedAgo: 8 })
    return user
  }
  const remaining = async (userId) => (await sessionRows(userId)).map((row) => row.id.replace(/_+$/, '')).sort()

  test('deletes only sessions that expired or were revoked more than 7 days ago', async () => {
    const user = await insertAll()
    expect(await cleanupSessions()).toBe(2)
    expect(await remaining(user.id)).toEqual(['active', 'expired_6_days', 'revoked_1_day'])
  })

  test('startSessionCleanup (the server): cleans up at once, then again on its interval, without keeping the process alive', async () => {
    const user = await insertAll()
    const log = { log: jest.fn(), error: jest.fn() }
    const timer = startSessionCleanup({ everyMs: 50, log })
    try {
      expect(timer.hasRef()).toBe(false)
      await waitUntil(() => log.log.mock.calls.length === 1)
      expect(log.log.mock.calls[0][0]).toMatch(/deleted 2 sessions/)
      expect(await remaining(user.id)).toEqual(['active', 'expired_6_days', 'revoked_1_day'])

      // Another old row appears: the next run (on the interval) deletes it
      await insertSession('revoked_9_days', user.id, { revokedAgo: 9 })
      await waitUntil(() => log.log.mock.calls.length === 2)
      expect(log.log.mock.calls[1][0]).toMatch(/deleted 1 sessions/)
    } finally {
      clearInterval(timer)
    }
  })

  test('startSessionCleanup only logs a failure (the server keeps running)', async () => {
    const query = jest.spyOn(pool, 'query').mockRejectedValueOnce(new Error('database is down'))
    const log = { log: jest.fn(), error: jest.fn() }
    const timer = startSessionCleanup({ log })
    try {
      await waitUntil(() => log.error.mock.calls.length === 1)
      expect(log.error.mock.calls[0][0]).toBe('Session cleanup failed: database is down')
    } finally {
      clearInterval(timer)
      query.mockRestore()
    }
  })

  test('npm run db:sessions:cleanup does the same (on the test database)', async () => {
    const user = await insertAll()
    const res = spawnSync(process.execPath, ['scripts/cleanup-sessions.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' }, // DB_NAME is this run's ticketflow_test_* database
      encoding: 'utf8',
      timeout: 15000,
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/Deleted 2 sessions/)
    expect(await remaining(user.id)).toEqual(['active', 'expired_6_days', 'revoked_1_day'])
  })
})
