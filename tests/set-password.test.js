// Set-password links (src/passwordSetup.js): a new account gets an emailed link instead of a temporary password.
// GET /api/auth/set-password/validate and POST /api/auth/set-password (public), and
// POST /api/users/:id/resend-invite (admin and HR, HR only for employees).
const crypto = require('crypto')
const pool = require('../src/db')
const { issueToken, INVITE_HOURS } = require('../src/passwordSetup')
const {
  api,
  resetData,
  createUser,
  loginAs,
  auth,
  dbUser,
  dbSnapshot,
  expectError,
  sentMail,
  inviteTokenFor,
} = require('./helpers')

const HOUR = 60 * 60 * 1000
const realNow = Date.now

let admin
let hr

beforeEach(async () => {
  await resetData()
  admin = await createUser({ role: 'admin' })
  admin.token = await loginAs(admin)
  hr = await createUser({ role: 'hr' })
  hr.token = await loginAs(hr)
})

afterEach(() => {
  jest.restoreAllMocks()
})

// Moves the API's clock (Date.now) forward; time keeps running from there
function travel(ms) {
  jest.spyOn(Date, 'now').mockImplementation(() => realNow.call(Date) + ms)
}

let emailCount = 0
// Creates an account through the API (as the admin, or as `by`) and returns { user, token } from its email
async function invite(by = admin, extra = {}) {
  emailCount += 1
  const res = await api
    .post('/api/users')
    .set(auth(by.token))
    .send({ name: `Invited ${emailCount}`, email: `invited.${emailCount}@test.local`, role: 'employee', ...extra })
  expect(res.status).toBe(201)
  return { user: res.body.user, token: await inviteTokenFor(res.body.user.email) }
}

const validateToken = (token) => api.get('/api/auth/set-password/validate').query({ token })
const setPassword = (token, password = 'my-own-pass1') =>
  api.post('/api/auth/set-password').send({ token, new_password: password })
const tokenRows = async (userId) =>
  (await pool.query('SELECT * FROM password_setup_tokens WHERE user_id = ? ORDER BY id', [userId]))[0]

describe('the token', () => {
  test('is 32 random bytes (43 base64url characters); only its SHA-256 hash is stored, expiring in 72 hours', async () => {
    const before = realNow()
    const { user, token } = await invite()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)

    const [row] = await tokenRows(user.id)
    expect(row.token_hash).toBe(crypto.createHash('sha256').update(token).digest('hex'))
    expect(JSON.stringify(await dbSnapshot())).not.toContain(token)
    expect(INVITE_HOURS).toBe(72)
    const expiresIn = new Date(row.expires_at) - before
    expect(expiresIn).toBeGreaterThan(72 * HOUR - 5000)
    expect(expiresIn).toBeLessThanOrEqual(72 * HOUR + 5000)
  })
})

describe('GET /api/auth/set-password/validate', () => {
  test('a fresh link is valid and names the account', async () => {
    const { user, token } = await invite()
    const res = await validateToken(token)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'valid', name: user.name, email: user.email })
  })

  test('an unknown token is "invalid"; a missing one is a 400', async () => {
    expect((await validateToken('not-a-real-token')).body).toMatchObject({ status: 'invalid', code: 'TOKEN_INVALID' })
    const missing = await api.get('/api/auth/set-password/validate')
    expectError(missing, 400, undefined, 'Token is required')
  })

  test('needs no login, and changes nothing', async () => {
    const { token } = await invite()
    const before = await dbSnapshot()
    await validateToken(token).expect(200)
    expect(await dbSnapshot()).toEqual(before)
  })
})

describe('POST /api/auth/set-password', () => {
  test('sets the password, clears must_change_password, marks the link used; the user can log in', async () => {
    const { user, token } = await invite()
    expect((await dbUser(user.id)).must_change_password).toBe(1)

    const res = await setPassword(token, 'my-own-pass1')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ message: 'Password set, please log in.' })

    expect((await dbUser(user.id)).must_change_password).toBe(0)
    const [row] = await tokenRows(user.id)
    expect(row.used_at).not.toBeNull()

    const login = await api.post('/api/auth/login').send({ email: user.email, password: 'my-own-pass1' })
    expect(login.status).toBe(200)
    expect(login.body.user.must_change_password).toBe(false)
  })

  test('works once: a second use is 400 TOKEN_USED, and validate says "used"', async () => {
    const { token } = await invite()
    await setPassword(token).expect(200)
    const again = await setPassword(token, 'another-pass2')
    expectError(again, 400, 'TOKEN_USED')
    expect((await validateToken(token)).body).toMatchObject({ status: 'used', code: 'TOKEN_USED' })
  })

  test('the same link sent twice at the same moment works only once', async () => {
    const { token } = await invite()
    const results = await Promise.all([setPassword(token, 'first-pass11'), setPassword(token, 'second-pass2')])
    expect(results.map((r) => r.status).sort()).toEqual([200, 400])
    expect(results.find((r) => r.status === 400).body.code).toBe('TOKEN_USED')
  })

  test('expires after 72 hours: still valid just before, 400 TOKEN_EXPIRED after', async () => {
    const { user, token } = await invite()

    travel(71 * HOUR + 59 * 60 * 1000)
    expect((await validateToken(token)).body.status).toBe('valid')

    travel(72 * HOUR + 1000)
    expect((await validateToken(token)).body).toMatchObject({ status: 'expired', code: 'TOKEN_EXPIRED' })
    const before = await dbSnapshot()
    const res = await setPassword(token)
    expectError(res, 400, 'TOKEN_EXPIRED', 'This link has expired. Ask an admin or HR to send you a new one.')
    expect(await dbSnapshot()).toEqual(before)
    expect((await dbUser(user.id)).must_change_password).toBe(1)
  })

  test('an unknown token is 400 TOKEN_INVALID and changes nothing', async () => {
    await invite()
    const before = await dbSnapshot()
    expectError(await setPassword('x'.repeat(43)), 400, 'TOKEN_INVALID')
    expect(await dbSnapshot()).toEqual(before)
  })

  test("a deactivated account's link doesn't work", async () => {
    const { user, token } = await invite()
    await api.patch(`/api/users/${user.id}`).set(auth(admin.token)).send({ is_active: false }).expect(200)
    expectError(await setPassword(token), 400, 'TOKEN_INVALID')
    expect((await validateToken(token)).body.status).toBe('invalid')
  })

  // The project answers every validation problem with 400 (see middleware/validate.js), not 422
  test.each([
    ['too short', 'short1', 'New password must be at least 10 characters'],
    ['no number', 'onlyletters', 'New password must contain at least one number'],
    ['no letter', '12345678901', 'New password must contain at least one letter'],
    ['too long', `a1${'x'.repeat(71)}`, 'New password must be 72 characters or less'],
  ])(
    'a weak password (%s) is 400 naming new_password; the link still works afterwards',
    async (_, password, message) => {
      const { token } = await invite()
      const res = await setPassword(token, password)
      expectError(res, 400, undefined, message)
      expect(res.body.errors).toContainEqual({ field: 'new_password', message })
      expect((await validateToken(token)).body.status).toBe('valid')
    },
  )

  test('unknown fields are refused', async () => {
    const { token } = await invite()
    const res = await api.post('/api/auth/set-password').send({ token, new_password: 'my-own-pass1', role: 'admin' })
    expectError(res, 400, undefined, 'role is not allowed')
  })

  test("removes the user's other unused links", async () => {
    const { user, token } = await invite()
    // A second link issued straight in the database (the API itself only ever keeps the newest)
    const [tokenRow] = await tokenRows(user.id)
    const extra = crypto.randomBytes(32).toString('base64url')
    await pool.query('INSERT INTO password_setup_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)', [
      user.id,
      crypto.createHash('sha256').update(extra).digest('hex'),
      tokenRow.expires_at,
    ])

    await setPassword(token).expect(200)
    const rows = await tokenRows(user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].used_at).not.toBeNull()
    expectError(await setPassword(extra), 400, 'TOKEN_INVALID')
  })

  test('needs no session and no CSRF header', async () => {
    const { token } = await invite()
    const res = await api.post('/api/auth/set-password').send({ token, new_password: 'my-own-pass1' })
    expect(res.status).toBe(200)
  })
})

describe('POST /api/users/:id/resend-invite', () => {
  const resend = (id, token = admin.token) => api.post(`/api/users/${id}/resend-invite`).set(auth(token))

  test('sends a new link; the old one stops working and the new one works', async () => {
    const { user, token: oldToken } = await invite()
    const res = await resend(user.id)
    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(user.id)
    expect(res.body).toHaveProperty('inviteExpiresAt')
    expect(res.body).not.toHaveProperty('temporaryPassword')

    const newToken = await inviteTokenFor(user.email)
    expect(newToken).not.toBe(oldToken)
    expect(await tokenRows(user.id)).toHaveLength(1)
    expectError(await setPassword(oldToken), 400, 'TOKEN_INVALID')
    await setPassword(newToken).expect(200)
  })

  test('replaces an expired link', async () => {
    const { user, token: oldToken } = await invite()
    travel(73 * HOUR)
    expectError(await setPassword(oldToken), 400, 'TOKEN_EXPIRED')
    // The admin's own 8-hour session has run out by then too
    await resend(user.id, await loginAs(admin)).expect(200)
    await setPassword(await inviteTokenFor(user.email)).expect(200)
  })

  test('HR may resend to an employee', async () => {
    const { user } = await invite(hr)
    await resend(user.id, hr.token).expect(200)
  })

  test.each(['agent', 'admin', 'hr'])('HR resending to a(n) %s is 403, nothing is sent', async (role) => {
    const { user } = await invite(admin, { role })
    await sentMail() // the invitation itself
    const before = await tokenRows(user.id)
    const res = await resend(user.id, hr.token)
    expectError(res, 403, undefined, 'HR can only send invitations to employee accounts')
    expect(await tokenRows(user.id)).toEqual(before)
  })

  test.each(['employee', 'agent'])('a(n) %s gets 403', async (role) => {
    const { user } = await invite()
    const caller = await createUser({ role })
    expect((await resend(user.id, await loginAs(caller))).status).toBe(403)
  })

  test('without a login it is 401', async () => {
    const { user } = await invite()
    expect((await api.post(`/api/users/${user.id}/resend-invite`)).status).toBe(401)
  })

  test('a user who has set a password is 409 PASSWORD_ALREADY_SET (use reset-password instead)', async () => {
    const { user, token } = await invite()
    await setPassword(token).expect(200)
    const res = await resend(user.id)
    expectError(res, 409, 'PASSWORD_ALREADY_SET')
    const existing = await createUser()
    expectError(await resend(existing.id), 409, 'PASSWORD_ALREADY_SET')
  })

  test('a deactivated account is 409 ACCOUNT_DEACTIVATED, and no link is issued', async () => {
    const { user } = await invite()
    await api.patch(`/api/users/${user.id}`).set(auth(admin.token)).send({ is_active: false }).expect(200)
    const before = await tokenRows(user.id)
    expectError(await resend(user.id), 409, 'ACCOUNT_DEACTIVATED')
    expect(await tokenRows(user.id)).toEqual(before)
  })

  test('an unknown user is 404; a body is refused', async () => {
    expectError(await resend(999999), 404, undefined, 'User not found')
    const { user } = await invite()
    const res = await api
      .post(`/api/users/${user.id}/resend-invite`)
      .set(auth(admin.token))
      .send({ email: 'other@test.local' })
    expectError(res, 400, undefined, 'email is not allowed')
  })

  test('issueToken keeps only the newest unused link', async () => {
    const { user } = await invite()
    await issueToken(pool, user.id)
    await issueToken(pool, user.id)
    expect(await tokenRows(user.id)).toHaveLength(1)
  })
})
