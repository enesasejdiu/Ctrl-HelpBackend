// Follow-ups to the one-time password links: self-service "Forgot password" (POST /api/auth/forgot-password), retries
// for emails the SMTP server didn't take (sendMailSafe), and the cleanup of used and expired links.
const pool = require('../src/db')
const { createMailer, isTemporaryFailure, RETRY_DELAYS_MS } = require('../src/mail/mailer')
const { loadMailConfig } = require('../src/config')
const { cleanupPasswordTokens, startPasswordTokenCleanup, KEEP_ENDED_DAYS } = require('../src/passwordTokens')
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

const DAY = 24 * 60 * 60 * 1000
const MESSAGE =
  "If there's an active account for that email, we've sent it a link to choose a new password. It expires in 48 hours."

beforeEach(resetData)
afterEach(() => jest.restoreAllMocks())

const forgot = (email) => api.post('/api/auth/forgot-password').send({ email })
const login = (email, password) => api.post('/api/auth/login').send({ email, password })
const setPassword = (token, password) => api.post('/api/auth/set-password').send({ token, new_password: password })
const tokenRows = async (userId) =>
  (await pool.query('SELECT * FROM password_tokens WHERE user_id = ? ORDER BY id', [userId]))[0]

describe('POST /api/auth/forgot-password', () => {
  describe('email set up', () => {
    withEmail()

    test('the same answer for an active, an unknown and a deactivated address; only the active one gets an email', async () => {
      const active = await createUser({ email: 'active@test.local' })
      await createUser({ email: 'gone@test.local', isActive: false })

      const answers = []
      for (const email of ['active@test.local', 'nobody@test.local', 'gone@test.local']) {
        const res = await forgot(email)
        answers.push([res.status, res.body])
      }
      expect(answers).toEqual([
        [200, { message: MESSAGE }],
        [200, { message: MESSAGE }],
        [200, { message: MESSAGE }],
      ])

      const mail = await sentMail()
      expect(mail.map((m) => [m.to, m.subject])).toEqual([['active@test.local', 'Reset your TicketFlow password']])
      expect(mail[0].text).toContain(
        'Someone asked to reset the password of your TicketFlow account (active@test.local).',
      )
      expect(mail[0].text).toContain('This link expires in 48 hours and can be used once.')
      expect(mail[0].text).toContain("If you didn't ask for this, you can ignore this email")
      expect((await tokenRows(active.id)).map((t) => t.purpose)).toEqual(['reset'])
    })

    test('the email is matched in any letter case and with spaces, like everywhere else', async () => {
      await createUser({ email: 'mixed@test.local' })
      await forgot('  MIXED@Test.Local ').expect(200)
      expect((await sentMail()).map((m) => m.to)).toEqual(['mixed@test.local'])
    })

    test('the current password keeps working until the link sets a new one; then only the new one works', async () => {
      const user = await createUser({ email: 'forgetful@test.local' })
      const session = await loginAs(user)
      await forgot(user.email).expect(200)
      const token = await inviteTokenFor(user.email)

      // Asking for a reset changes nothing yet: nobody can lock you out with it
      expect((await login(user.email, user.password)).status).toBe(200)
      expect((await api.get('/api/auth/me').set(auth(session))).status).toBe(200)

      expect((await api.get('/api/auth/set-password/validate').query({ token })).body).toMatchObject({
        status: 'valid',
        purpose: 'reset',
      })
      await setPassword(token, 'remembered-now1').expect(200)
      expectError(await login(user.email, user.password), 401, undefined, 'Wrong email or password')
      expect((await login(user.email, 'remembered-now1')).status).toBe(200)
      // Setting it ended the sessions from before
      expectError(await api.get('/api/auth/me').set(auth(session)), 401, undefined)
    })

    test('at most one link every 5 minutes per account; the first link keeps working', async () => {
      const user = await createUser({ email: 'spammed@test.local' })
      await forgot(user.email).expect(200)
      const first = await inviteTokenFor(user.email)
      await forgot(user.email).expect(200)
      await forgot(user.email).expect(200)
      expect((await sentMail()).filter((m) => m.to === user.email)).toHaveLength(1)
      expect(await tokenRows(user.id)).toHaveLength(1)

      // 6 minutes later (the throttle uses the database clock, so the link's creation time is moved back)
      await pool.query('UPDATE password_tokens SET created_at = NOW() - INTERVAL 6 MINUTE WHERE user_id = ?', [user.id])
      await forgot(user.email).expect(200)
      const second = await inviteTokenFor(user.email)
      expect(second).not.toBe(first)
      expectError(await setPassword(first, 'whatever-pass1'), 400, 'TOKEN_INVALID')
    })

    test('it is audited without an actor, and never with the link or its token', async () => {
      const user = await createUser({ email: 'audited@test.local' })
      await forgot(user.email).expect(200)
      const token = await inviteTokenFor(user.email)
      const [entries] = await pool.query(
        "SELECT actor_id, target_user_id, details FROM audit_log WHERE action = 'password_reset_requested'",
      )
      expect(entries).toEqual([{ actor_id: null, target_user_id: user.id, details: null }])
      expect(JSON.stringify(entries)).not.toContain(token)
    })

    test('a bad body is 400, and refused requests issue nothing', async () => {
      expectError(await forgot('not-an-email'), 400, undefined, 'Enter a valid email')
      expectError(await api.post('/api/auth/forgot-password').send({}), 400, undefined, 'Email is required')
      const extra = await api.post('/api/auth/forgot-password').send({ email: 'a@test.local', role: 'admin' })
      expectError(extra, 400, undefined, 'role is not allowed')
      expect(await sentMail()).toEqual([])
    })

    test('needs no login, and the token never reaches the console', async () => {
      const spies = ['log', 'info', 'warn', 'error'].map((level) =>
        jest.spyOn(console, level).mockImplementation(() => {}),
      )
      const user = await createUser({ email: 'quiet@test.local' })
      await forgot(user.email).expect(200)
      const token = await inviteTokenFor(user.email)
      const written = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n')
      expect(written).not.toContain(token)
    })

    test('more than 10 requests from one address in 15 minutes get 429', async () => {
      process.env.RATE_LIMIT_IN_TESTS = '1'
      try {
        const statuses = []
        for (let i = 0; i < 11; i += 1) statuses.push((await forgot(`n${i}@test.local`)).status)
        expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true)
        expect(statuses[10]).toBe(429)
      } finally {
        delete process.env.RATE_LIMIT_IN_TESTS
      }
    })
  })

  test('email not set up: 409 EMAIL_NOT_CONFIGURED, and nothing is issued or sent', async () => {
    useEmail(false)
    const user = await createUser({ email: 'nomail@test.local' })
    const res = await forgot(user.email)
    expectError(
      res,
      409,
      'EMAIL_NOT_CONFIGURED',
      "Password reset by email isn't available. Ask your administrator or HR to reset your password.",
    )
    expect(await sentMail()).toEqual([])
    expect(await tokenRows(user.id)).toEqual([])
  })
})

describe('retries for emails the SMTP server did not take (sendMailSafe)', () => {
  const fakeLog = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() })
  const message = { to: 'ann@test.local', subject: 'Hi', text: 'body', html: '<p>body</p>', template: 'accountSetup' }
  const failure = (props) => Object.assign(new Error(props.message ?? 'failed'), props)

  function mailerFailing(failures, { retryDelaysMs = [5, 5, 5] } = {}) {
    const log = fakeLog()
    const mailer = createMailer(loadMailConfig({ NODE_ENV: 'test' }).mail, { log, retryDelaysMs })
    let attempts = 0
    mailer.setTransport({
      sendMail: async () => {
        attempts += 1
        if (failures.length) throw failures.shift()
        return {}
      },
    })
    return { mailer, log, attempts: () => attempts }
  }

  test('a temporary failure is tried again, and the email goes out', async () => {
    const { mailer, log, attempts } = mailerFailing([
      failure({ code: 'ECONNECTION', message: 'connect ECONNREFUSED' }),
      failure({ responseCode: 421, message: '421 try again later' }),
    ])
    await expect(mailer.sendMailSafe(message)).resolves.toBe(true)
    expect(attempts()).toBe(3)
    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(log.warn.mock.calls[0][0]).toMatch(
      /Could not send "accountSetup" to ann@test.local \(attempt 1\).*Trying again/,
    )
    expect(log.log.mock.calls[0][0]).toBe('[mail] Sent "accountSetup" to ann@test.local on attempt 3')
    expect(log.error).not.toHaveBeenCalled()
  })

  test('a permanent refusal (5xx) is not tried again', async () => {
    const { mailer, log, attempts } = mailerFailing([failure({ responseCode: 550, message: '550 no such user' })])
    await expect(mailer.sendMailSafe(message)).resolves.toBe(false)
    expect(attempts()).toBe(1)
    expect(log.error.mock.calls[0][0]).toBe('[mail] Could not send "accountSetup" to ann@test.local: 550 no such user')
  })

  test('after the last retry it gives up and says so', async () => {
    const down = () => failure({ code: 'ETIMEDOUT', message: 'timeout' })
    const { mailer, log, attempts } = mailerFailing([down(), down(), down(), down()])
    await expect(mailer.sendMailSafe(message)).resolves.toBe(false)
    expect(attempts()).toBe(4)
    expect(log.error.mock.calls[0][0]).toMatch(/timeout \(gave up after 4 attempts\)$/)
  })

  test('which failures count as temporary, and the delays outside tests (30 s, 2 min, 10 min)', () => {
    expect(isTemporaryFailure(failure({ code: 'ECONNECTION' }))).toBe(true)
    expect(isTemporaryFailure(failure({ responseCode: 451 }))).toBe(true)
    expect(isTemporaryFailure(failure({ responseCode: 535 }))).toBe(false)
    expect(RETRY_DELAYS_MS).toEqual([30_000, 120_000, 600_000])
  })
})

describe('cleanup of used and expired links', () => {
  test(`deletes links used or expired over ${KEEP_ENDED_DAYS} days ago; keeps recent and usable ones`, async () => {
    const user = await createUser()
    const at = (msAgo) => new Date(Date.now() - msAgo)
    const insert = (hash, { usedAt = null, expiresAt }) =>
      pool.query(
        'INSERT INTO password_tokens (user_id, token_hash, purpose, expires_at, used_at) VALUES (?, ?, ?, ?, ?)',
        [user.id, hash.repeat(64), 'setup', expiresAt, usedAt],
      )
    await insert('a', { usedAt: at(8 * DAY), expiresAt: at(6 * DAY) }) // used long ago: deleted
    await insert('b', { expiresAt: at(8 * DAY) }) // expired long ago: deleted
    await insert('c', { usedAt: at(2 * DAY), expiresAt: at(-1 * DAY) }) // used recently: kept
    await insert('d', { expiresAt: at(-1 * DAY) }) // still usable: kept

    await expect(cleanupPasswordTokens(pool)).resolves.toBe(2)
    expect((await tokenRows(user.id)).map((t) => t.token_hash[0])).toEqual(['c', 'd'])
  })

  test('the daily job runs at once, logs what it deleted, and never keeps the process alive', async () => {
    const user = await createUser()
    await pool.query('INSERT INTO password_tokens (user_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, ?)', [
      user.id,
      'e'.repeat(64),
      'reset',
      new Date(Date.now() - 9 * DAY),
    ])
    const log = { log: jest.fn(), error: jest.fn() }
    const timer = startPasswordTokenCleanup(pool, { log })
    try {
      expect(timer.hasRef()).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(log.log).toHaveBeenCalledWith('Password link cleanup: deleted 1 links used or expired over 7 days ago')
    } finally {
      clearInterval(timer)
    }
  })
})
