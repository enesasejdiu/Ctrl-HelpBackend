// The daily auto-close job (src/jobs/autoClose.js), its schedule (src/jobs/schedule.js), the auto_close_days setting
// and the manual run (scripts/auto-close.js). The job's clock is injected (`now`), so times are exact.
const { spawnSync } = require('child_process')
const path = require('path')
const pool = require('../src/db')
const { runAutoClose } = require('../src/jobs/autoClose')
const { nextAutoCloseRun } = require('../src/jobs/schedule')
const { api, resetData, createUser, loginAs, auth, dbSnapshot, expectError, sentMail, useEmail } = require('./helpers')

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
// "Now" for the job: a whole second, like the TIMESTAMP columns
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000)
const quiet = { log: jest.fn(), error: jest.fn() }
const run = (options = {}) => runAutoClose({ now: () => NOW, log: quiet, ...options })

let requester
let admin

beforeEach(async () => {
  await resetData()
  quiet.log.mockClear()
  quiet.error.mockClear()
  requester = await createUser({ role: 'employee' })
  admin = await createUser({ role: 'admin' })
  admin.token = await loginAs(admin)
})

// Inserts a ticket straight into the database; resolvedAt is how long ago (ms) it was resolved
async function ticket({ status = 'resolved', resolvedAgo = null, title = 'A ticket' } = {}) {
  const resolvedAt = resolvedAgo === null ? null : new Date(NOW.getTime() - resolvedAgo)
  const [result] = await pool.query(
    `INSERT INTO tickets (title, description, requester_id, category_id, priority_id, status, resolution, resolved_at)
     VALUES (?, 'Something broke.', ?, 1, 1, ?, 'Fixed it.', ?)`,
    [title, requester.id, status, resolvedAt],
  )
  return result.insertId
}
const statusOf = async (id) => (await pool.query('SELECT status FROM tickets WHERE id = ?', [id]))[0][0].status
const row = async (id) => (await pool.query('SELECT * FROM tickets WHERE id = ?', [id]))[0][0]

describe('which tickets are closed', () => {
  test('resolved exactly 7 days ago → closed; 6 days 23 hours ago → not', async () => {
    const due = await ticket({ resolvedAgo: 7 * DAY })
    const almost = await ticket({ resolvedAgo: 7 * DAY - HOUR })
    const summary = await run()
    expect(summary).toMatchObject({ checked: 1, closed: 1, failed: 0, ids: [due], days: 7 })
    expect(await statusOf(due)).toBe('closed')
    expect(await statusOf(almost)).toBe('resolved')
  })

  test('other statuses are never touched, even with an old resolved_at', async () => {
    const others = []
    for (const status of ['open', 'assigned', 'in_progress', 'waiting_for_user', 'reopened', 'closed']) {
      others.push([status, await ticket({ status, resolvedAgo: 30 * DAY })])
    }
    const before = await dbSnapshot()
    expect((await run()).closed).toBe(0)
    expect(await dbSnapshot()).toEqual(before)
    for (const [status, id] of others) expect(await statusOf(id)).toBe(status)
  })

  test('a resolved ticket without resolved_at is left alone', async () => {
    const id = await ticket({ resolvedAgo: null })
    expect((await run()).closed).toBe(0)
    expect(await statusOf(id)).toBe('resolved')
  })

  test('auto_close_days 0 switches it off; a custom value (3) is respected', async () => {
    const fourDays = await ticket({ resolvedAgo: 4 * DAY })
    await api.patch('/api/settings').set(auth(admin.token)).send({ auto_close_days: 0 }).expect(200)
    expect(await run()).toMatchObject({ skipped: 'disabled', closed: 0 })
    expect(await statusOf(fourDays)).toBe('resolved')

    await api.patch('/api/settings').set(auth(admin.token)).send({ auto_close_days: 3 }).expect(200)
    expect(await run()).toMatchObject({ closed: 1, days: 3 })
    expect(await statusOf(fourDays)).toBe('closed')
  })

  test('idempotent: a second run closes nothing', async () => {
    await ticket({ resolvedAgo: 8 * DAY })
    expect((await run()).closed).toBe(1)
    expect(await run()).toMatchObject({ checked: 0, closed: 0 })
  })

  test('more than one batch: every due ticket is closed', async () => {
    const ids = []
    for (let i = 0; i < 5; i += 1) ids.push(await ticket({ resolvedAgo: 8 * DAY }))
    const summary = await run({ batchSize: 2 })
    expect(summary).toMatchObject({ checked: 5, closed: 5, failed: 0 })
    expect(summary.ids).toEqual(ids)
  })
})

describe('reopening', () => {
  const setStatus = (id, token, body) => api.patch(`/api/tickets/${id}/status`).set(auth(token)).send(body)

  test('reopening clears resolved_at, so it is not closed; resolving again counts the 7 days from then', async () => {
    const agent = await createUser({ role: 'agent' })
    const agentToken = await loginAs(agent)
    const requesterToken = await loginAs(requester)
    const id = await ticket({ status: 'in_progress' })
    await setStatus(id, agentToken, { status: 'resolved', resolution: 'Fixed' }).expect(200)
    // As if that resolve were 10 days ago
    await pool.query('UPDATE tickets SET resolved_at = ? WHERE id = ?', [new Date(Date.now() - 10 * DAY), id])

    await setStatus(id, requesterToken, { status: 'reopened' }).expect(200)
    expect((await row(id)).resolved_at).toBeNull()
    expect((await runAutoClose({ log: quiet })).closed).toBe(0)

    await setStatus(id, agentToken, { status: 'resolved', resolution: 'Fixed again' }).expect(200)
    const resolvedAt = (await row(id)).resolved_at
    expect(Date.now() - resolvedAt.getTime()).toBeLessThan(60 * 1000) // just now
    // 6 days later: still open for a reply; 7 days later: closed
    const later = (ms) => () => new Date(Math.floor((resolvedAt.getTime() + ms) / 1000) * 1000)
    expect((await runAutoClose({ now: later(6 * DAY), log: quiet })).closed).toBe(0)
    expect((await runAutoClose({ now: later(7 * DAY), log: quiet })).closed).toBe(1)
  })

  test('a ticket reopened between being picked and the update is not closed', async () => {
    const reopened = await ticket({ resolvedAgo: 8 * DAY })
    const other = await ticket({ resolvedAgo: 8 * DAY })
    const summary = await run({
      hooks: {
        // Someone reopens it while the batch is being closed (another connection, as a request would)
        beforeUpdate: () =>
          pool.query("UPDATE tickets SET status = 'reopened', resolved_at = NULL WHERE id = ?", [reopened]),
      },
    })
    expect(summary).toMatchObject({ checked: 2, closed: 1, ids: [other] })
    expect(await statusOf(reopened)).toBe('reopened')
    // No history or audit entry for the one it didn't close
    const [history] = await pool.query('SELECT ticket_id FROM ticket_history WHERE changed_by IS NULL')
    expect(history).toEqual([{ ticket_id: other }])
  })
})

describe('what a closed ticket gets', () => {
  test('closed_at, a history row by the system, an audit entry; and no email', async () => {
    useEmail(true) // so an email would really be sent, if the job tried
    const id = await ticket({ resolvedAgo: 8 * DAY })
    const before = await row(id)
    await run()

    const after = await row(id)
    expect(after).toMatchObject({ status: 'closed', resolved_at: before.resolved_at })
    expect(after.closed_at.getTime()).toBe(NOW.getTime())

    const [history] = await pool.query('SELECT changed_by, field_changed, old_value, new_value FROM ticket_history')
    expect(history).toEqual([{ changed_by: null, field_changed: 'status', old_value: 'resolved', new_value: 'closed' }])
    // (the admin's login from beforeEach is in the log too)
    const [audit] = await pool.query(
      "SELECT actor_id, ticket_id, details FROM audit_log WHERE action = 'ticket_auto_closed'",
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor_id: null, ticket_id: id })
    // MySQL returns the JSON column parsed, MariaDB as text
    const details = typeof audit[0].details === 'string' ? JSON.parse(audit[0].details) : audit[0].details
    expect(details).toEqual({ days: 7 })
    expect(await sentMail()).toEqual([])
  })

  test('the ticket page shows the change as made by "System"', async () => {
    const id = await ticket({ resolvedAgo: 8 * DAY })
    await run()
    const res = await api.get(`/api/tickets/${id}`).set(auth(admin.token))
    expect(res.body.history).toEqual([
      expect.objectContaining({
        changed_by: null,
        changed_by_name: 'System',
        old_value: 'resolved',
        new_value: 'closed',
      }),
    ])
  })
})

describe('running safely', () => {
  test('only one run at a time: while the lock is taken, a run skips and logs it', async () => {
    const id = await ticket({ resolvedAgo: 8 * DAY })
    // Another process holds the job's lock (the same name the job uses: per database)
    const other = await pool.getConnection()
    const [[{ name }]] = await other.query('SELECT DATABASE() AS name')
    const lock = `ticketflow_auto_close:${name}`.slice(0, 64)
    try {
      await other.query('SELECT GET_LOCK(?, 0)', [lock])
      expect(await run()).toMatchObject({ skipped: 'locked', closed: 0 })
      expect(quiet.log).toHaveBeenCalledWith('[auto-close] Another run is in progress (lock taken); skipped')
      expect(await statusOf(id)).toBe('resolved')
    } finally {
      await other.query('SELECT RELEASE_LOCK(?)', [lock])
      other.release()
    }
    expect((await run()).closed).toBe(1) // and the lock is free again afterwards
  })

  test('two runs at the same moment: one closes, the other skips', async () => {
    await ticket({ resolvedAgo: 8 * DAY })
    const results = await Promise.all([run(), run()])
    expect(results.map((r) => r.closed).sort()).toEqual([0, 1])
    expect(results.filter((r) => r.skipped === 'locked')).toHaveLength(results.filter((r) => r.closed === 0).length)
  })

  test('a failing batch is logged, and the other batches still run', async () => {
    const ids = []
    for (let i = 0; i < 6; i += 1) ids.push(await ticket({ resolvedAgo: 8 * DAY }))
    let calls = 0
    const summary = await run({
      batchSize: 2,
      hooks: {
        beforeUpdate: () => {
          calls += 1
          if (calls === 2) throw new Error('deadlock found')
        },
      },
    })
    expect(summary).toMatchObject({ checked: 6, closed: 4, failed: 2 })
    expect(summary.ids).toEqual([ids[0], ids[1], ids[4], ids[5]])
    expect(quiet.error).toHaveBeenCalledWith(
      `[auto-close] A batch of 2 tickets (ids ${ids[2]}–${ids[3]}) failed: deadlock found`,
    )
    // The failed batch changed nothing (rolled back)
    expect(await statusOf(ids[2])).toBe('resolved')
    expect(quiet.log.mock.calls.at(-1)[0]).toMatch(/^\[auto-close\] Done: checked 6, closed 4, failed 2, \d+ ms/)
  })
})

describe('--dry-run', () => {
  test('changes nothing and lists the right ids', async () => {
    const due = [await ticket({ resolvedAgo: 8 * DAY }), await ticket({ resolvedAgo: 7 * DAY })]
    await ticket({ resolvedAgo: 6 * DAY })
    await ticket({ status: 'open' })
    const before = await dbSnapshot()
    const summary = await run({ dryRun: true })
    expect(summary).toMatchObject({ checked: 2, closed: 0, ids: due })
    expect(await dbSnapshot()).toEqual(before)
    expect(quiet.log).toHaveBeenCalledWith(
      `[auto-close] Dry run: 2 tickets resolved for 7+ days would be closed: ${due.join(', ')}`,
    )
  })

  test('npm run job:auto-close -- --dry-run prints them and changes nothing', async () => {
    const due = await ticket({ resolvedAgo: 30 * DAY })
    const before = await dbSnapshot()
    const res = spawnSync(process.execPath, ['scripts/auto-close.js', '--dry-run'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
      encoding: 'utf8',
      timeout: 30000,
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain(`Dry run: 1 tickets resolved for 7+ days would be closed: ${due}`)
    expect(await dbSnapshot()).toEqual(before)
  })
})

describe('the auto_close_days setting', () => {
  test('GET /api/settings shows it (default 7); PATCH changes it; 0–365 whole days only', async () => {
    expect((await api.get('/api/settings').set(auth(admin.token))).body).toMatchObject({ auto_close_days: 7 })
    const res = await api.patch('/api/settings').set(auth(admin.token)).send({ auto_close_days: 14 })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ auto_close_days: 14 })
    for (const bad of [-1, 366, 1.5, '7', null]) {
      const refused = await api.patch('/api/settings').set(auth(admin.token)).send({ auto_close_days: bad })
      expectError(refused, 400, undefined)
    }
    await api.patch('/api/settings').set(auth(admin.token)).send({ auto_close_days: 0 }).expect(200)
    await api.patch('/api/settings').set(auth(admin.token)).send({ auto_close_days: 365 }).expect(200)
    // The public settings don't show it
    expect((await api.get('/api/settings/public')).body).not.toHaveProperty('auto_close_days')
  })

  test('only admins may change it', async () => {
    const hrToken = await loginAs(await createUser({ role: 'hr' }))
    expect((await api.patch('/api/settings').set(auth(hrToken)).send({ auto_close_days: 1 })).status).toBe(403)
  })
})

describe('the schedule: 03:00 Europe/Budapest every day', () => {
  test('in winter (CET) that is 02:00 UTC, in summer (CEST) 01:00 UTC', () => {
    expect(nextAutoCloseRun(new Date('2027-01-15T12:00:00Z')).toISOString()).toBe('2027-01-16T02:00:00.000Z')
    expect(nextAutoCloseRun(new Date('2026-07-01T12:00:00Z')).toISOString()).toBe('2026-07-02T01:00:00.000Z')
  })

  test.each([
    [
      'the autumn change (25 Oct 2026)',
      '2026-10-24T12:00:00Z',
      ['2026-10-25T02:00:00.000Z', '2026-10-26T02:00:00.000Z'],
    ],
    [
      'the spring change (28 Mar 2027)',
      '2027-03-27T12:00:00Z',
      ['2027-03-28T01:00:00.000Z', '2027-03-29T01:00:00.000Z'],
    ],
  ])('across %s it still runs once a day at 03:00 local time', (_, from, expected) => {
    const first = nextAutoCloseRun(new Date(from))
    const second = nextAutoCloseRun(first)
    expect([first.toISOString(), second.toISOString()]).toEqual(expected)
    // Exactly one run on the day of the change
    const sameDay = nextAutoCloseRun(new Date(first.getTime() - 60 * 1000))
    expect(sameDay.toISOString()).toBe(first.toISOString())
  })

  test('AUTO_CLOSE_TIMEZONE and AUTO_CLOSE_CRON change it', () => {
    process.env.AUTO_CLOSE_TIMEZONE = 'UTC'
    process.env.AUTO_CLOSE_CRON = '30 4 * * *'
    try {
      expect(nextAutoCloseRun(new Date('2026-07-01T12:00:00Z')).toISOString()).toBe('2026-07-02T04:30:00.000Z')
    } finally {
      delete process.env.AUTO_CLOSE_TIMEZONE
      delete process.env.AUTO_CLOSE_CRON
    }
  })
})
