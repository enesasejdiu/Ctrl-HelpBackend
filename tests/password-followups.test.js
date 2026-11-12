// Follow-ups to the one-time password links: retries for emails the SMTP server didn't take (sendMailSafe), and the
// cleanup of used and expired links. "Forgot password" has its own file (forgot-password.test.js).
const pool = require('../src/db')
const { createMailer, isTemporaryFailure, RETRY_DELAYS_MS } = require('../src/mail/mailer')
const { loadMailConfig } = require('../src/config')
const { cleanupPasswordTokens, startPasswordTokenCleanup, KEEP_ENDED_DAYS } = require('../src/passwordTokens')
const { resetData, createUser } = require('./helpers')

const DAY = 24 * 60 * 60 * 1000

beforeEach(resetData)
afterEach(() => jest.restoreAllMocks())

const tokenRows = async (userId) =>
  (await pool.query('SELECT * FROM password_tokens WHERE user_id = ? ORDER BY id', [userId]))[0]

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
