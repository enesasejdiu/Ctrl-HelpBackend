// Self-service "Forgot password": POST /api/auth/forgot-password, its 1-hour 'forgot' links, completing them with
// POST /api/auth/set-password, and GET /api/auth/config. The answer must never tell whether an account exists.
const pool = require('../src/db')
const { getMailer } = require('../src/mail/mailer')
const { FORGOT_TOKEN_MINUTES } = require('../src/passwordTokens')
const { FORGOT_PASSWORD_EMAIL_LIMIT, FORGOT_PASSWORD_LIMIT } = require('../src/middleware/rateLimit')
const {
  api,
  resetData,
  createUser,
  auth,
  loginAs,
  expectError,
  sentMail,
  inviteTokenFor,
  useEmail,
  withEmail,
} = require('./helpers')

const MESSAGE = "If an account exists for this email, we've sent a password reset link."
const MINUTE = 60 * 1000
const realNow = Date.now

beforeEach(resetData)
afterEach(() => jest.restoreAllMocks())

const forgot = (email) => api.post('/api/auth/forgot-password').send({ email })
const login = (email, password) => api.post('/api/auth/login').send({ email, password })
const setPassword = (token, password) => api.post('/api/auth/set-password').send({ token, new_password: password })
const validateToken = (token) => api.get('/api/auth/set-password/validate').query({ token })
const tokenRows = async (userId) =>
  (await pool.query('SELECT * FROM password_tokens WHERE user_id = ? ORDER BY id', [userId]))[0]
const travel = (ms) => jest.spyOn(Date, 'now').mockImplementation(() => realNow.call(Date) + ms)

// What a client can see of a response: status, body and headers (without Date, which is just the clock)
function visible(res) {
  const { date, ...headers } = res.headers
  return { status: res.status, body: res.body, headers }
}

// One account of each kind the answer must not tell apart
async function accounts() {
  return {
    active: await createUser({ email: 'active@test.local' }),
    inactive: await createUser({ email: 'inactive@test.local', isActive: false }),
    pending: await createUser({ email: 'pending@test.local', mustChangePassword: true }), // never set a password
  }
}

describe('the answer never tells whether an account exists', () => {
  withEmail()

  test('existing, unknown, deactivated and pending-invite addresses get identical status, body and headers', async () => {
    await accounts()
    const answers = []
    for (const email of ['active@test.local', 'nobody@test.local', 'inactive@test.local', 'pending@test.local']) {
      answers.push(visible(await forgot(email)))
    }
    expect(answers[0]).toEqual({ status: 200, body: { message: MESSAGE }, headers: expect.any(Object) })
    for (const answer of answers.slice(1)) expect(answer).toEqual(answers[0])
  })

  test('only the active account with its own password gets an email', async () => {
    const { active } = await accounts()
    for (const email of ['active@test.local', 'nobody@test.local', 'inactive@test.local', 'pending@test.local']) {
      await forgot(email).expect(200)
    }
    const mail = await sentMail()
    expect(mail.map((m) => [m.to, m.subject])).toEqual([[active.email, 'Reset your TicketFlow password']])
    expect((await tokenRows(active.id)).map((t) => t.purpose)).toEqual(['forgot'])
  })

  test('the same answer after the per-account email limit, and with email not set up', async () => {
    await accounts()
    const first = visible(await forgot('active@test.local'))
    for (let i = 1; i < FORGOT_PASSWORD_EMAIL_LIMIT; i += 1) await forgot('active@test.local')
    await sentMail()
    expect(visible(await forgot('active@test.local'))).toEqual(first) // over the limit
    useEmail(false)
    expect(visible(await forgot('active@test.local'))).toEqual(first) // email off
  })

  test('the response does not wait for the email, so an existing account is not slower', async () => {
    await accounts()
    let release
    const gate = new Promise((resolve) => (release = resolve))
    let attempts = 0
    getMailer().setTransport({
      sendMail: () => {
        attempts += 1
        return gate // never finishes until the test opens it
      },
    })
    // If the route waited for the email, the answer would never come: fail after 3 s instead of hanging
    let timer
    const tooSlow = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The response waited for the email')), 3000)
    })
    try {
      const res = await Promise.race([forgot('active@test.local'), tooSlow])
      expect(res.status).toBe(200)
    } finally {
      clearTimeout(timer)
      release({}) // let the held email finish, whatever happened
    }
    await sentMail()
    expect(attempts).toBe(1)
  })

  test('response times for an existing and an unknown address are about the same', async () => {
    await accounts()
    const time = async (email) => {
      const start = process.hrtime.bigint()
      await forgot(email).expect(200)
      return Number(process.hrtime.bigint() - start) / 1e6
    }
    const runs = { existing: [], unknown: [] }
    // Alternate, so both see the same machine load; reset the limit's count so every existing request does the work
    for (let i = 0; i < 8; i += 1) {
      await pool.query("DELETE FROM audit_log WHERE action = 'password_reset_requested'")
      runs.existing.push(await time('active@test.local'))
      runs.unknown.push(await time(`nobody${i}@test.local`))
      await sentMail()
    }
    const average = (list) => list.reduce((a, b) => a + b, 0) / list.length
    // Generous: the answer does the same work either way, so the difference is only noise
    expect(Math.abs(average(runs.existing) - average(runs.unknown))).toBeLessThan(50)
  })
})

describe('what a request does and does not change', () => {
  withEmail()

  test('the password and sessions stay as they are; the old password works until the reset is completed', async () => {
    const user = await createUser({ email: 'keeps@test.local' })
    const session = await loginAs(user)
    const [[before]] = await pool.query('SELECT password_hash, session_version FROM users WHERE id = ?', [user.id])

    await forgot(user.email).expect(200)
    await sentMail()

    const [[after]] = await pool.query('SELECT password_hash, session_version FROM users WHERE id = ?', [user.id])
    expect(after).toEqual(before)
    expect((await api.get('/api/auth/me').set(auth(session))).status).toBe(200)
    expect((await login(user.email, user.password)).status).toBe(200)
  })

  test('the email: the link, 1 hour, once, and "your password hasn\'t changed"', async () => {
    const user = await createUser({ email: 'mail@test.local', name: 'Mira Mail' })
    await forgot(user.email).expect(200)
    const [mail] = await sentMail()
    expect(mail.subject).toBe('Reset your TicketFlow password')
    expect(mail.link).toMatch(/^http:\/\/localhost:5173\/set-password\?token=[A-Za-z0-9_-]{43}$/)
    expect(mail.text).toContain('This link expires in 1 hour and can be used once.')
    expect(mail.text).toContain("If you didn't request this, you can ignore this email. Your password hasn't changed.")
    expect(mail.html).toContain(`href="${mail.link}"`)
  })

  test('the email is matched trimmed and in any letter case', async () => {
    await createUser({ email: 'mixed@test.local' })
    await forgot('  MIXED@Test.Local ').expect(200)
    expect((await sentMail()).map((m) => m.to)).toEqual(['mixed@test.local'])
  })
})

describe('limits', () => {
  withEmail()

  test(`at most ${FORGOT_PASSWORD_EMAIL_LIMIT} emails per account per hour: the 4th request is the same 200 with no email; an hour later it sends again`, async () => {
    const user = await createUser({ email: 'hourly@test.local' })
    const sent = []
    for (let i = 0; i < FORGOT_PASSWORD_EMAIL_LIMIT + 1; i += 1) {
      const res = await forgot(user.email)
      expect([res.status, res.body]).toEqual([200, { message: MESSAGE }])
      sent.push((await sentMail()).length) // each request's background work finishes before the next
    }
    expect(sent).toEqual([1, 2, 3, 3])
    // An hour later (the limit counts with the database clock, so the earlier requests are moved back)
    await pool.query(
      "UPDATE audit_log SET created_at = NOW() - INTERVAL 61 MINUTE WHERE action = 'password_reset_requested'",
    )
    await forgot(user.email).expect(200)
    expect((await sentMail()).length).toBe(4)
  })

  test(`more than ${FORGOT_PASSWORD_LIMIT} requests from one address in 15 minutes get 429 with Retry-After`, async () => {
    process.env.RATE_LIMIT_IN_TESTS = '1'
    try {
      const statuses = []
      let last
      for (let i = 0; i <= FORGOT_PASSWORD_LIMIT; i += 1) {
        last = await forgot(`n${i}@test.local`)
        statuses.push(last.status)
      }
      expect(statuses).toEqual([...Array(FORGOT_PASSWORD_LIMIT).fill(200), 429])
      expect(Number(last.headers['retry-after'])).toBeGreaterThan(0)
      expect(last.body.code).toBe('RATE_LIMITED')
    } finally {
      delete process.env.RATE_LIMIT_IN_TESTS
    }
  })
})

describe('the token', () => {
  withEmail()

  test('expires after 1 hour (still valid at 59 minutes)', async () => {
    const user = await createUser({ email: 'hour@test.local' })
    await forgot(user.email).expect(200)
    const token = await inviteTokenFor(user.email)
    expect(FORGOT_TOKEN_MINUTES).toBe(60)

    travel(59 * MINUTE)
    expect((await validateToken(token)).body).toMatchObject({ status: 'valid', purpose: 'forgot' })
    travel(61 * MINUTE)
    expect((await validateToken(token)).body).toMatchObject({ status: 'expired', purpose: 'forgot' })
    expectError(await setPassword(token, 'too-late-pass1'), 400, 'TOKEN_EXPIRED')
  })

  test('works once; a new request makes the older link stop working', async () => {
    const user = await createUser({ email: 'once@test.local' })
    await forgot(user.email).expect(200)
    const first = await inviteTokenFor(user.email)
    await forgot(user.email).expect(200)
    const second = await inviteTokenFor(user.email)
    expect(second).not.toBe(first)
    expectError(await setPassword(first, 'first-pass-11'), 400, 'TOKEN_INVALID')

    await setPassword(second, 'second-pass-22').expect(200)
    expectError(await setPassword(second, 'third-pass-33'), 400, 'TOKEN_USED')
    expect((await validateToken(second)).body).toMatchObject({ status: 'used', purpose: 'forgot' })
  })

  test('an unknown token still says nothing about its purpose', async () => {
    expect((await validateToken('x'.repeat(43))).body).toMatchObject({ status: 'invalid', purpose: null })
  })
})

describe('completing the reset', () => {
  withEmail()

  test('new password works, old one doesn\'t; all sessions end; the lock is cleared; a "password changed" email', async () => {
    const user = await createUser({ email: 'complete@test.local', name: 'Cora Complete' })
    const sessions = [await loginAs(user), await loginAs(user)]
    // Locked out by wrong passwords
    await pool.query(
      'UPDATE users SET failed_login_count = 5, locked_until = NOW() + INTERVAL 15 MINUTE WHERE id = ?',
      [user.id],
    )

    await forgot(user.email).expect(200)
    const token = await inviteTokenFor(user.email)
    getMailer().outbox.length = 0
    await setPassword(token, 'brand-new-pass1').expect(200)

    expectError(await login(user.email, user.password), 401, undefined, 'Wrong email or password')
    expect((await login(user.email, 'brand-new-pass1')).status).toBe(200) // no lock any more
    for (const session of sessions) {
      expectError(await api.get('/api/auth/me').set(auth(session)), 401, undefined)
    }
    const [[row]] = await pool.query('SELECT must_change_password, locked_until FROM users WHERE id = ?', [user.id])
    expect(row).toEqual({ must_change_password: 0, locked_until: null })

    const mail = await sentMail()
    expect(mail.map((m) => [m.to, m.subject])).toEqual([[user.email, 'Your TicketFlow password was changed']])
    expect(mail[0].text).toContain(
      "Your TicketFlow password was changed. If this wasn't you, contact your administrator.",
    )
    expect(mail[0].text).not.toMatch(/https?:\/\//)
  })

  test('is audited as password_reset_self (and the request as password_reset_requested)', async () => {
    const user = await createUser({ email: 'audit@test.local' })
    await forgot(user.email).expect(200)
    const token = await inviteTokenFor(user.email)
    await setPassword(token, 'audited-pass-1').expect(200)
    const [entries] = await pool.query('SELECT action, actor_id FROM audit_log WHERE target_user_id = ? ORDER BY id', [
      user.id,
    ])
    expect(entries).toEqual([
      { action: 'password_reset_requested', actor_id: null },
      { action: 'password_reset_self', actor_id: user.id },
    ])
    expect(JSON.stringify(entries)).not.toContain(token)
  })

  test('other links (setup, admin reset) send no "password changed" email', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await api
      .post('/api/users')
      .set(auth(await loginAs(admin)))
      .send({ name: 'New One', email: 'new.one@test.local', role: 'employee' })
    const token = await inviteTokenFor(res.body.user.email)
    getMailer().outbox.length = 0
    await setPassword(token, 'setup-pass-123').expect(200)
    expect(await sentMail()).toEqual([])
  })
})

describe('email not set up', () => {
  test('the same 200, nothing sent or issued, and a warning in the log', async () => {
    useEmail(false)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const user = await createUser({ email: 'nomail@test.local' })
    const res = await forgot(user.email)
    expect([res.status, res.body]).toEqual([200, { message: MESSAGE }])
    expect(await sentMail()).toEqual([])
    expect(await tokenRows(user.id)).toEqual([])
    expect(warn.mock.calls.flat().join('\n')).toMatch(/email is not set up/)
  })

  test('GET /api/auth/config says whether email is set up (public)', async () => {
    useEmail(false)
    expect((await api.get('/api/auth/config')).body).toEqual({ email_enabled: false })
    useEmail(true)
    expect((await api.get('/api/auth/config')).body).toEqual({ email_enabled: true })
  })
})

describe('validation and logs', () => {
  withEmail()

  test('a malformed email is 422 (a format check only); a missing one too', async () => {
    expectError(await forgot('not-an-email'), 422, undefined, 'Enter a valid email')
    expectError(await api.post('/api/auth/forgot-password').send({}), 422, undefined, 'Email is required')
    expectError(
      await api.post('/api/auth/forgot-password').send({ email: 'a@test.local', role: 'admin' }),
      422,
      undefined,
      'role is not allowed',
    )
    expect(await sentMail()).toEqual([])
  })

  test('the logs hold no token, no link, no address and no "not found"', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) =>
      jest.spyOn(console, level).mockImplementation(() => {}),
    )
    const user = await createUser({ email: 'logged@test.local' })
    await forgot(user.email).expect(200)
    await forgot('ghost@test.local').expect(200)
    const token = await inviteTokenFor(user.email)
    await setPassword(token, 'logged-pass-12').expect(200)
    await sentMail()

    const written = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n')
    expect(written).not.toContain(token)
    expect(written).not.toContain('set-password?token=')
    expect(written).not.toContain('logged@test.local')
    expect(written).not.toContain('ghost@test.local')
    expect(written).not.toMatch(/not found|no account|unknown/i)
    // Every request logs the same line, with only a fingerprint of the address
    expect(written.match(/\[auth\] Password reset requested \(email #[0-9a-f]{12}\)/g)).toHaveLength(2)
  })
})
