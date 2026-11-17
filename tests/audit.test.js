// The audit log (migration 009, src/audit.js, GET /api/audit): every security event is recorded with who did it, to
// whom, what and from where, and never a secret; admins can filter it by user, action and date, newest first, a page
// at a time.
const pool = require('../src/db')
const { AUDIT_ACTIONS, withoutSecrets } = require('../src/audit')
const { api, resetData, createUser, loginAs, auth, expectError, inviteTokenFor, useEmail } = require('./helpers')

beforeEach(resetData)

const rows = async () => (await pool.query('SELECT * FROM audit_log ORDER BY id'))[0]
const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value) // MariaDB returns JSON as text
const lastOf = async (action) => {
  const found = (await rows()).filter((row) => row.action === action)
  const row = found.at(-1)
  return row && { ...row, details: parse(row.details) }
}
const login = (email, password) => api.post('/api/auth/login').send({ email, password })
const list = (session, query = '') => api.get(`/api/audit${query}`).set(auth(session))

describe('recording every event', () => {
  test('login success: the user, their email and the IP', async () => {
    const user = await createUser()
    await login(user.email, user.password)
    expect(await lastOf('login_success')).toMatchObject({
      actor_id: user.id,
      target_user_id: user.id,
      details: { email: user.email },
      ip: expect.any(String),
    })
  })

  test.each([
    ['unknown_email', async () => ({ email: 'nobody@test.local', password: 'whatever-1', target: null })],
    [
      'wrong_password',
      async () => {
        const user = await createUser()
        return { email: user.email, password: 'wrong-password1', target: user.id }
      },
    ],
    [
      'deactivated',
      async () => {
        const user = await createUser({ isActive: false })
        return { email: user.email, password: user.password, target: user.id }
      },
    ],
  ])('login failure (%s): the email and the reason, never the password', async (reason, setup) => {
    const { email, password, target } = await setup()
    await login(email, password)
    const entry = await lastOf('login_failure')
    expect(entry).toMatchObject({ actor_id: null, target_user_id: target, details: { email, reason } })
    expect(JSON.stringify(entry)).not.toContain(password)
  })

  test('lockout: the 5th wrong password logs a failure and the lock; attempts while locked log reason "locked"', async () => {
    const user = await createUser()
    for (let i = 0; i < 5; i += 1) await login(user.email, 'wrong-password1')
    expect(await lastOf('account_locked')).toMatchObject({
      target_user_id: user.id,
      details: { email: user.email, minutes: 15 },
    })
    expect((await rows()).filter((r) => r.action === 'login_failure')).toHaveLength(5)

    await login(user.email, user.password) // the right password, but locked
    expect((await lastOf('login_failure')).details).toEqual({ email: user.email, reason: 'locked' })
  })

  test('logout: only when it really ends a session', async () => {
    const user = await createUser()
    const session = await loginAs(user)
    await api.post('/api/auth/logout').set(auth(session))
    await api.post('/api/auth/logout').set(auth(session)) // already ended: not logged again
    await api.post('/api/auth/logout') // no session at all
    const logouts = (await rows()).filter((r) => r.action === 'logout')
    expect(logouts).toHaveLength(1)
    expect(logouts[0]).toMatchObject({ actor_id: user.id, target_user_id: user.id })
  })

  test('logout everywhere: with how many sessions it ended', async () => {
    const user = await createUser()
    await loginAs(user)
    const session = await loginAs(user)
    await api.post('/api/auth/logout-all').set(auth(session))
    expect(await lastOf('logout_all')).toMatchObject({ actor_id: user.id, details: { sessions_ended: 2 } })
  })

  test('password changed: by the user, with how many other sessions it ended; no password stored', async () => {
    const user = await createUser()
    await loginAs(user)
    const session = await loginAs(user)
    await api
      .post('/api/auth/change-password')
      .set(auth(session))
      .send({ currentPassword: user.password, newPassword: 'Brand-new-pass1' })
    const entry = await lastOf('password_changed')
    expect(entry).toMatchObject({ actor_id: user.id, target_user_id: user.id, details: { other_sessions_ended: 1 } })
    expect(JSON.stringify(entry)).not.toMatch(/Brand-new-pass1|password123/)
  })

  test('a wrong current password logs no password change', async () => {
    const user = await createUser()
    await api
      .post('/api/auth/change-password')
      .set(auth(await loginAs(user)))
      .send({ currentPassword: 'not-my-password1', newPassword: 'Brand-new-pass1' })
    expect(await lastOf('password_changed')).toBeUndefined()
  })

  test('password reset: by the admin, for the user; the temporary password is never stored', async () => {
    const admin = await createUser({ role: 'admin' })
    const user = await createUser()
    await loginAs(user)
    const res = await api
      .post(`/api/users/${user.id}/reset-password`)
      .set(auth(await loginAs(admin)))
      .send()
    const entry = await lastOf('password_reset')
    expect(entry).toMatchObject({ actor_id: admin.id, target_user_id: user.id, details: { sessions_ended: 1 } })
    expect(JSON.stringify(entry)).not.toContain(res.body.temporaryPassword)
  })

  test('user created (email set up): by whom, with email, role and department; the link is never stored', async () => {
    useEmail(true)
    const hr = await createUser({ role: 'hr' })
    const res = await api
      .post('/api/users')
      .set(auth(await loginAs(hr)))
      .send({ name: 'New Person', email: 'new.person@test.local' })
    const entry = await lastOf('user_created')
    expect(entry).toMatchObject({
      actor_id: hr.id,
      target_user_id: res.body.user.id,
      details: { email: 'new.person@test.local', role: 'employee', department_id: null, delivery: 'email' },
    })
    const linkToken = await inviteTokenFor('new.person@test.local')
    expect(JSON.stringify(entry)).not.toContain(linkToken)
  })

  test('user edited: which fields, not their values', async () => {
    const admin = await createUser({ role: 'admin' })
    const user = await createUser()
    await api
      .patch(`/api/users/${user.id}`)
      .set(auth(await loginAs(admin)))
      .send({ name: 'Renamed', job_title: 'Accountant' })
    expect(await lastOf('user_updated')).toMatchObject({
      actor_id: admin.id,
      target_user_id: user.id,
      details: { fields: ['name', 'job_title'] },
    })
  })

  test('role changed: from and to, as its own event (not also "user_updated")', async () => {
    const admin = await createUser({ role: 'admin' })
    const user = await createUser({ role: 'agent' })
    await api
      .patch(`/api/users/${user.id}`)
      .set(auth(await loginAs(admin)))
      .send({ role: 'employee' })
    expect(await lastOf('role_changed')).toMatchObject({
      actor_id: admin.id,
      target_user_id: user.id,
      details: { from: 'agent', to: 'employee' },
    })
    expect(await lastOf('user_updated')).toBeUndefined()
  })

  test('sending the same role, or the same active status, logs no change', async () => {
    const admin = await loginAs(await createUser({ role: 'admin' }))
    const user = await createUser({ role: 'agent' })
    await api.patch(`/api/users/${user.id}`).set(auth(admin)).send({ role: 'agent', is_active: true })
    const actions = (await rows()).map((r) => r.action)
    expect(actions).not.toEqual(expect.arrayContaining(['role_changed']))
    expect(actions).not.toEqual(expect.arrayContaining(['user_activated']))
  })

  test('deactivated and activated', async () => {
    const admin = await loginAs(await createUser({ role: 'admin' }))
    const user = await createUser()
    await api.patch(`/api/users/${user.id}`).set(auth(admin)).send({ is_active: false })
    await api.patch(`/api/users/${user.id}`).set(auth(admin)).send({ is_active: true })
    const actions = (await rows()).filter((r) => r.target_user_id === user.id).map((r) => r.action)
    expect(actions).toEqual(['user_deactivated', 'user_activated'])
  })

  test('a refused change (403) logs nothing', async () => {
    const hr = await loginAs(await createUser({ role: 'hr' }))
    const agent = await createUser({ role: 'agent' })
    expect((await api.patch(`/api/users/${agent.id}`).set(auth(hr)).send({ name: 'X' })).status).toBe(403)
    expect(await lastOf('user_updated')).toBeUndefined()
  })
})

describe('never a secret', () => {
  test('after a run of every kind of event, no password, hash, token or session id is anywhere in the log', async () => {
    const admin = await createUser({ role: 'admin' })
    const user = await createUser()
    const adminSession = await loginAs(admin)
    const userSession = await loginAs(user)
    await login(user.email, 'wrong-password1')
    await api
      .post('/api/auth/change-password')
      .set(auth(userSession))
      .send({ currentPassword: user.password, newPassword: 'Brand-new-pass1' })
    // Email not set up yet: the reset gives a temporary password
    const reset = await api.post(`/api/users/${user.id}/reset-password`).set(auth(adminSession)).send()
    // Now set up, so the new account below sets its password with a link
    useEmail(true)
    await api
      .post('/api/users')
      .set(auth(adminSession))
      .send({ name: 'Someone', email: 'someone@test.local', role: 'agent' })
    // The new account sets its password with the emailed link
    const linkToken = await inviteTokenFor('someone@test.local')
    await api.post('/api/auth/set-password').send({ token: linkToken, new_password: 'Linked-pass-42' })
    await api.post('/api/auth/logout').set(auth(adminSession))

    const [hashes] = await pool.query('SELECT password_hash FROM users')
    const [sessions] = await pool.query('SELECT id FROM sessions')
    const everything = JSON.stringify(await rows())
    const secrets = [
      user.password,
      admin.password,
      'wrong-password1',
      'Brand-new-pass1',
      reset.body.temporaryPassword,
      linkToken,
      'Linked-pass-42',
      adminSession,
      userSession,
      ...hashes.map((h) => h.password_hash),
      ...sessions.map((s) => s.id),
    ]
    for (const secret of secrets) expect(everything).not.toContain(secret)
    expect(everything).not.toMatch(/\$2[aby]\$\d{2}\$/) // nothing that looks like a bcrypt hash
  })

  test('recordAudit drops any key that looks like a secret, whatever a caller passes', () => {
    expect(
      withoutSecrets({ email: 'a@b.c', password: 'x', newPassword: 'y', password_hash: 'z', token: 't', sid: 's' }),
    ).toEqual({ email: 'a@b.c' })
    expect(withoutSecrets({ temporaryPassword: 'x' })).toBeNull()
    expect(withoutSecrets({ session_id: 'x', sessionId: 'y', cookie: 'c', csrf: 'k', sessions_ended: 2 })).toEqual({
      sessions_ended: 2,
    })
  })
})

describe('GET /api/audit', () => {
  let admin
  let adminSession
  let alice
  let bob

  // Entries with fixed timestamps, so the date filters and the order can be checked exactly
  async function insert(createdAt, action, { actor = null, target = null, details = null } = {}) {
    await pool.query(
      'INSERT INTO audit_log (created_at, actor_id, action, target_user_id, details, ip) VALUES (?, ?, ?, ?, ?, ?)',
      [createdAt, actor, action, target, details && JSON.stringify(details), '203.0.113.7'],
    )
  }

  beforeEach(async () => {
    admin = await createUser({ role: 'admin', name: 'Ada Admin' })
    alice = await createUser({ name: 'Alice Employee' })
    bob = await createUser({ name: 'Bob Agent', role: 'agent' })
    adminSession = await loginAs(admin)
    await pool.query('DELETE FROM audit_log') // start from the fixed entries below only
    await insert('2026-11-01 09:00:00', 'login_success', { actor: alice.id, target: alice.id, details: { email: 'a' } })
    await insert('2026-11-02 10:00:00', 'login_failure', { target: bob.id, details: { email: 'b', reason: 'x' } })
    await insert('2026-11-03 23:59:59', 'role_changed', {
      actor: admin.id,
      target: bob.id,
      details: { from: 'employee', to: 'agent' },
    })
    await insert('2026-11-04 00:00:00', 'user_deactivated', { actor: admin.id, target: alice.id })
    await insert('2026-11-05 12:00:00', 'login_failure', { details: { email: 'nobody@x', reason: 'unknown_email' } })
  })

  test('newest first, with actor and target names, parsed details, ip, and the paging fields', async () => {
    const res = await list(adminSession)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ total: 5, page: 1, pageSize: 25 })
    expect(res.body.entries.map((e) => e.action)).toEqual([
      'login_failure',
      'user_deactivated',
      'role_changed',
      'login_failure',
      'login_success',
    ])
    const roleChange = res.body.entries[2]
    expect(roleChange).toEqual({
      id: expect.any(Number),
      created_at: expect.any(String),
      action: 'role_changed',
      actor: { id: admin.id, name: 'Ada Admin' },
      target: { id: bob.id, name: 'Bob Agent' },
      details: { from: 'employee', to: 'agent' },
      ip: '203.0.113.7',
    })
    // A failed login with an unknown email has no actor and no target; an event without details has null
    expect(res.body.entries[0]).toMatchObject({ actor: null, target: null })
    expect(res.body.entries[1].details).toBeNull()
  })

  test('user: entries where they are the actor OR the target', async () => {
    const res = await list(adminSession, `?user=${alice.id}`)
    expect(res.body.entries.map((e) => e.action)).toEqual(['user_deactivated', 'login_success'])
    expect(res.body.total).toBe(2)
    const asActor = await list(adminSession, `?user=${admin.id}`)
    expect(asActor.body.entries.map((e) => e.action)).toEqual(['user_deactivated', 'role_changed'])
  })

  test('action', async () => {
    const res = await list(adminSession, '?action=login_failure')
    expect(res.body.total).toBe(2)
    expect(res.body.entries.every((e) => e.action === 'login_failure')).toBe(true)
  })

  test('from and to are dates, both inclusive (to includes its whole day)', async () => {
    const res = await list(adminSession, '?from=2026-11-02&to=2026-11-03')
    expect(res.body.entries.map((e) => e.action)).toEqual(['role_changed', 'login_failure'])
    expect((await list(adminSession, '?from=2026-11-04')).body.total).toBe(2)
    expect((await list(adminSession, '?to=2026-11-01')).body.total).toBe(1)
    expect((await list(adminSession, '?from=2026-11-03&to=2026-11-03')).body.entries[0].action).toBe('role_changed')
  })

  test('filters combine', async () => {
    const res = await list(adminSession, `?user=${bob.id}&action=login_failure&from=2026-11-02&to=2026-11-02`)
    expect(res.body.total).toBe(1)
  })

  test('pagination: page and pageSize; total is the whole match; a page past the end is empty', async () => {
    const first = await list(adminSession, '?pageSize=2')
    const second = await list(adminSession, '?pageSize=2&page=2')
    const third = await list(adminSession, '?pageSize=2&page=3')
    const beyond = await list(adminSession, '?pageSize=2&page=9')
    expect([first.body.entries.length, second.body.entries.length, third.body.entries.length]).toEqual([2, 2, 1])
    expect(first.body).toMatchObject({ total: 5, page: 1, pageSize: 2 })
    expect(second.body.entries[0].action).toBe('role_changed')
    expect(beyond.body).toMatchObject({ entries: [], total: 5, page: 9 })
  })

  test('empty parameters mean "no filter" and the defaults', async () => {
    const res = await list(adminSession, '?user=&action=&from=&to=&page=&pageSize=')
    expect(res.body).toMatchObject({ total: 5, page: 1, pageSize: 25 })
  })

  test('pageSize can be 100 at most', async () => {
    expect((await list(adminSession, '?pageSize=100')).status).toBe(200)
    expectError(await list(adminSession, '?pageSize=101'), 400, undefined, 'Page size must be at most 100')
  })

  test.each([
    ['?action=nope', 'Unknown action; GET /api/audit/actions lists them'],
    ['?user=abc', 'User must be a number'],
    ['?from=10.11.2026', 'From must be a date like 2026-11-10'],
    ['?from=2026-02-30', 'From is not a real date'],
    ['?from=2026-11-05&to=2026-11-01', 'From must be on or before To'],
    ['?page=0', 'Page must be at least 1'],
    ['?pageSize=2.5', 'Page size must be a whole number'],
  ])('%s → 400 with a clear message', async (query, message) => {
    const res = await list(adminSession, query)
    expectError(res, 400, undefined, message)
    expect(res.body.errors).toEqual(expect.any(Array))
  })

  test.each(['hr', 'agent', 'employee'])('admin only: %s gets 403', async (role) => {
    const session = await loginAs(await createUser({ role }))
    expect((await list(session)).status).toBe(403)
    expect((await api.get('/api/audit/actions').set(auth(session))).status).toBe(403)
  })

  test('without a session: 401', async () => {
    expect((await api.get('/api/audit')).status).toBe(401)
    expect((await api.get('/api/audit/actions')).status).toBe(401)
  })
})

describe('GET /api/audit/actions', () => {
  test('lists every action name, for the filter dropdown', async () => {
    const session = await loginAs(await createUser({ role: 'admin' }))
    const res = await api.get('/api/audit/actions').set(auth(session))
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      'login_success',
      'login_failure',
      'account_locked',
      'logout',
      'logout_all',
      'password_changed',
      'password_reset',
      'password_reset_requested',
      'password_reset_self',
      'password_set_with_link',
      'user_created',
      'invite_resent',
      'user_updated',
      'role_changed',
      'user_activated',
      'user_deactivated',
      'attachment_uploaded',
      'attachment_deleted',
      'ticket_auto_closed',
      'ticket_escalated',
      'kb.article_created',
      'kb.article_updated',
      'kb.article_published',
      'kb.article_unpublished',
      'kb.article_deleted',
      'kb.category_created',
      'kb.category_updated',
      'kb.category_deleted',
      'canned.shared_created',
      'canned.shared_updated',
      'canned.shared_deleted',
    ])
    expect(res.body).toEqual(AUDIT_ACTIONS)
  })
})
