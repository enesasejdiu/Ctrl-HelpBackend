// Email through a real SMTP server: the app sends with its own nodemailer SMTP transport to an in-process smtp-server
// (tests/support/fakeSmtp.js), and each test reads the parsed messages that actually arrived. What tests/notifications.test.js
// checks with the in-memory jsonTransport (who gets what) is checked here on the wire: headers, From, both parts, the
// company name, links from APP_URL, the password flows end to end, and what a failing SMTP server does to requests and logs.
const pool = require('../src/db')
const { runAutoClose } = require('../src/jobs/autoClose')
const { api, resetData, createUser, auth, dbUser } = require('./helpers')
const { assertThrowawayDb } = require('./support/guard')
const { startFakeSmtp } = require('./support/fakeSmtp')
const { userWithRole, oneOfEachRole, createTicket } = require('./support/factories')
const { FORGOT_PASSWORD_EMAIL_LIMIT } = require('../src/middleware/rateLimit')

const APP_URL = 'https://helpdesk.acme.test'
const COMPANY = 'Acme Widgets Ltd'
const NEW_PASSWORD = 'Correct-Horse-42-battery'
const FORGOT_MESSAGE = "If an account exists for this email, we've sent a password reset link."

let smtp
let logs
let people

beforeAll(async () => {
  await assertThrowawayDb()
  smtp = await startFakeSmtp()
})
afterAll(async () => {
  smtp.stopUsingForApp()
  await smtp.stop()
})

beforeEach(async () => {
  process.env.APP_URL = APP_URL
  smtp.setMode('accept')
  smtp.useForApp()
  await resetData()
  people = await oneOfEachRole()
  const set = await api.patch('/api/settings').set(auth(people.admin.token)).send({ company_name: COMPANY })
  expect(set.status).toBe(200)
  await smtp.getMails()
  smtp.clearMails()
  // Every line the app logs during the test, to check none of them carries a secret
  logs = []
  for (const level of ['log', 'info', 'warn', 'error']) {
    jest.spyOn(console, level).mockImplementation((...args) => logs.push(args.map(String).join(' ')))
  }
})

afterEach(async () => {
  await smtp.getMails() // the test's background mail has finished before the logs are checked
  expectCleanLogs() // in every test: no token, no link, no SMTP password in any log line
  jest.restoreAllMocks()
  process.env.APP_URL = 'http://localhost:5173'
  smtp.stopUsingForApp()
})

// ---- helpers ----
const post = (path, user, body) => api.post(path).set(auth(user.token)).send(body)
const patch = (path, user, body) => api.patch(path).set(auth(user.token)).send(body)
const tokenOf = (link) => new URL(link).searchParams.get('token')

// No log line contains a set-password token, a link into the app, or the SMTP password
function expectCleanLogs(secrets = []) {
  for (const line of logs) {
    expect(line).not.toContain(APP_URL)
    expect(line).not.toContain(smtp.SMTP_PASS)
    expect(line).not.toMatch(/token=(?!\[redacted\])/i)
    for (const secret of secrets) expect(line).not.toContain(secret)
  }
}

// The rules every email follows: envelope and To, From = MAIL_FROM, a subject, a text and an HTML part, the company
// name from the settings, links only into APP_URL, and no secret in any header
function expectWellFormed(mail, to) {
  expect(mail.envelope.to).toEqual([to])
  expect(mail.to).toEqual([to])
  expect(mail.from).toBe(smtp.MAIL_FROM)
  expect(mail.subject).toEqual(expect.any(String))
  expect(mail.subject).not.toMatch(/[\r\n]/)
  expect(mail.text.length).toBeGreaterThan(0)
  expect(mail.html).toMatch(/^<!doctype html>/i)
  expect(mail.text).toContain(COMPANY)
  expect(mail.html).toContain(COMPANY)
  for (const url of [...mail.text.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0])) {
    expect(url.startsWith(`${APP_URL}/`)).toBe(true)
  }
  const headers = mail.headers.join('\n')
  expect(headers).not.toContain(smtp.SMTP_PASS)
  expect(headers).not.toContain(process.env.JWT_SECRET)
  expect(headers).not.toMatch(/token=/i)
  if (process.env.DB_PASSWORD) expect(headers).not.toContain(process.env.DB_PASSWORD)
}

async function newTicket(requester, title = 'Printer not working') {
  const [[{ id: categoryId }]] = await pool.query('SELECT id FROM categories ORDER BY id LIMIT 1')
  const res = await post('/api/tickets', requester, {
    title,
    description: 'The printer on floor 2 shows error E7.',
    category_id: categoryId,
  })
  expect(res.status).toBe(201)
  return res.body
}

describe('the transport', () => {
  test('mail goes over real SMTP with the configured login, the envelope sender is MAIL_FROM', async () => {
    const res = await post('/api/users', people.admin, { name: 'Nina New', email: 'nina@acme.test', role: 'employee' })
    expect(res.status).toBe(201)
    const mail = await smtp.waitForMail({ to: 'nina@acme.test' })
    expect(mail.envelope.from).toBe('helpdesk@acme.test')
    expect(smtp.auths).toEqual([{ username: 'smtp-test-user', password: smtp.SMTP_PASS }])
    expect(mail.raw).toMatch(/^Content-Type: multipart\/alternative/im)
  })

  test('links come from APP_URL, never from the request Host header', async () => {
    const res = await api
      .post('/api/users')
      .set(auth(people.admin.token))
      .set('Host', 'evil.example')
      .set('X-Forwarded-Host', 'evil.example')
      .send({ name: 'Hosty', email: 'hosty@acme.test', role: 'employee' })
    expect(res.status).toBe(201)
    const mail = await smtp.waitForMail({ to: 'hosty@acme.test' })
    expect(smtp.extractLink(mail)).toMatch(new RegExp(`^${APP_URL}/set-password\\?token=`))
    expect(mail.raw).not.toContain('evil.example')
  })
})

describe('invite (new account, email set up)', () => {
  test('the user gets a set-password link that works once; the response has no temporary password', async () => {
    const res = await post('/api/users', people.admin, { name: 'Ina Invite', email: 'ina@acme.test', role: 'agent' })
    expect(res.status).toBe(201)
    expect(res.body.password_delivery).toBe('email')
    expect(res.body).not.toHaveProperty('temporaryPassword')
    expect(JSON.stringify(res.body)).not.toMatch(/temporary_?password"\s*:\s*"/i)

    const mail = await smtp.waitForMail({ to: 'ina@acme.test', subject: `Set up your ${COMPANY} account` })
    expectWellFormed(mail, 'ina@acme.test')
    expect(mail.text).toContain(people.admin.name)
    const link = smtp.extractLink(mail)
    expect(link).toMatch(new RegExp(`^${APP_URL}/set-password\\?token=[^&\\s]+$`))
    expect(mail.html).toContain(link.replace(/&/g, '&amp;'))

    const first = await api.post('/api/auth/set-password').send({ token: tokenOf(link), new_password: NEW_PASSWORD })
    expect(first.status).toBe(200)
    const login = await api.post('/api/auth/login').send({ email: 'ina@acme.test', password: NEW_PASSWORD })
    expect(login.status).toBe(200)

    const second = await api
      .post('/api/auth/set-password')
      .send({ token: tokenOf(link), new_password: 'Another-pass-99' })
    expect(second.status).toBe(400)
    expect(second.body.code).toBe('TOKEN_USED')
    expectCleanLogs([tokenOf(link)])
  })

  test('HR can invite too; only the new user gets the email', async () => {
    const res = await post('/api/users', people.hr, { name: 'Hal Hired', email: 'hal@acme.test' })
    expect(res.status).toBe(201)
    await smtp.waitForMail({ to: 'hal@acme.test' })
    expect((await smtp.getMails()).map((m) => m.envelope.to)).toEqual([['hal@acme.test']])
  })
})

describe('temporary-password mode (email not set up)', () => {
  test('MAIL_ENABLED is not true: nothing reaches the SMTP server, even with SMTP_HOST pointing at it', async () => {
    smtp.useForApp({ enabled: false }) // SMTP_HOST and MAIL_FROM still point at the fake server

    const res = await post('/api/users', people.admin, { name: 'Tia Temp', email: 'tia@acme.test', role: 'employee' })
    expect(res.status).toBe(201)
    expect(res.body.password_delivery).toBe('temporary_password')
    expect(res.body.temporaryPassword).toEqual(expect.any(String))
    await newTicket(people.employee)
    const reset = await post(`/api/users/${people.employee.id}/reset-password`, people.admin, {})
    expect(reset.status).toBe(200)
    expect(reset.body.password_delivery).toBe('temporary_password')

    expect(await smtp.getMails()).toEqual([])
    expectCleanLogs([res.body.temporaryPassword, reset.body.temporaryPassword])
  })
})

describe('admin / HR password reset', () => {
  test.each(['admin', 'hr'])('a reset by %s emails a one-time reset link to the user only', async (by) => {
    const target = await userWithRole('employee', { email: `target-${by}@acme.test` })
    const res = await post(`/api/users/${target.id}/reset-password`, people[by], {})
    expect(res.status).toBe(200)
    expect(res.body.password_delivery).toBe('email')
    expect(res.body).not.toHaveProperty('temporaryPassword')

    const mail = await smtp.waitForMail({ to: target.email, subject: `Reset your ${COMPANY} password` })
    expectWellFormed(mail, target.email)
    expect(mail.text).toContain(people[by].name)
    const link = smtp.extractLink(mail)
    const set = await api.post('/api/auth/set-password').send({ token: tokenOf(link), new_password: NEW_PASSWORD })
    expect(set.status).toBe(200)
    expect((await smtp.getMails()).map((m) => m.envelope.to[0])).toEqual([target.email])
    expectCleanLogs([tokenOf(link)])
  })
})

describe('forgot password', () => {
  const forgot = (email) => api.post('/api/auth/forgot-password').send({ email })

  test('the same answer for every address; only the active account with its own password gets an email', async () => {
    const active = await createUser({ email: 'active@acme.test' })
    await createUser({ email: 'inactive@acme.test', isActive: false })
    await createUser({ email: 'pending@acme.test', mustChangePassword: true })

    const answers = []
    for (const email of ['active@acme.test', 'nobody@acme.test', 'inactive@acme.test', 'pending@acme.test']) {
      const res = await forgot(email)
      answers.push({ status: res.status, body: res.body, type: res.headers['content-type'] })
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1)
    expect(answers[0]).toEqual({ status: 200, body: { message: FORGOT_MESSAGE }, type: expect.stringMatching(/json/) })

    const mails = await smtp.getMails()
    expect(mails.map((m) => m.envelope.to[0])).toEqual([active.email])
    const [mail] = mails
    expectWellFormed(mail, active.email)
    expect(mail.subject).toBe(`Reset your ${COMPANY} password`)
    expect(mail.text).toContain('expires in 1 hour')
    expectCleanLogs([tokenOf(smtp.extractLink(mail)), 'nobody@acme.test', 'active@acme.test'])
  })

  test(`at most ${FORGOT_PASSWORD_EMAIL_LIMIT} emails per address per hour; the answer never changes`, async () => {
    const user = await createUser({ email: 'limited@acme.test' })
    const statuses = []
    for (let i = 0; i < FORGOT_PASSWORD_EMAIL_LIMIT + 2; i += 1) {
      statuses.push((await forgot(user.email)).status)
      await smtp.getMails() // each request's email (or not) is settled before the next is counted
    }
    expect(statuses).toEqual(Array(FORGOT_PASSWORD_EMAIL_LIMIT + 2).fill(200))
    expect(await smtp.getMails()).toHaveLength(FORGOT_PASSWORD_EMAIL_LIMIT)
  })

  test('completing the reset sends a "password changed" notice, with no link in it', async () => {
    const user = await createUser({ email: 'changer@acme.test' })
    await forgot(user.email)
    const link = smtp.extractLink(await smtp.waitForMail({ to: user.email, subject: /Reset your/ }))
    smtp.clearMails()

    const res = await api.post('/api/auth/set-password').send({ token: tokenOf(link), new_password: NEW_PASSWORD })
    expect(res.status).toBe(200)
    const notice = await smtp.waitForMail({ to: user.email, subject: `Your ${COMPANY} password was changed` })
    expectWellFormed(notice, user.email)
    expect(smtp.extractLink(notice)).toBeNull()
    expect(notice.html).not.toMatch(/<a\s/i)
    expectCleanLogs([tokenOf(link)])
  })
})

describe('ticket events', () => {
  test('a new ticket goes to every active agent, never to the requester or an inactive agent', async () => {
    const agent2 = await userWithRole('agent', { email: 'agent2@acme.test' })
    await createUser({ role: 'agent', email: 'gone@acme.test', isActive: false })
    const ticket = await newTicket(people.employee)

    const mails = await smtp.getMails()
    expect(mails.map((m) => m.envelope.to[0]).sort()).toEqual([people.agent.email, agent2.email].sort())
    for (const mail of mails) {
      expectWellFormed(mail, mail.envelope.to[0])
      expect(smtp.extractLink(mail)).toBe(`${APP_URL}/tickets/${ticket.id}`)
    }
  })

  test('an agent opening a ticket is not told about it', async () => {
    const agent2 = await userWithRole('agent')
    await newTicket(people.agent)
    expect((await smtp.getMails()).map((m) => m.envelope.to[0])).toEqual([agent2.email])
  })

  test('assigning emails the assignee, not the admin who assigned', async () => {
    const ticket = await createTicket({ requester: people.employee })
    const res = await patch(`/api/tickets/${ticket.id}/assign`, people.admin, { assigned_to: people.agent.id })
    expect(res.status).toBe(200)
    const mail = await smtp.waitForMail({ to: people.agent.email })
    expectWellFormed(mail, people.agent.email)
    expect((await smtp.getMails()).map((m) => m.envelope.to[0])).toEqual([people.agent.email])
  })

  test('taking a ticket yourself sends nothing', async () => {
    const ticket = await createTicket({ requester: people.employee })
    await patch(`/api/tickets/${ticket.id}/assign`, people.agent, { assigned_to: people.agent.id })
    expect(await smtp.getMails()).toEqual([])
  })

  test('comments go to the other side; internal notes and the author get nothing', async () => {
    const ticket = await createTicket({ requester: people.employee, assignee: people.agent })

    await post(`/api/tickets/${ticket.id}/comments`, people.employee, { content: 'Still broken' })
    expect((await smtp.getMails()).map((m) => m.envelope.to[0])).toEqual([people.agent.email])
    smtp.clearMails()

    await post(`/api/tickets/${ticket.id}/comments`, people.agent, { content: 'On my way' })
    expect((await smtp.getMails()).map((m) => m.envelope.to[0])).toEqual([people.employee.email])
    smtp.clearMails()

    const note = await post(`/api/tickets/${ticket.id}/comments`, people.agent, {
      content: 'Internal: the user broke it',
      is_internal: true,
    })
    expect(note.status).toBe(201)
    expect(await smtp.getMails()).toEqual([])
  })

  test('a deactivated requester gets nothing', async () => {
    const leaver = await userWithRole('employee')
    const ticket = await createTicket({ requester: leaver, assignee: people.agent })
    await pool.query('UPDATE users SET is_active = FALSE WHERE id = ?', [leaver.id])
    await post(`/api/tickets/${ticket.id}/comments`, people.agent, { content: 'Any news?' })
    await patch(`/api/tickets/${ticket.id}/status`, people.agent, { status: 'resolved', resolution: 'Fixed' })
    expect(await smtp.getMails()).toEqual([])
  })

  test('resolving emails the requester with the resolution', async () => {
    const ticket = await createTicket({ requester: people.employee, assignee: people.agent })
    const res = await patch(`/api/tickets/${ticket.id}/status`, people.agent, {
      status: 'resolved',
      resolution: 'Replaced the toner',
    })
    expect(res.status).toBe(200)
    const mail = await smtp.waitForMail({ to: people.employee.email })
    expectWellFormed(mail, people.employee.email)
    expect(mail.text).toContain('Replaced the toner')
  })

  test('the auto-close job closes resolved tickets without sending any email', async () => {
    const ticket = await createTicket({ requester: people.employee, assignee: people.agent, status: 'resolved' })
    await pool.query('UPDATE tickets SET resolved_at = NOW() - INTERVAL 30 DAY WHERE id = ?', [ticket.id])
    const result = await runAutoClose({ log: { log() {}, warn() {}, error() {} } })
    expect(result.closed).toBe(1)
    expect((await pool.query('SELECT status FROM tickets WHERE id = ?', [ticket.id]))[0][0].status).toBe('closed')
    expect(await smtp.getMails()).toEqual([])
  })
})

describe('escaping', () => {
  test('<script> and <b> in a title and a comment are escaped in the HTML part and kept as text in the text part', async () => {
    const title = '<script>alert(1)</script> <b>bold</b> printer'
    const ticket = await newTicket(people.employee, title)
    const created = await smtp.waitForMail({ to: people.agent.email })
    expect(created.subject).toContain(title)
    expect(created.text).toContain(title)
    expect(created.html).not.toMatch(/<script/i)
    expect(created.html).not.toContain('<b>bold</b>')
    expect(created.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(created.html).toContain('&lt;b&gt;bold&lt;/b&gt;')
    smtp.clearMails()

    await patch(`/api/tickets/${ticket.id}/assign`, people.admin, { assigned_to: people.agent.id })
    await smtp.getMails()
    smtp.clearMails()
    await post(`/api/tickets/${ticket.id}/comments`, people.employee, {
      content: '<img src=x onerror=alert(2)> and <b>more</b>',
    })
    const comment = await smtp.waitForMail({ to: people.agent.email })
    expect(comment.html).not.toMatch(/<img/i)
    expect(comment.html).not.toContain('<b>more</b>')
    expect(comment.html).toContain('&lt;img src=x onerror=alert(2)&gt;')
    expect(comment.text).toContain('<b>more</b>')
  })

  test('a name with markup is escaped in the greeting', async () => {
    await post('/api/users', people.admin, { name: '<b>Bold</b> Name', email: 'bold@acme.test', role: 'employee' })
    const mail = await smtp.waitForMail({ to: 'bold@acme.test' })
    expect(mail.html).toContain('Hello &lt;b&gt;Bold&lt;/b&gt; Name,')
    expect(mail.text).toContain('Hello <b>Bold</b> Name,')
  })
})

describe('when the SMTP server fails', () => {
  test.each(['reject-connections', '5xx'])(
    '%s: creating a user still succeeds, and the log has no password, token or link',
    async (mode) => {
      smtp.setMode(mode)
      const res = await post('/api/users', people.admin, { name: 'Down Dan', email: 'dan@acme.test', role: 'employee' })
      expect(res.status).toBe(201)
      expect(res.body.password_delivery).toBe('email')
      expect(await dbUser(res.body.user.id)).toBeTruthy()

      expect(await smtp.getMails()).toEqual([])
      const failures = logs.filter((line) => line.includes('[mail] Could not send'))
      expect(failures).toHaveLength(1)
      expect(failures[0]).toContain('dan@acme.test')
      expect(failures[0]).toContain('accountSetup')
      const [[token]] = await pool.query('SELECT token_hash FROM password_tokens WHERE user_id = ?', [res.body.user.id])
      expectCleanLogs([token.token_hash])
    },
  )

  test('5xx: tickets, comments, resets and forgot-password requests all still succeed', async () => {
    smtp.setMode('5xx')
    const ticket = await newTicket(people.employee)
    expect((await post(`/api/tickets/${ticket.id}/comments`, people.agent, { content: 'Hi' })).status).toBe(201)
    expect((await post(`/api/users/${people.employee.id}/reset-password`, people.hr, {})).status).toBe(200)
    expect((await api.post('/api/auth/forgot-password').send({ email: people.agent.email })).status).toBe(200)
    expect(await smtp.getMails()).toEqual([])
    expect(logs.filter((line) => line.includes('[mail] Could not send')).length).toBeGreaterThanOrEqual(4)
    expectCleanLogs()
  })

  test('a server that recovers gets the next email', async () => {
    smtp.setMode('5xx')
    await post('/api/users', people.admin, { name: 'First Try', email: 'first@acme.test', role: 'employee' })
    await smtp.getMails()
    smtp.setMode('accept')
    await post('/api/users', people.admin, { name: 'Second Try', email: 'second@acme.test', role: 'employee' })
    expect((await smtp.getMails()).map((m) => m.envelope.to[0])).toEqual(['second@acme.test'])
  })
})
