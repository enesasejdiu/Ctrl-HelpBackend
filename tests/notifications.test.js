const { captureLogs } = require('../src/logger')
// Email notifications (src/mail/notifications.js) through the real routes, with nodemailer's jsonTransport: who gets
// which email for each event, and nobody else. Also: escaping, links, and that a failing SMTP server never fails a
// request or leaks secrets into the log.
const pool = require('../src/db')
const { getMailer, resetMailer } = require('../src/mail/mailer')
const { EXCERPT_LENGTH } = require('../src/mail/templates')
const { api, resetData, createUser, loginAs, auth, sentMail, useEmail } = require('./helpers')

let people
let categoryId
let priorityId

beforeAll(async () => {
  ;[[{ id: categoryId }]] = await pool.query('SELECT id FROM categories ORDER BY id LIMIT 1')
  ;[[{ id: priorityId }]] = await pool.query('SELECT id FROM priorities ORDER BY id LIMIT 1')
})

beforeEach(async () => {
  await resetData()
  people = {
    requester: await createUser({ role: 'employee', name: 'Era Employee' }),
    agentA: await createUser({ role: 'agent', name: 'Agon Agent' }),
    agentB: await createUser({ role: 'agent', name: 'Blerta Agent' }),
    admin: await createUser({ role: 'admin', name: 'Ada Admin' }),
    inactiveAgent: await createUser({ role: 'agent', name: 'Gone Agent', isActive: false }),
    hr: await createUser({ role: 'hr', name: 'Hana HR' }),
  }
  for (const person of Object.values(people)) {
    if (person.is_active) person.token = await loginAs(person)
  }
  await sentMail() // nothing so far, but make sure
  getMailer().outbox.length = 0
})

afterEach(async () => {
  jest.restoreAllMocks()
  process.env.IT_NOTIFY_EMAIL = ''
  process.env.SMTP_USER = ''
  process.env.SMTP_PASS = ''
  useEmail(false) // also resets the mailer
})

const post = (path, who, body) => api.post(path).set(auth(people[who].token)).send(body)
const patch = (path, who, body) => api.patch(path).set(auth(people[who].token)).send(body)

async function newTicket(who = 'requester', title = 'Printer not working') {
  const res = await post('/api/tickets', who, {
    title,
    description: 'The printer on floor 2 shows error E7.',
    category_id: categoryId,
    priority_id: priorityId,
  })
  expect(res.status).toBe(201)
  return res.body
}

// [to, subject] of every email sent since the last call, sorted, and the outbox emptied
async function takeMail() {
  const mail = await sentMail()
  getMailer().outbox.length = 0
  return mail
}
const recipientsOf = (mail) => mail.map((m) => m.to).sort()

describe('ticket created → IT', () => {
  test('goes to every active agent (not admins, not deactivated agents), with the ticket link', async () => {
    const ticket = await newTicket()
    const mail = await takeMail()
    expect(recipientsOf(mail)).toEqual([people.agentA.email, people.agentB.email].sort())
    for (const m of mail) {
      expect(m.subject).toBe(`[TicketFlow #${ticket.id}] New ticket: Printer not working`)
      expect(m.text).toContain(`Era Employee opened ticket #${ticket.id}: Printer not working`)
      expect(m.text).toContain(`http://localhost:5173/tickets/${ticket.id}`)
      expect(m.html).toContain(`href="http://localhost:5173/tickets/${ticket.id}"`)
      expect(m.text).toContain("You're receiving this because you're on the IT team that handles new tickets.")
    }
  })

  test('an agent opening a ticket is not told about it; the other agents are', async () => {
    await newTicket('agentA')
    expect(recipientsOf(await takeMail())).toEqual([people.agentB.email])
  })

  test('with IT_NOTIFY_EMAIL set, only that address gets it', async () => {
    process.env.IT_NOTIFY_EMAIL = 'it-desk@test.local'
    resetMailer()
    await newTicket()
    const mail = await takeMail()
    expect(recipientsOf(mail)).toEqual(['it-desk@test.local'])
    expect(mail[0].text).toMatch(/^Hello,\n/)
  })

  test('IT_NOTIFY_EMAIL is skipped when it is the creator’s own address', async () => {
    process.env.IT_NOTIFY_EMAIL = people.agentA.email.toUpperCase()
    resetMailer()
    await newTicket('agentA')
    expect(await takeMail()).toEqual([])
  })
})

describe('ticket assigned → the new assignee', () => {
  test('an admin assigning to an agent emails that agent only', async () => {
    const ticket = await newTicket()
    await takeMail()
    await patch(`/api/tickets/${ticket.id}/assign`, 'admin', { assigned_to: people.agentA.id }).expect(200)
    const mail = await takeMail()
    expect(recipientsOf(mail)).toEqual([people.agentA.email])
    expect(mail[0].subject).toBe(`[TicketFlow #${ticket.id}] Assigned to you: Printer not working`)
    expect(mail[0].text).toContain(`Ada Admin assigned ticket #${ticket.id} to you`)
  })

  test('reassigning emails only the new assignee', async () => {
    const ticket = await newTicket()
    await patch(`/api/tickets/${ticket.id}/assign`, 'admin', { assigned_to: people.agentA.id }).expect(200)
    await takeMail()
    await patch(`/api/tickets/${ticket.id}/assign`, 'admin', { assigned_to: people.agentB.id }).expect(200)
    expect(recipientsOf(await takeMail())).toEqual([people.agentB.email])
  })

  test('taking a ticket yourself, assigning the same person again, or unassigning sends nothing', async () => {
    const ticket = await newTicket()
    await takeMail()
    await patch(`/api/tickets/${ticket.id}/assign`, 'agentA', { assigned_to: people.agentA.id }).expect(200)
    await patch(`/api/tickets/${ticket.id}/assign`, 'admin', { assigned_to: people.agentA.id }).expect(200)
    await patch(`/api/tickets/${ticket.id}/assign`, 'admin', { assigned_to: null }).expect(200)
    expect(await takeMail()).toEqual([])
  })
})

describe('new comment → the other side', () => {
  test('the requester commenting on an assigned ticket emails the assignee only', async () => {
    const ticket = await newTicket()
    await patch(`/api/tickets/${ticket.id}/assign`, 'admin', { assigned_to: people.agentA.id }).expect(200)
    await takeMail()
    await post(`/api/tickets/${ticket.id}/comments`, 'requester', { content: 'Still broken.' }).expect(201)
    const mail = await takeMail()
    expect(recipientsOf(mail)).toEqual([people.agentA.email])
    expect(mail[0].subject).toBe(`[TicketFlow #${ticket.id}] New comment: Printer not working`)
    expect(mail[0].text).toContain(`Era Employee commented on ticket #${ticket.id}: Printer not working`)
    expect(mail[0].text).toContain('> Still broken.')
    expect(mail[0].text).toContain('because this ticket is assigned to you')
  })

  test('the requester commenting on an unassigned ticket emails IT', async () => {
    const ticket = await newTicket()
    await takeMail()
    await post(`/api/tickets/${ticket.id}/comments`, 'requester', { content: 'Any news?' }).expect(201)
    const mail = await takeMail()
    expect(recipientsOf(mail)).toEqual([people.agentA.email, people.agentB.email].sort())
    expect(mail[0].text).toContain('this ticket has no one assigned yet')
  })

  test('IT commenting emails the requester, never the author', async () => {
    const ticket = await newTicket()
    await patch(`/api/tickets/${ticket.id}/assign`, 'admin', { assigned_to: people.agentA.id }).expect(200)
    await takeMail()
    await post(`/api/tickets/${ticket.id}/comments`, 'agentA', { content: 'On my way.' }).expect(201)
    await post(`/api/tickets/${ticket.id}/comments`, 'admin', { content: 'Agon is on it.' }).expect(201)
    const mail = await takeMail()
    expect(recipientsOf(mail)).toEqual([people.requester.email, people.requester.email])
    expect(mail.map((m) => m.text).join('\n')).toContain('because you opened this ticket')
  })

  test('an internal note emails nobody (above all not the requester)', async () => {
    const ticket = await newTicket()
    await patch(`/api/tickets/${ticket.id}/assign`, 'admin', { assigned_to: people.agentA.id }).expect(200)
    await takeMail()
    await post(`/api/tickets/${ticket.id}/comments`, 'agentA', { content: 'Toner is fine', is_internal: true }).expect(
      201,
    )
    await post(`/api/tickets/${ticket.id}/comments`, 'admin', { content: 'Order a new one', is_internal: true }).expect(
      201,
    )
    expect(await takeMail()).toEqual([])
  })

  test('a deactivated requester gets nothing', async () => {
    const ticket = await newTicket()
    await takeMail()
    await pool.query('UPDATE users SET is_active = FALSE WHERE id = ?', [people.requester.id])
    await post(`/api/tickets/${ticket.id}/comments`, 'agentA', { content: 'Fixed?' }).expect(201)
    expect(await takeMail()).toEqual([])
  })

  test(`the comment is cut to ${EXCERPT_LENGTH} characters`, async () => {
    const ticket = await newTicket()
    await takeMail()
    const long = `${'word '.repeat(200)}END-OF-COMMENT`
    await post(`/api/tickets/${ticket.id}/comments`, 'agentA', { content: long }).expect(201)
    const [mail] = await takeMail()
    expect(mail.text).not.toContain('END-OF-COMMENT')
    const quoted = mail.text
      .split('\n')
      .filter((line) => line.startsWith('> '))
      .map((line) => line.slice(2))
      .join('\n')
    expect(quoted.length).toBeLessThanOrEqual(EXCERPT_LENGTH)
    expect(quoted.endsWith('…')).toBe(true)
  })
})

describe('ticket resolved → the requester', () => {
  test('emails the requester with the resolution', async () => {
    const ticket = await newTicket()
    await patch(`/api/tickets/${ticket.id}/assign`, 'admin', { assigned_to: people.agentA.id }).expect(200)
    await takeMail()
    await patch(`/api/tickets/${ticket.id}/status`, 'agentA', {
      status: 'resolved',
      resolution: 'Replaced the fuser.',
    }).expect(200)
    const mail = await takeMail()
    expect(recipientsOf(mail)).toEqual([people.requester.email])
    expect(mail[0].subject).toBe(`[TicketFlow #${ticket.id}] Resolved: Printer not working`)
    expect(mail[0].text).toContain(`Agon Agent resolved your ticket #${ticket.id}`)
    expect(mail[0].text).toContain('> Replaced the fuser.')
  })

  test('staff resolving their own ticket get nothing; other status changes send nothing', async () => {
    const own = await newTicket('admin')
    await takeMail()
    await patch(`/api/tickets/${own.id}/status`, 'admin', { status: 'resolved', resolution: 'Done' }).expect(200)
    const other = await newTicket()
    await takeMail()
    await patch(`/api/tickets/${other.id}/status`, 'agentA', { status: 'in_progress' }).expect(200)
    await patch(`/api/tickets/${other.id}/status`, 'agentA', { status: 'waiting_for_user' }).expect(200)
    expect(await takeMail()).toEqual([])
  })
})

describe('new user → set-password link (email set up)', () => {
  test('goes to the new user only, with a link built from APP_URL', async () => {
    process.env.APP_URL = 'https://desk.example.com/'
    useEmail(true)
    try {
      const res = await api
        .post('/api/users')
        .set(auth(people.hr.token))
        .set('Host', 'evil.example')
        .set('X-Forwarded-Host', 'evil.example')
        .send({ name: 'Nora New', email: 'nora@test.local' })
      expect(res.status).toBe(201)
      const mail = await takeMail()
      expect(recipientsOf(mail)).toEqual(['nora@test.local'])
      expect(mail[0].subject).toBe('Set up your TicketFlow account')
      expect(mail[0].link).toMatch(/^https:\/\/desk\.example\.com\/set-password\?token=[A-Za-z0-9_-]{43}$/)
      expect(mail[0].text).toContain('Hana HR created a TicketFlow account for you (nora@test.local).')
      expect(mail[0].text).toContain('expires in 48 hours')
      expect(`${mail[0].text}${mail[0].html}`).not.toContain('evil.example')
    } finally {
      process.env.APP_URL = 'http://localhost:5173'
    }
  })
})

describe('every email', () => {
  test('has a plain-text and an HTML version with the shared layout', async () => {
    await newTicket()
    for (const mail of await takeMail()) {
      expect(mail.text).toMatch(/You're receiving this because/)
      expect(mail.html).toMatch(/^<!doctype html>/)
      expect(mail.html).toContain('You&#39;re receiving this because')
      expect(mail.from).toBe('TicketFlow <no-reply@localhost>')
    }
  })

  test('escapes user content in the HTML, and keeps subjects on one line', async () => {
    const evilName = '<b onmouseover="x()">Eve</b>'
    await pool.query('UPDATE users SET name = ? WHERE id = ?', [evilName, people.requester.id])
    const ticket = await newTicket('requester', '<script>alert(1)</script>\r\nBcc: victim@test.local')
    await patch(`/api/tickets/${ticket.id}/assign`, 'admin', { assigned_to: people.agentA.id }).expect(200)
    await post(`/api/tickets/${ticket.id}/comments`, 'requester', {
      content: '<img src=x onerror="alert(2)"> & "quotes"',
    }).expect(201)

    const mail = await takeMail()
    expect(mail.length).toBeGreaterThanOrEqual(3)
    for (const m of mail) {
      expect(m.html).not.toMatch(/<script|<img|<b onmouseover/i)
      expect(m.subject).not.toMatch(/[\r\n]/)
      expect(m.subject).toContain('<script>alert(1)</script> Bcc: victim@test.local')
    }
    const html = mail.map((m) => m.html).join('\n')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(2)&quot;&gt; &amp; &quot;quotes&quot;')
    expect(html).toContain('&lt;b onmouseover=&quot;x()&quot;&gt;Eve&lt;/b&gt;')
    expect(recipientsOf(mail)).not.toContain('victim@test.local')
  })
})

describe('when the SMTP server fails', () => {
  function failingSmtp() {
    // Test mode with SMTP credentials set, so the redaction has a password to hide
    process.env.SMTP_USER = 'mailer'
    process.env.SMTP_PASS = 'smtp-pass-do-not-log'
    useEmail(true) // so a new account gets a link (and resets the mailer)
    getMailer().setTransport({
      sendMail: async () => {
        throw new Error('Invalid login: 535 for mailer/smtp-pass-do-not-log (http://x/set-password?token=abc123)')
      },
    })
    return captureLogs()
  }

  test('creating a ticket still succeeds, and the error is logged without secrets', async () => {
    const errors = failingSmtp()
    const ticket = await newTicket()
    expect(ticket.id).toEqual(expect.any(Number))
    const [[saved]] = await pool.query('SELECT id FROM tickets WHERE id = ?', [ticket.id])
    expect(saved).toBeDefined()

    await sentMail()
    const logged = errors.lines.map((line) => line.msg).join('\n')
    expect(logged).toContain(`Could not send "ticketCreated" to ${people.agentA.email}`)
    expect(logged).toContain('Invalid login: 535')
    expect(logged).not.toContain('smtp-pass-do-not-log')
    expect(logged).not.toContain('abc123')
    expect(logged).not.toContain('The printer on floor 2') // never the email body
  })

  test('creating a user still succeeds (201, account saved) and the link is not logged', async () => {
    const errors = failingSmtp()
    const res = await api
      .post('/api/users')
      .set(auth(people.admin.token))
      .send({ name: 'Una User', email: 'una@test.local', role: 'employee' })
    expect(res.status).toBe(201)
    const [[row]] = await pool.query('SELECT id FROM users WHERE email = ?', ['una@test.local'])
    expect(row).toBeDefined()

    await sentMail()
    const logged = errors.lines.map((line) => line.msg).join('\n')
    expect(logged).toContain('Could not send "accountSetup" to una@test.local')
    expect(logged).not.toMatch(/set-password\?token=[A-Za-z0-9_-]{20,}/)
    expect(logged).not.toContain('smtp-pass-do-not-log')
  })

  test('the response does not wait for the email', async () => {
    let open
    const gate = new Promise((resolve) => (open = resolve))
    let attempts = 0
    getMailer().setTransport({
      sendMail: () => {
        attempts += 1
        return gate // stays pending until the test opens it
      },
    })
    const ticket = await newTicket() // would hang (and time out) here if the route awaited the email
    expect(ticket.id).toEqual(expect.any(Number))
    // Let the stuck emails finish so the test can end
    open({})
    await sentMail()
    expect(attempts).toBe(2)
  })
})
