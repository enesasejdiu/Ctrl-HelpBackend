// Tests for the login lockout (POST /api/auth/login): 5 wrong passwords in a row lock an account for 15 minutes,
// a locked account gets 423 ACCOUNT_LOCKED even with the right password, the lock runs out by itself, a successful
// login clears the count, and an admin/HR password reset unlocks the account. Unknown emails stay a plain 401.
const pool = require('../src/db')
const { api, createUser, loginAs, auth, dbUser, expectNoPasswordHash, sessionOf } = require('./helpers')

const WRONG = 'wrong-password1'
const WRONG_LOGIN = { message: 'Wrong email or password' }
const login = (email, password) => api.post('/api/auth/login').send({ email, password })

// n wrong passwords one after the other; returns the responses
async function wrongLogins(user, n) {
  const responses = []
  for (let i = 0; i < n; i += 1) responses.push(await login(user.email, WRONG))
  return responses
}

const lockState = async (id) => {
  const row = await dbUser(id)
  return { count: row.failed_login_count, locked: row.locked_until !== null }
}

describe('login lockout', () => {
  test('4 wrong passwords, then the right one logs in and clears the count', async () => {
    const user = await createUser()
    const wrong = await wrongLogins(user, 4)
    expect(wrong.map((r) => r.status)).toEqual([401, 401, 401, 401])
    expect(wrong[3].body).toEqual(WRONG_LOGIN)
    expect(await lockState(user.id)).toEqual({ count: 4, locked: false })

    const res = await login(user.email, user.password)
    expect(res.status).toBe(200)
    expect(await lockState(user.id)).toEqual({ count: 0, locked: false })
  })

  test('the 5th wrong password locks the account for 15 minutes: 423, even with the right password', async () => {
    const user = await createUser()
    const wrong = await wrongLogins(user, 5)
    expect(wrong.slice(0, 4).map((r) => r.status)).toEqual([401, 401, 401, 401])
    // The attempt that locks it already says so
    expect(wrong[4].status).toBe(423)
    expect(wrong[4].body).toEqual({
      message: 'Too many wrong passwords. Try again in 15 minutes.',
      code: 'ACCOUNT_LOCKED',
      retryAfterMinutes: 15,
    })
    expect(wrong[4].headers['retry-after']).toBe('900')

    const right = await login(user.email, user.password)
    expect(right.status).toBe(423)
    expect(right.body).toMatchObject({ code: 'ACCOUNT_LOCKED', retryAfterMinutes: 15 })
    expect(right.body).not.toHaveProperty('token')
    expect(Number(right.headers['retry-after'])).toBeGreaterThan(14 * 60)

    // The lock is stored for about 15 minutes, by the database's clock
    const [[{ minutes }]] = await pool.query(
      'SELECT TIMESTAMPDIFF(SECOND, NOW(), locked_until) / 60 AS minutes FROM users WHERE id = ?',
      [user.id],
    )
    expect(Number(minutes)).toBeGreaterThan(14.5)
    expect(Number(minutes)).toBeLessThanOrEqual(15)
  })

  test('while locked, more attempts change nothing: the count and the lock stay as they are', async () => {
    const user = await createUser()
    await wrongLogins(user, 5)
    const lockedUntil = (await dbUser(user.id)).locked_until

    expect((await login(user.email, WRONG)).status).toBe(423)
    expect((await login(user.email, user.password)).status).toBe(423)
    const row = await dbUser(user.id)
    expect(row.failed_login_count).toBe(5)
    expect(row.locked_until).toEqual(lockedUntil)
  })

  test('says "1 minute" when less than a minute is left', async () => {
    const user = await createUser()
    await pool.query(
      'UPDATE users SET failed_login_count = 5, locked_until = NOW() + INTERVAL 30 SECOND WHERE id = ?',
      [user.id],
    )

    const res = await login(user.email, user.password)
    expect(res.status).toBe(423)
    expect(res.body).toMatchObject({
      message: 'Too many wrong passwords. Try again in 1 minute.',
      retryAfterMinutes: 1,
    })
  })

  test('once the lock has run out, the right password logs in and clears the lock', async () => {
    const user = await createUser()
    await wrongLogins(user, 5)
    await pool.query('UPDATE users SET locked_until = NOW() - INTERVAL 1 SECOND WHERE id = ?', [user.id])

    expect((await login(user.email, user.password)).status).toBe(200)
    expect(await lockState(user.id)).toEqual({ count: 0, locked: false })
  })

  test('once the lock has run out, a wrong password starts the count again at 1', async () => {
    const user = await createUser()
    await wrongLogins(user, 5)
    await pool.query('UPDATE users SET locked_until = NOW() - INTERVAL 1 SECOND WHERE id = ?', [user.id])

    const res = await login(user.email, WRONG)
    expect(res.status).toBe(401)
    expect(res.body).toEqual(WRONG_LOGIN)
    expect(await lockState(user.id)).toEqual({ count: 1, locked: false })

    // ...and it takes 5 more wrong passwords to lock it again
    const again = await wrongLogins(user, 4)
    expect(again.map((r) => r.status)).toEqual([401, 401, 401, 423])
  })

  test('a successful login resets the count, so 4 more wrong passwords do not lock', async () => {
    const user = await createUser()
    await wrongLogins(user, 3)
    expect((await login(user.email, user.password)).status).toBe(200)
    expect(await lockState(user.id)).toEqual({ count: 0, locked: false })

    const wrong = await wrongLogins(user, 4)
    expect(wrong.map((r) => r.status)).toEqual([401, 401, 401, 401])
    expect(await lockState(user.id)).toEqual({ count: 4, locked: false })
  })

  test('wrong passwords sent at the same time are all counted, and lock the account once', async () => {
    const user = await createUser()
    const responses = await Promise.all(Array.from({ length: 5 }, () => login(user.email, WRONG)))

    expect(responses.every((r) => [401, 423].includes(r.status))).toBe(true)
    expect(await lockState(user.id)).toEqual({ count: 5, locked: true })
    expect((await login(user.email, user.password)).status).toBe(423)
  })

  test('an admin or HR password reset unlocks the account', async () => {
    const admin = await createUser({ role: 'admin' })
    const user = await createUser()
    const adminToken = await loginAs(admin)
    await wrongLogins(user, 5)
    expect((await login(user.email, user.password)).status).toBe(423)

    const reset = await api.post(`/api/users/${user.id}/reset-password`).set(auth(adminToken))
    expect(reset.status).toBe(200)
    expect(await lockState(user.id)).toEqual({ count: 0, locked: false })
    expectNoPasswordHash(reset.body)
    expect(reset.body.user).not.toHaveProperty('failed_login_count')

    // The temporary password works at once (the user then has to choose their own)
    const res = await login(user.email, reset.body.temporaryPassword)
    expect(res.status).toBe(200)
    expect(res.body.user.must_change_password).toBe(true)
  })

  test('a deactivated account counts wrong passwords and locks like any other', async () => {
    const user = await createUser({ isActive: false })
    const wrong = await wrongLogins(user, 5)
    expect(wrong.map((r) => r.status)).toEqual([401, 401, 401, 401, 423])
    // The right password while unlocked still gets the usual 403
    await pool.query('UPDATE users SET locked_until = NOW() - INTERVAL 1 SECOND WHERE id = ?', [user.id])
    expect((await login(user.email, user.password)).status).toBe(403)
  })

  test('unknown emails always get the same 401, never a lock', async () => {
    const user = await createUser()
    const wrongPassword = await login(user.email, WRONG)

    for (let i = 0; i < 6; i += 1) {
      const res = await login('nobody.here@test.local', WRONG)
      expect(res.status).toBe(401)
      expect(res.body).toEqual(wrongPassword.body)
    }
  })

  test('lockout bookkeeping and logins leave updated_at alone', async () => {
    const user = await createUser()
    await pool.query("UPDATE users SET updated_at = '2026-01-01 00:00:00' WHERE id = ?", [user.id])
    const before = (await dbUser(user.id)).updated_at

    await wrongLogins(user, 5)
    await pool.query(
      'UPDATE users SET locked_until = NOW() - INTERVAL 1 SECOND, updated_at = updated_at WHERE id = ?',
      [user.id],
    )
    await login(user.email, WRONG)
    await login(user.email, user.password)

    expect((await dbUser(user.id)).updated_at).toEqual(before)
  })

  test('login and /me never send the lockout fields', async () => {
    const user = await createUser()
    await wrongLogins(user, 2)
    const res = await login(user.email, user.password)
    const me = await api.get('/api/auth/me').set(auth(sessionOf(res)))

    for (const body of [res.body.user, me.body]) {
      expect(body).not.toHaveProperty('failed_login_count')
      expect(body).not.toHaveProperty('locked_until')
      expect(body).not.toHaveProperty('lock_seconds_left')
    }
  })
})

describe('LOCKOUT_MINUTES (test environment only)', () => {
  const { lockoutMinutes } = require('../src/lockout')
  const before = process.env.LOCKOUT_MINUTES
  afterEach(() => {
    if (before === undefined) delete process.env.LOCKOUT_MINUTES
    else process.env.LOCKOUT_MINUTES = before
  })

  test('shortens the lock: the database lock, message, retryAfterMinutes, Retry-After and audit entry all use it', async () => {
    process.env.LOCKOUT_MINUTES = '1'
    const user = await createUser()
    const wrong = await wrongLogins(user, 5)
    expect(wrong[4].status).toBe(423)
    expect(wrong[4].body).toEqual({
      message: 'Too many wrong passwords. Try again in 1 minute.',
      code: 'ACCOUNT_LOCKED',
      retryAfterMinutes: 1,
    })
    expect(wrong[4].headers['retry-after']).toBe('60')
    const [[{ seconds }]] = await pool.query(
      'SELECT TIMESTAMPDIFF(SECOND, NOW(), locked_until) AS seconds FROM users WHERE id = ?',
      [user.id],
    )
    expect(Number(seconds)).toBeGreaterThan(50)
    expect(Number(seconds)).toBeLessThanOrEqual(60)
    const [[audit]] = await pool.query(
      "SELECT details FROM audit_log WHERE action = 'account_locked' AND target_user_id = ? ORDER BY id DESC LIMIT 1",
      [user.id],
    )
    const details = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details
    expect(details).toMatchObject({ minutes: 1 })
  })

  test('is 15 minutes when not set, or set to something invalid', () => {
    delete process.env.LOCKOUT_MINUTES
    expect(lockoutMinutes()).toBe(15)
    for (const value of ['', 'abc', '0', '-5', '1.5', '1441']) {
      process.env.LOCKOUT_MINUTES = value
      expect([value, lockoutMinutes()]).toEqual([value, 15])
    }
  })

  test('is ignored outside the test environment: always 15', () => {
    for (const NODE_ENV of ['production', 'development', undefined]) {
      expect(lockoutMinutes({ NODE_ENV, LOCKOUT_MINUTES: '1' })).toBe(15)
    }
    expect(lockoutMinutes({ NODE_ENV: 'test', LOCKOUT_MINUTES: '3' })).toBe(3)
  })
})
