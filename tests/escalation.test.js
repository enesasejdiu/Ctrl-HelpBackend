// The escalation job (src/jobs/escalation.js): urgent tickets left unassigned and tickets that became overdue are
// reported to the active admins, once per ticket and kind, in one summary email per admin. Email goes through a real
// SMTP server inside the test (tests/support/fakeSmtp.js); the job's clock is injected (`now`), so nothing sleeps.
const pool = require('../src/db')
const { runEscalation } = require('../src/jobs/escalation')
const { startEscalationSchedule, escalationIntervalMinutes } = require('../src/jobs/schedule')
const { loadConfig } = require('../src/config')
const { api, resetData, createUser, loginAs, auth, dbSnapshot } = require('./helpers')
const { startFakeSmtp } = require('./support/fakeSmtp')

const NOW = new Date(Math.floor(Date.now() / 1000) * 1000)
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const quiet = { log: () => {}, warn: jest.fn(), error: jest.fn() }
const run = (options = {}) => runEscalation({ now: () => NOW, log: quiet, ...options })

let smtp
let requester
let admin
let agent
let level // { Low, Medium, High, Critical } → priority id, from the seed

beforeAll(async () => {
  smtp = await startFakeSmtp()
  const [rows] = await pool.query('SELECT id, name FROM priorities')
  level = Object.fromEntries(rows.map((row) => [row.name, row.id]))
})
afterAll(async () => {
  smtp.stopUsingForApp()
  await smtp.stop()
})
beforeEach(async () => {
  await resetData()
  smtp.clearMails()
  smtp.useForApp()
  quiet.warn.mockClear()
  requester = await createUser({ name: 'Liridon Gashi' })
  admin = await createUser({ role: 'admin', name: 'Ana Admin', email: 'ana.admin@test.local' })
  agent = await createUser({ role: 'agent' })
})

// A ticket created `ago` ms before NOW, straight into the database
async function ticket({
  priority = 'High',
  ago = 121 * MINUTE,
  assignee = null,
  status,
  title = 'Printer jammed',
} = {}) {
  const [result] = await pool.query(
    `INSERT INTO tickets (title, description, requester_id, assigned_to, category_id, priority_id, status, created_at)
     VALUES (?, 'Something broke.', ?, ?, 1, ?, ?, ?)`,
    [title, requester.id, assignee, level[priority], status ?? (assignee ? 'assigned' : 'open'), new Date(NOW - ago)],
  )
  return result.insertId
}
const escalations = async () =>
  (await pool.query('SELECT ticket_id, kind FROM ticket_escalations ORDER BY ticket_id, kind'))[0].map(
    (row) => `${row.ticket_id}:${row.kind}`,
  )

describe('unassigned urgent tickets', () => {
  test('High unassigned for 121 minutes → escalated; 119 minutes → not', async () => {
    const late = await ticket({ ago: 121 * MINUTE })
    const early = await ticket({ ago: 119 * MINUTE })
    const summary = await run()
    expect(summary).toMatchObject({ unassigned: 1, overdue: 0, ids: { unassigned: [late], overdue: [] }, emailed: 1 })
    expect(await escalations()).toEqual([`${late}:unassigned`])
    expect(early).not.toBe(late)
  })

  test('exactly at the threshold (120 minutes) counts', async () => {
    const id = await ticket({ ago: 120 * MINUTE })
    expect((await run()).ids.unassigned).toEqual([id])
  })

  test("Critical counts too; Medium and Low never do; an assigned High ticket doesn't", async () => {
    const critical = await ticket({ priority: 'Critical', ago: 3 * HOUR })
    await ticket({ priority: 'Medium', ago: 3 * HOUR })
    await ticket({ priority: 'Low', ago: 3 * HOUR })
    await ticket({ priority: 'High', ago: 3 * HOUR, assignee: agent.id })
    expect((await run()).ids.unassigned).toEqual([critical])
  })

  test('the threshold comes from the setting (escalation_unassigned_minutes)', async () => {
    await pool.query("UPDATE settings SET setting_value = '30' WHERE setting_key = 'escalation_unassigned_minutes'")
    const id = await ticket({ ago: 31 * MINUTE })
    await ticket({ ago: 29 * MINUTE })
    expect((await run()).ids.unassigned).toEqual([id])
  })
})

describe('overdue tickets', () => {
  test('an overdue ticket is escalated once; the next run does not send it again', async () => {
    // Medium: 72 target hours (seed); 73 hours old, assigned (so only "overdue" applies)
    const id = await ticket({ priority: 'Medium', ago: 73 * HOUR, assignee: agent.id })
    await ticket({ priority: 'Medium', ago: 71 * HOUR, assignee: agent.id })
    expect((await run()).ids).toEqual({ unassigned: [], overdue: [id] })
    expect((await smtp.getMails()).length).toBe(1)

    const second = await run()
    expect(second).toMatchObject({ unassigned: 0, overdue: 0, emailed: 0 })
    expect((await smtp.getMails()).length).toBe(1)
    expect(await escalations()).toEqual([`${id}:overdue`])
  })

  test('an urgent unassigned ticket that is also overdue is reported for both, once each', async () => {
    const id = await ticket({ priority: 'Critical', ago: 5 * HOUR }) // Critical target: 4 hours
    expect((await run()).ids).toEqual({ unassigned: [id], overdue: [id] })
    expect(await escalations()).toEqual([`${id}:overdue`, `${id}:unassigned`])
    expect((await run()).ids).toEqual({ unassigned: [], overdue: [] })
  })

  test('resolved and closed tickets are never escalated', async () => {
    for (const status of ['resolved', 'closed']) {
      await ticket({ priority: 'Critical', ago: 30 * 24 * HOUR, status })
    }
    const before = await dbSnapshot()
    expect(await run()).toMatchObject({ unassigned: 0, overdue: 0, emailed: 0 })
    expect(await dbSnapshot()).toEqual(before)
    expect(await smtp.getMails()).toEqual([])
  })

  test('other unfinished statuses (waiting for the user, reopened) do count', async () => {
    const waiting = await ticket({ priority: 'Low', ago: 200 * HOUR, assignee: agent.id, status: 'waiting_for_user' })
    const reopened = await ticket({ priority: 'Low', ago: 200 * HOUR, assignee: agent.id, status: 'reopened' })
    expect((await run()).ids.overdue).toEqual([waiting, reopened])
  })
})

describe('the email', () => {
  test('one email per active admin with every ticket in it; deactivated admins and other roles get nothing', async () => {
    const second = await createUser({ role: 'admin', name: 'Besa Admin', email: 'besa.admin@test.local' })
    await createUser({ role: 'admin', isActive: false, email: 'gone.admin@test.local' })
    const a = await ticket({ priority: 'Critical', ago: 150 * MINUTE, title: 'VPN down for sales' })
    const b = await ticket({ priority: 'High', ago: 130 * MINUTE, title: 'Laptop will not boot' })
    const c = await ticket({ priority: 'Medium', ago: 98 * HOUR, assignee: agent.id, title: 'New monitor <b>now</b>' })

    expect((await run()).emailed).toBe(2)
    const mails = await smtp.getMails()
    expect(mails.map((mail) => mail.envelope.to).sort()).toEqual([[admin.email], [second.email]])

    const mail = mails.find((m) => m.envelope.to.includes(admin.email))
    expect(mail.subject).toBe('[TicketFlow] Needs attention: 2 urgent tickets unassigned, 1 ticket overdue')
    expect(mail.text).toContain('Hello Ana Admin,')
    expect(mail.text).toContain('Urgent and still unassigned (more than 120 minutes):')
    expect(mail.text).toContain(`#${a} VPN down for sales · Critical · 2 h 30 min old · requested by Liridon Gashi`)
    expect(mail.text).toContain(`#${b} Laptop will not boot · High · 2 h 10 min old · requested by Liridon Gashi`)
    expect(mail.text).toContain('Overdue (older than their priority allows):')
    expect(mail.text).toContain(`#${c} New monitor <b>now</b> · Medium · 4 days 2 h old`)
    for (const id of [a, b, c]) expect(mail.text).toContain(`${process.env.APP_URL}/tickets/${id}`)
    // The HTML version escapes ticket titles
    expect(mail.html).toContain('New monitor &lt;b&gt;now&lt;/b&gt;')
    expect(mail.html).not.toContain('<b>now</b>')
  })

  test('nothing new → no email at all', async () => {
    await ticket({ priority: 'Low', ago: 1 * HOUR })
    expect(await run()).toMatchObject({ unassigned: 0, overdue: 0, emailed: 0 })
    expect(await smtp.getMails()).toEqual([])
  })

  test('an audit entry ticket_escalated per ticket and kind, by the system', async () => {
    const id = await ticket({ priority: 'Critical', ago: 5 * HOUR })
    await run()
    const [rows] = await pool.query(
      "SELECT actor_id, ticket_id, details FROM audit_log WHERE action = 'ticket_escalated' ORDER BY id",
    )
    const details = rows.map((row) => (typeof row.details === 'string' ? JSON.parse(row.details) : row.details))
    expect(rows.map((row) => [row.actor_id, row.ticket_id])).toEqual([
      [null, id],
      [null, id],
    ])
    expect(details.map((d) => d.kind).sort()).toEqual(['overdue', 'unassigned'])
  })
})

describe('switched off, email off, two runs at once', () => {
  test('escalation turned off in Settings → nothing sent, nothing recorded', async () => {
    const session = await loginAs(admin)
    const off = await api.patch('/api/settings').set(auth(session)).send({ escalation_enabled: false })
    expect(off.status).toBe(200)
    expect(off.body).toMatchObject({ escalation_enabled: false, escalation_unassigned_minutes: 120 })
    await ticket({ priority: 'Critical', ago: 5 * HOUR })

    expect(await run()).toMatchObject({ skipped: 'disabled', unassigned: 0, overdue: 0, emailed: 0 })
    expect(await escalations()).toEqual([])
    expect(await smtp.getMails()).toEqual([])
  })

  test('email not set up → a warning line with the counts, and the escalations are still recorded', async () => {
    smtp.stopUsingForApp()
    const id = await ticket({ priority: 'Critical', ago: 5 * HOUR })
    expect(await run()).toMatchObject({ unassigned: 1, overdue: 1, emailed: 0 })
    expect(quiet.warn).toHaveBeenCalledWith(
      '[escalation] Email is not set up, so nobody was emailed: 1 urgent ticket unassigned, 1 ticket overdue (recorded)',
    )
    expect(await escalations()).toEqual([`${id}:overdue`, `${id}:unassigned`])
    expect(await smtp.getMails()).toEqual([])
  })

  test('two runs at once: only the one holding the lock sends', async () => {
    await ticket({ priority: 'Critical', ago: 5 * HOUR })
    let second
    const first = await run({
      hooks: {
        // While the first run holds the lock, a second one starts and finishes
        afterLock: async () => {
          second = await run()
        },
      },
    })
    expect(second).toMatchObject({ skipped: 'locked', unassigned: 0, overdue: 0, emailed: 0 })
    expect(first).toMatchObject({ skipped: null, unassigned: 1, overdue: 1, emailed: 1 })
    expect((await smtp.getMails()).length).toBe(1)
  })

  test('two runs side by side, without the hook: the ticket is still reported once', async () => {
    await ticket({ priority: 'Critical', ago: 5 * HOUR })
    const results = await Promise.all([run(), run()])
    expect(results.reduce((sum, r) => sum + r.unassigned + r.overdue, 0)).toBe(2)
    expect((await smtp.getMails()).length).toBe(1)
  })
})

describe('settings API', () => {
  test('GET shows the escalation settings; PATCH validates them', async () => {
    const session = await loginAs(admin)
    const get = await api.get('/api/settings').set(auth(session))
    expect(get.body).toMatchObject({ escalation_enabled: true, escalation_unassigned_minutes: 120 })

    const ok = await api.patch('/api/settings').set(auth(session)).send({ escalation_unassigned_minutes: 15 })
    expect(ok.body.escalation_unassigned_minutes).toBe(15)
    for (const bad of [14, 1441, 30.5, '60']) {
      const res = await api.patch('/api/settings').set(auth(session)).send({ escalation_unassigned_minutes: bad })
      expect(res.status).toBe(400)
      expect(res.body.message).toMatch(
        /escalation_unassigned_minutes must be a whole number of minutes from 15 to 1440/,
      )
    }
    const notBool = await api.patch('/api/settings').set(auth(session)).send({ escalation_enabled: 'no' })
    expect(notBool.status).toBe(400)
  })

  test('only admins may change them', async () => {
    const session = await loginAs(agent)
    const res = await api.patch('/api/settings').set(auth(session)).send({ escalation_enabled: false })
    expect(res.status).toBe(403)
  })
})

describe('schedule and config', () => {
  test('every 5 minutes by default; ESCALATION_INTERVAL_MINUTES and ESCALATION_ENABLED only count in tests', () => {
    expect(escalationIntervalMinutes({ NODE_ENV: 'production', ESCALATION_INTERVAL_MINUTES: '1' })).toBe(5)
    expect(escalationIntervalMinutes({ NODE_ENV: 'test', ESCALATION_INTERVAL_MINUTES: '1' })).toBe(1)
    const log = { log: jest.fn(), error: jest.fn() }
    expect(startEscalationSchedule({ log, env: { NODE_ENV: 'test', ESCALATION_ENABLED: 'false' } })).toBeNull()
    const job = startEscalationSchedule({ log, env: { NODE_ENV: 'test' } })
    try {
      const next = job.nextRun()
      expect(next.getMinutes() % 5).toBe(0)
      expect(next.getTime() - Date.now()).toBeLessThanOrEqual(5 * MINUTE)
    } finally {
      job.stop()
    }
  })

  test('the config check refuses the test-only settings elsewhere', () => {
    const base = {
      DB_HOST: 'localhost',
      DB_PORT: '3306',
      DB_USER: 'u',
      DB_PASSWORD: '',
      DB_NAME: 'd',
      PORT: '5050',
      CLIENT_URL: 'http://localhost:5173',
      JWT_SECRET: 'x'.repeat(40),
      NODE_ENV: 'development',
    }
    expect(() => loadConfig({ ...base, ESCALATION_ENABLED: 'false' })).toThrow(/ESCALATION_ENABLED can only be changed/)
    expect(() => loadConfig({ ...base, ESCALATION_INTERVAL_MINUTES: '1' })).toThrow(
      /ESCALATION_INTERVAL_MINUTES can only be changed/,
    )
    expect(() => loadConfig({ ...base, ESCALATION_INTERVAL_MINUTES: '0' })).toThrow(/from 1 to 60/)
    expect(() => loadConfig({ ...base, ESCALATION_ENABLED: 'maybe' })).toThrow(/must be true or false/)
    expect(() => loadConfig({ ...base, ESCALATION_ENABLED: 'true', ESCALATION_INTERVAL_MINUTES: '5' })).not.toThrow()
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'test', ESCALATION_ENABLED: 'false', ESCALATION_INTERVAL_MINUTES: '1' }),
    ).not.toThrow()
  })
})

describe('when something goes wrong', () => {
  test('recording fails halfway → nothing is recorded or sent, the error reaches the caller, the lock is free again', async () => {
    const id = await ticket({ priority: 'Critical', ago: 5 * HOUR })
    await expect(
      run({
        hooks: {
          beforeRecord: async () => {
            throw new Error('database went away')
          },
        },
      }),
    ).rejects.toThrow('database went away')
    expect(await escalations()).toEqual([])
    expect(await smtp.getMails()).toEqual([])
    // The next run takes the lock and reports the ticket
    expect((await run()).ids).toEqual({ unassigned: [id], overdue: [id] })
  })

  test('the SMTP server refuses the email → the escalation stays recorded (not retried by the next run)', async () => {
    smtp.setMode('5xx')
    const errors = { log: () => {}, warn: jest.fn(), error: jest.fn() }
    try {
      await ticket({ priority: 'Critical', ago: 5 * HOUR })
      const summary = await runEscalation({ now: () => NOW, log: errors })
      expect(summary).toMatchObject({ unassigned: 1, overdue: 1, emailed: 0 })
      expect((await escalations()).length).toBe(2)
    } finally {
      smtp.setMode('accept')
    }
  })

  test('no active admin → a warning with the counts; the escalations are recorded', async () => {
    await pool.query("UPDATE users SET is_active = FALSE WHERE role = 'admin'")
    await ticket({ priority: 'High', ago: 3 * HOUR })
    expect(await run()).toMatchObject({ unassigned: 1, emailed: 0 })
    expect(quiet.warn).toHaveBeenCalledWith(
      '[escalation] No active admin to email: 1 urgent ticket unassigned (recorded)',
    )
  })

  test('unreadable stored settings fall back to the defaults (on, 120 minutes)', async () => {
    await pool.query("UPDATE settings SET setting_value = 'yes' WHERE setting_key = 'escalation_enabled'")
    await pool.query("UPDATE settings SET setting_value = 'soon' WHERE setting_key = 'escalation_unassigned_minutes'")
    const id = await ticket({ ago: 121 * MINUTE })
    await ticket({ ago: 119 * MINUTE })
    expect((await run()).ids.unassigned).toEqual([id])
  })

  test('without an injected clock it uses the real time', async () => {
    const id = await ticket({ priority: 'High', ago: Date.now() - NOW.getTime() + 3 * HOUR })
    expect((await runEscalation({ log: quiet })).ids.unassigned).toEqual([id])
  })

  test('the scheduled job runs the job, and logs (never throws) when it fails', async () => {
    const log = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const job = startEscalationSchedule({ log, env: { NODE_ENV: 'test', ESCALATION_INTERVAL_MINUTES: '1' } })
    try {
      await ticket({ priority: 'Critical', ago: 5 * HOUR })
      await job.trigger()
      expect(await escalations()).toHaveLength(2)

      const failing = jest.spyOn(pool, 'getConnection').mockRejectedValueOnce(new Error('pool closed'))
      await job.trigger()
      failing.mockRestore()
      expect(log.error).toHaveBeenCalledWith('[escalation] The job failed: pool closed', expect.any(Error))
    } finally {
      job.stop()
    }
  })
})
