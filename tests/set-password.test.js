// One-time password links (src/passwordTokens.js) and the two ways a password reaches someone (password_delivery):
// with email set up, new accounts ('setup') and Admin/HR resets ('reset') get an emailed link; without, a temporary
// password is returned as before. Also GET /api/auth/set-password/validate and POST /api/auth/set-password (public),
// and POST /api/users/:id/resend-link (admin and HR, HR only for employees).
const crypto = require('crypto')
const pool = require('../src/db')
const { captureLogs } = require('../src/logger')
const { getMailer } = require('../src/mail/mailer')
const { issueToken, TOKEN_HOURS } = require('../src/passwordTokens')
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
  useEmail,
  withEmail,
} = require('./helpers')

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
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
const nextEmail = () => {
  emailCount += 1
  return `person.${emailCount}@test.local`
}
const create = (by = admin, extra = {}) =>
  api
    .post('/api/users')
    .set(auth(by.token))
    .send({ name: `Person ${emailCount}`, email: nextEmail(), role: 'employee', ...extra })
const reset = (id, by = admin) => api.post(`/api/users/${id}/reset-password`).set(auth(by.token))
const resend = (id, by = admin, body) => api.post(`/api/users/${id}/resend-link`).set(auth(by.token)).send(body)
const validateToken = (token) => api.get('/api/auth/set-password/validate').query({ token })
const setPassword = (token, password = 'my-own-pass1') =>
  api.post('/api/auth/set-password').send({ token, new_password: password })
const login = (email, password) => api.post('/api/auth/login').send({ email, password })
const tokenRows = async (userId) =>
  (await pool.query('SELECT * FROM password_tokens WHERE user_id = ? ORDER BY id', [userId]))[0]
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

// Creates an account with email set up and returns { user, token } from its setup email
async function invite(by = admin, extra = {}) {
  const res = await create(by, extra)
  expect(res.status).toBe(201)
  return { user: res.body.user, token: await inviteTokenFor(res.body.user.email) }
}

describe('POST /api/users: how the password is delivered', () => {
  test('email not set up: a temporary password in the response, no email', async () => {
    const res = await create()
    expect(res.status).toBe(201)
    expect(res.body).toEqual({
      user: expect.objectContaining({ must_change_password: true }),
      temporaryPassword: expect.stringMatching(/^[A-Za-z0-9]{12,}$/),
      password_delivery: 'temporary_password',
    })
    expect(await sentMail()).toEqual([])
    expect(await tokenRows(res.body.user.id)).toEqual([])
    expect((await login(res.body.user.email, res.body.temporaryPassword)).status).toBe(200)
  })

  describe('email set up', () => {
    withEmail()

    test('no password in the response; the setup link is emailed to the new user only', async () => {
      const res = await create()
      expect(res.status).toBe(201)
      expect(res.body).toEqual({
        user: expect.objectContaining({ must_change_password: true }),
        password_delivery: 'email',
      })
      expect(res.body).not.toHaveProperty('temporaryPassword')
      expect(res.body).not.toHaveProperty('temporary_password')

      const mail = await sentMail()
      expect(mail.map((m) => [m.to, m.subject])).toEqual([[res.body.user.email, 'Set up your TicketFlow account']])
      expect(mail[0].link).toMatch(/^http:\/\/localhost:5173\/set-password\?token=[A-Za-z0-9_-]{43}$/)
      expect(mail[0].text).toContain('This link expires in 48 hours and can be used once.')
      expect(mail[0].text).toContain("If you didn't expect this, contact your administrator.")
      expect((await tokenRows(res.body.user.id)).map((t) => t.purpose)).toEqual(['setup'])
    })

    test('the new account cannot log in before the link is used; afterwards it logs in normally', async () => {
      const { user, token } = await invite()
      for (const password of ['password123', 'anything-at-all1']) {
        expectError(await login(user.email, password), 401, undefined, 'Wrong email or password')
      }
      await setPassword(token, 'my-own-pass1').expect(200)
      const res = await login(user.email, 'my-own-pass1')
      expect(res.status).toBe(200)
      expect(res.body.user.must_change_password).toBe(false)
    })

    test('a failing SMTP server does not fail the request; the account is saved', async () => {
      const logs = captureLogs()
      getMailer().setTransport({
        sendMail: async () => {
          throw new Error('connect ECONNREFUSED')
        },
      })
      const res = await create()
      expect(res.status).toBe(201)
      expect(await dbUser(res.body.user.id)).toBeDefined()
      await sentMail()
      expect(logs.text()).toContain(`Could not send \\"accountSetup\\" to ${res.body.user.email}`)
    })
  })
})

describe('POST /api/users/:id/reset-password: how the password is delivered', () => {
  test('email not set up: the temporary password, unchanged; no email, no link', async () => {
    const target = await createUser()
    const res = await reset(target.id)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ password_delivery: 'temporary_password' })
    expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{12,}$/)
    expect(await sentMail()).toEqual([])
    expect(await tokenRows(target.id)).toEqual([])
  })

  describe('email set up', () => {
    withEmail()

    test('the old password stops working, sessions end, and a reset link is emailed; no password in the response', async () => {
      const target = await createUser()
      const session = await loginAs(target)
      const res = await reset(target.id)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ user: expect.objectContaining({ id: target.id }), password_delivery: 'email' })

      expectError(await login(target.email, target.password), 401, undefined, 'Wrong email or password')
      expectError(await api.get('/api/auth/me').set(auth(session)), 401, undefined)
      const [open] = await pool.query('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL', [target.id])
      expect(open).toHaveLength(0)

      const mail = await sentMail()
      expect(mail.map((m) => [m.to, m.subject])).toEqual([[target.email, 'Reset your TicketFlow password']])
      expect(mail[0].text).toContain('This link expires in 48 hours and can be used once.')
      expect((await tokenRows(target.id)).map((t) => t.purpose)).toEqual(['reset'])

      const token = await inviteTokenFor(target.email)
      expect((await validateToken(token)).body).toMatchObject({ status: 'valid', purpose: 'reset' })
      await setPassword(token, 'brand-new-pass2').expect(200)
      expect((await login(target.email, 'brand-new-pass2')).body.user.must_change_password).toBe(false)
    })

    test('the same permissions as before: HR only employees, nobody themselves, and refusals send nothing', async () => {
      const agent = await createUser({ role: 'agent' })
      expectError(await reset(agent.id, hr), 403, undefined, 'HR can only reset passwords of employee accounts')
      expectError(await reset(admin.id, admin), 403, undefined, 'Use Change password for your own account')
      expect(await sentMail()).toEqual([])
      expect(await tokenRows(agent.id)).toEqual([])
      await reset((await createUser()).id, hr).expect(200)
    })

    test('a failing SMTP server does not fail the reset', async () => {
      getMailer().setTransport({
        sendMail: async () => {
          throw new Error('connect ECONNREFUSED')
        },
      })
      const target = await createUser()
      await reset(target.id).expect(200)
      expect(await tokenRows(target.id)).toHaveLength(1)
    })
  })
})

describe('the token', () => {
  withEmail()

  test('is 32 random bytes (43 base64url characters); only its SHA-256 hash is stored, expiring in 48 hours', async () => {
    const before = realNow()
    const { user, token } = await invite()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)

    const [row] = await tokenRows(user.id)
    expect(row.token_hash).toBe(sha256(token))
    expect(JSON.stringify(await dbSnapshot())).not.toContain(token)
    expect(TOKEN_HOURS).toBe(48)
    const expiresIn = new Date(row.expires_at) - before
    expect(expiresIn).toBeGreaterThan(48 * HOUR - 5000)
    expect(expiresIn).toBeLessThanOrEqual(48 * HOUR + 5000)
  })

  test('works at 47h59m; at 48h01m it is 400 TOKEN_EXPIRED and nothing changes', async () => {
    const { user, token } = await invite()

    travel(47 * HOUR + 59 * MINUTE)
    expect((await validateToken(token)).body.status).toBe('valid')

    travel(48 * HOUR + MINUTE)
    expect((await validateToken(token)).body).toMatchObject({ status: 'expired', code: 'TOKEN_EXPIRED' })
    const before = await dbSnapshot()
    const res = await setPassword(token)
    expectError(res, 400, 'TOKEN_EXPIRED', 'This link has expired. Ask your administrator or HR for a new link.')
    expect(await dbSnapshot()).toEqual(before)
    expect((await dbUser(user.id)).must_change_password).toBe(1)
  })

  test('a new token (reset, or resend) makes the older ones stop working', async () => {
    const { user, token: setupToken } = await invite()
    await reset(user.id).expect(200)
    const resetToken = await inviteTokenFor(user.email)
    expect(resetToken).not.toBe(setupToken)
    expectError(await setPassword(setupToken), 400, 'TOKEN_INVALID')
    expect(await tokenRows(user.id)).toHaveLength(1)
    await issueToken(pool, user.id, 'reset')
    expectError(await setPassword(resetToken), 400, 'TOKEN_INVALID')
  })
})

describe('GET /api/auth/set-password/validate', () => {
  withEmail()

  test('a fresh link is valid and says its purpose and whose it is', async () => {
    const { user, token } = await invite()
    const res = await validateToken(token)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'valid', purpose: 'setup', email: user.email })
  })

  test('an unknown token and one of a deactivated account answer exactly the same', async () => {
    const { user, token } = await invite()
    await api.patch(`/api/users/${user.id}`).set(auth(admin.token)).send({ is_active: false }).expect(200)
    const unknown = await validateToken('x'.repeat(43))
    const deactivated = await validateToken(token)
    expect(unknown.body).toEqual({
      status: 'invalid',
      purpose: null,
      message: 'This link is not valid. Ask your administrator or HR for a new link.',
      code: 'TOKEN_INVALID',
    })
    expect(deactivated.body).toEqual(unknown.body)
    expect(deactivated.status).toBe(unknown.status)
  })

  test('a missing token is a 400; checking changes nothing and needs no login', async () => {
    expectError(await api.get('/api/auth/set-password/validate'), 400, undefined, 'Token is required')
    const { token } = await invite()
    const before = await dbSnapshot()
    await validateToken(token).expect(200)
    expect(await dbSnapshot()).toEqual(before)
  })
})

describe('POST /api/auth/set-password', () => {
  withEmail()

  test('sets the password, clears must_change_password and marks the link used; no session is started', async () => {
    const { user, token } = await invite()
    const res = await setPassword(token, 'my-own-pass1')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ message: 'Password set, please log in.' })
    expect(res.headers['set-cookie']).toBeUndefined()
    expect((await dbUser(user.id)).must_change_password).toBe(0)
    expect((await tokenRows(user.id))[0].used_at).not.toBeNull()
  })

  test('works once: a second use is 400 TOKEN_USED, and validate says "used"', async () => {
    const { token } = await invite()
    await setPassword(token).expect(200)
    expectError(await setPassword(token, 'another-pass2'), 400, 'TOKEN_USED')
    expect((await validateToken(token)).body).toMatchObject({ status: 'used', code: 'TOKEN_USED' })
  })

  test('the same link sent twice at the same moment works only once', async () => {
    const { token } = await invite()
    const results = await Promise.all([setPassword(token, 'first-pass11'), setPassword(token, 'second-pass2')])
    expect(results.map((r) => r.status).sort()).toEqual([200, 400])
    expect(results.find((r) => r.status === 400).body.code).toBe('TOKEN_USED')
  })

  test('an unknown token is 400 TOKEN_INVALID and changes nothing', async () => {
    await invite()
    const before = await dbSnapshot()
    expectError(await setPassword('x'.repeat(43)), 400, 'TOKEN_INVALID')
    expect(await dbSnapshot()).toEqual(before)
  })

  test.each([
    ['too short', 'short1', 'New password must be at least 10 characters'],
    ['no number', 'onlyletters', 'New password must contain at least one number'],
    ['no letter', '12345678901', 'New password must contain at least one letter'],
    ['too long', `a1${'x'.repeat(71)}`, 'New password must be 72 characters or less'],
  ])('a weak password (%s) is 422 naming new_password; the token stays unused', async (_, password, message) => {
    const { user, token } = await invite()
    const res = await setPassword(token, password)
    expectError(res, 422, 'WEAK_PASSWORD', message)
    expect(res.body.errors).toEqual([{ field: 'new_password', message }])
    expect((await tokenRows(user.id))[0].used_at).toBeNull()
    expect((await validateToken(token)).body.status).toBe('valid')
    await setPassword(token, 'good-pass-123').expect(200)
  })

  test('a malformed body is 400: missing fields or unknown ones', async () => {
    const { token } = await invite()
    expectError(await api.post('/api/auth/set-password').send({ token }), 400, undefined, 'New password is required')
    const extra = await api.post('/api/auth/set-password').send({ token, new_password: 'my-own-pass1', role: 'admin' })
    expectError(extra, 400, undefined, 'role is not allowed')
  })

  test("removes the user's other unused links", async () => {
    const { user, token } = await invite()
    const [row] = await tokenRows(user.id)
    const extra = crypto.randomBytes(32).toString('base64url')
    await pool.query('INSERT INTO password_tokens (user_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, ?)', [
      user.id,
      sha256(extra),
      'reset',
      row.expires_at,
    ])
    await setPassword(token).expect(200)
    expect(await tokenRows(user.id)).toHaveLength(1)
    expectError(await setPassword(extra), 400, 'TOKEN_INVALID')
  })

  test('works without a login, and a session with must_change_password does not get in the way', async () => {
    const flagged = await createUser({ mustChangePassword: true })
    const session = await loginAs(flagged)
    await resend(flagged.id).expect(200)
    const token = await inviteTokenFor(flagged.email)
    // Sent with the flagged user's own cookies: the must_change_password middleware doesn't apply here
    const res = await api
      .post('/api/auth/set-password')
      .set(auth(session))
      .send({ token, new_password: 'my-own-pass1' })
    expect(res.status).toBe(200)
    // …and it ended that session, like any password change by someone else
    expectError(await api.get('/api/auth/me').set(auth(session)), 401, undefined)
  })
})

describe('POST /api/users/:id/resend-link', () => {
  describe('email set up', () => {
    withEmail()

    test('sends a new link of the same purpose; the old one stops working', async () => {
      const { user, token: oldToken } = await invite()
      const res = await resend(user.id)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ user: expect.objectContaining({ id: user.id }), password_delivery: 'email' })
      const newToken = await inviteTokenFor(user.email)
      expect(newToken).not.toBe(oldToken)
      expectError(await setPassword(oldToken), 400, 'TOKEN_INVALID')
      expect((await tokenRows(user.id)).map((t) => t.purpose)).toEqual(['setup'])

      const target = await createUser()
      await reset(target.id).expect(200)
      await resend(target.id).expect(200)
      expect((await tokenRows(target.id)).map((t) => t.purpose)).toEqual(['reset'])
      expect((await sentMail()).filter((m) => m.to === target.email).map((m) => m.subject)).toEqual([
        'Reset your TicketFlow password',
        'Reset your TicketFlow password',
      ])
    })

    test('replaces an expired link', async () => {
      const { user, token: oldToken } = await invite()
      travel(49 * HOUR)
      expectError(await setPassword(oldToken), 400, 'TOKEN_EXPIRED')
      // The admin's own 8-hour session has run out by then too
      await resend(user.id, { token: await loginAs(admin) }).expect(200)
      await setPassword(await inviteTokenFor(user.email)).expect(200)
    })

    test('a setup link for someone who already has their own password is 409 PASSWORD_ALREADY_SET', async () => {
      const { user, token } = await invite()
      await setPassword(token).expect(200)
      expectError(await resend(user.id), 409, 'PASSWORD_ALREADY_SET')
      expectError(await resend((await createUser()).id, admin, { purpose: 'setup' }), 409, 'PASSWORD_ALREADY_SET')
    })

    test('HR may resend to employees only; employees and agents may not; no login is 401', async () => {
      const { user } = await invite(hr)
      await resend(user.id, hr).expect(200)
      const { user: agent } = await invite(admin, { role: 'agent' })
      const before = await tokenRows(agent.id)
      expectError(await resend(agent.id, hr), 403, undefined, 'HR can only send links to employee accounts')
      expect(await tokenRows(agent.id)).toEqual(before)
      for (const role of ['employee', 'agent']) {
        expect((await resend(user.id, { token: await loginAs(await createUser({ role })) })).status).toBe(403)
      }
      expect((await api.post(`/api/users/${user.id}/resend-link`)).status).toBe(401)
    })

    test('deactivated → 409 ACCOUNT_DEACTIVATED; unknown → 404; yourself → 403; a bad purpose → 400', async () => {
      const { user } = await invite()
      await api.patch(`/api/users/${user.id}`).set(auth(admin.token)).send({ is_active: false }).expect(200)
      expectError(await resend(user.id), 409, 'ACCOUNT_DEACTIVATED')
      expectError(await resend(999999), 404, undefined, 'User not found')
      expectError(await resend(admin.id), 403, undefined, 'Use Change password for your own account')
      const { user: other } = await invite()
      expectError(await resend(other.id, admin, { purpose: 'login' }), 400, undefined, 'purpose must be setup or reset')
    })
  })

  test('email not set up: 409 EMAIL_NOT_CONFIGURED, and nothing is issued or sent', async () => {
    useEmail(false)
    const flagged = await createUser({ mustChangePassword: true })
    expectError(await resend(flagged.id), 409, 'EMAIL_NOT_CONFIGURED')
    expect(await tokenRows(flagged.id)).toEqual([])
    expect(await sentMail()).toEqual([])
  })
})

describe('logs and audit', () => {
  withEmail()

  test('tokens and links never reach the console, through create, reset, resend, validate and set', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) =>
      jest.spyOn(console, level).mockImplementation(() => {}),
    )
    const captured = captureLogs() // the logger's lines (src/logger.js)
    const { user, token: first } = await invite()
    await resend(user.id).expect(200)
    const second = await inviteTokenFor(user.email)
    await validateToken(second).expect(200)
    await setPassword(second).expect(200)
    const target = await createUser()
    await reset(target.id).expect(200)
    const third = await inviteTokenFor(target.email)

    const written = [...spies.flatMap((spy) => spy.mock.calls.flat().map(String)), captured.text()].join('\n')
    for (const token of [first, second, third]) expect(written).not.toContain(token)
    expect(written).not.toContain('set-password?token=')
  })

  test('creating, resending and using a link are audited, never with the link or its token', async () => {
    const { user, token: first } = await invite()
    await resend(user.id).expect(200)
    const second = await inviteTokenFor(user.email)
    await setPassword(second).expect(200)

    const [logged] = await pool.query(
      'SELECT action, actor_id, details FROM audit_log WHERE target_user_id = ? ORDER BY id',
      [user.id],
    )
    expect(logged.map((e) => [e.action, e.actor_id])).toEqual([
      ['user_created', admin.id],
      ['invite_resent', admin.id],
      ['password_set_with_link', user.id],
    ])
    const text = JSON.stringify(logged)
    expect(text).not.toContain(first)
    expect(text).not.toContain(second)
    expect(text).toContain('email') // delivery: 'email'
  })
})
