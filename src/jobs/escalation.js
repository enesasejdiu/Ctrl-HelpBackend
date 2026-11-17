// escalation.js – tells the admins about tickets that need attention (README "Escalation"). Runs every 5 minutes
// (src/jobs/schedule.js), like the auto-close job but more often.
//
// Two kinds, each at most once per ticket (ticket_escalations, migration 019, UNIQUE (ticket_id, kind)):
//   unassigned  an urgent ticket (the two most urgent priority ranks: High and Critical by default) that nobody has
//               been assigned to escalation_unassigned_minutes (a setting, default 120) after it was created
//   overdue     a ticket that is overdue by the app's one overdue rule (src/overdue.js): unfinished and older than its
//               priority's target hours
// Resolved and closed tickets are never escalated (both rules leave them out).
//
// - One run at a time across every API instance: a database lock (GET_LOCK, per database, like auto-close). If another
//   instance holds it, this run logs that and does nothing.
// - What's new is recorded first, in one transaction: a ticket_escalations row (INSERT IGNORE: if another run recorded
//   it meanwhile, it isn't this run's) and an audit entry ticket_escalated per ticket. Only then are emails sent, so a
//   failed or slow email never makes a ticket be reported twice.
// - Then ONE summary email per active admin with everything new in this run ("2 urgent tickets unassigned, 1 ticket
//   overdue", each with title, priority, age, requester and a link). Without email set up, one warning line with the
//   counts instead; the escalations are still recorded.
// - escalation_enabled = false (Settings): the job does nothing.
// - It never throws for a ticket's sake; the scheduler also catches anything unexpected, so the API never crashes
//   because of it. The end: a summary line.
const pool = require('../db')
const settings = require('../settings')
const { recordAudit } = require('../audit')
const { overdueSqlAt } = require('../overdue')
const { getMailer, isEmailConfigured, sendMailSafe } = require('../mail/mailer')
const templates = require('../mail/templates')

const KINDS = ['unassigned', 'overdue']

async function lockName(conn) {
  const [[{ name }]] = await conn.query('SELECT DATABASE() AS name')
  return `ticketflow_escalation:${name}`.slice(0, 64)
}

const TICKET_COLUMNS = `t.id, t.title, t.created_at, p.name AS priority_name, requester.name AS requester_name`
const TICKET_JOINS = `JOIN priorities p ON p.id = t.priority_id JOIN users requester ON requester.id = t.requester_id`
const notEscalated = (kind) =>
  `NOT EXISTS (SELECT 1 FROM ticket_escalations e WHERE e.ticket_id = t.id AND e.kind = '${kind}')`

// The rank from which a priority counts as urgent: the second-highest rank there is (High with the default four), the
// only one if there is just one, null without any priorities (then nothing is urgent)
async function urgentRank() {
  const ranks = [...new Set((await settings.allPriorities()).map((p) => p.rank))].sort((a, b) => b - a)
  return ranks[1] ?? ranks[0] ?? null
}

// Tickets that should be escalated now and haven't been, per kind
async function candidates({ at, unassignedMinutes }) {
  const cutoff = new Date(at.getTime() - unassignedMinutes * 60 * 1000)
  const rank = await urgentRank()
  const [unassigned] =
    rank === null
      ? [[]]
      : await pool.query(
          `SELECT ${TICKET_COLUMNS} FROM tickets t ${TICKET_JOINS}
     WHERE t.assigned_to IS NULL AND t.status NOT IN ('resolved', 'closed')
       AND p.level >= ? AND t.created_at <= ? AND ${notEscalated('unassigned')}
     ORDER BY t.created_at, t.id`,
          [rank, cutoff],
        )
  const [overdue] = await pool.query(
    `SELECT ${TICKET_COLUMNS} FROM tickets t ${TICKET_JOINS}
     WHERE ${overdueSqlAt('?')} AND ${notEscalated('overdue')}
     ORDER BY t.created_at, t.id`,
    [at],
  )
  return { unassigned, overdue }
}

// Records the escalations in one transaction; returns the tickets this run escalated (per kind)
async function record(found, at, hooks) {
  const recorded = { unassigned: [], overdue: [] }
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    if (hooks.beforeRecord) await hooks.beforeRecord() // tests: the transaction fails halfway
    for (const kind of KINDS) {
      for (const ticket of found[kind]) {
        const [result] = await conn.query(
          'INSERT IGNORE INTO ticket_escalations (ticket_id, kind, sent_at) VALUES (?, ?, ?)',
          [ticket.id, kind, at],
        )
        if (result.affectedRows !== 1) continue // already recorded by another run
        await recordAudit('ticket_escalated', { ticketId: ticket.id, details: { kind }, db: conn })
        recorded[kind].push(ticket)
      }
    }
    await conn.commit()
    return recorded
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

async function activeAdmins() {
  const [admins] = await pool.query(
    "SELECT id, name, email FROM users WHERE role = 'admin' AND is_active = TRUE AND email <> '' ORDER BY id",
  )
  return admins
}

// Runs the job once. Returns { unassigned, overdue, ids, emailed, skipped, durationMs }:
//   unassigned / overdue  how many tickets this run escalated
//   ids                   { unassigned: [...], overdue: [...] }
//   emailed               how many admins were sent the summary
//   skipped               'locked' | 'disabled' | null
// Options: now (the clock: a function returning a Date), log, and hooks for the tests.
async function runEscalation({ now = () => new Date(Date.now()), log = console, hooks = {} } = {}) {
  const started = process.hrtime.bigint()
  const summary = { unassigned: 0, overdue: 0, ids: { unassigned: [], overdue: [] }, emailed: 0, skipped: null }
  const finish = () => {
    summary.durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6)
    return summary
  }

  const lockConn = await pool.getConnection()
  let name
  try {
    name = await lockName(lockConn)
    const [[{ got }]] = await lockConn.query('SELECT GET_LOCK(?, 0) AS got', [name])
    if (got !== 1) {
      summary.skipped = 'locked'
      log.log('[escalation] Another run is in progress (lock taken); skipped')
      return finish()
    }
    try {
      if (hooks.afterLock) await hooks.afterLock() // tests: a second run starts while this one holds the lock
      const { enabled, unassignedMinutes } = await settings.escalationSettings()
      if (!enabled) {
        summary.skipped = 'disabled'
        log.log('[escalation] escalation_enabled is off: the job is switched off')
        return finish()
      }
      // DATETIME keeps whole seconds
      const at = new Date(Math.floor(now().getTime() / 1000) * 1000)
      const recorded = await record(await candidates({ at, unassignedMinutes }), at, hooks)
      summary.unassigned = recorded.unassigned.length
      summary.overdue = recorded.overdue.length
      summary.ids = { unassigned: recorded.unassigned.map((t) => t.id), overdue: recorded.overdue.map((t) => t.id) }

      if (summary.unassigned + summary.overdue > 0) {
        const counts = templates.escalationCounts(recorded)
        if (!isEmailConfigured()) {
          log.warn(`[escalation] Email is not set up, so nobody was emailed: ${counts} (recorded)`)
        } else {
          const admins = await activeAdmins()
          const company = await settings.companyName()
          const { appUrl } = getMailer().config
          for (const admin of admins) {
            const message = templates.escalationSummary({
              recipientName: admin.name,
              ...recorded,
              unassignedMinutes,
              now: at,
              ticketLink: (id) => templates.links.ticket(appUrl, id),
              company,
            })
            if (await sendMailSafe({ template: 'escalation', to: admin.email, ...message })) summary.emailed += 1
          }
          if (admins.length === 0) log.warn(`[escalation] No active admin to email: ${counts} (recorded)`)
        }
      }
    } finally {
      await lockConn.query('SELECT RELEASE_LOCK(?)', [name])
    }
  } finally {
    lockConn.release()
  }

  finish()
  log.log(
    `[escalation] Done: ${summary.unassigned} urgent unassigned, ${summary.overdue} overdue escalated, ` +
      `${summary.emailed} admins emailed, ${summary.durationMs} ms`,
  )
  return summary
}

module.exports = { runEscalation, KINDS }
