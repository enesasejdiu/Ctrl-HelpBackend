// autoClose.js – closes tickets that have been resolved for auto_close_days (a setting, default 7; 0 = off). Runs daily
// (src/jobs/schedule.js) and by hand (npm run job:auto-close, with --dry-run to only list them).
//
// - Which tickets: status = 'resolved' AND resolved_at <= now - auto_close_days × 24 h.
// - In batches of BATCH_SIZE. Every UPDATE repeats that condition, so a ticket reopened (or resolved again) after the
//   batch was picked isn't closed: no "pick ids, then update by id" without checking again.
// - Each closed ticket: status closed, closed_at now (src/ticketStatus.js, like every status change), a history row by
//   the system (changed_by NULL), and an audit entry ticket_auto_closed. No email: closing never sends one, and the
//   job doesn't go through the routes that send emails.
// - One run at a time: a database lock (GET_LOCK, per database, the same kind as the migration lock). If another run
//   holds it, this one logs that and does nothing.
// - Idempotent: a closed ticket no longer matches, so a second run closes nothing.
// - A failing batch is logged and the job goes on with the next one. It never throws for a ticket's sake; the caller
//   (the scheduler) also catches anything unexpected, so the API process never crashes because of it.
// - The end: a summary line (checked, closed, failed, duration).
const pool = require('../db')
const settings = require('../settings')
const { recordAudit } = require('../audit')
const { statusSets, logStatusChange } = require('../ticketStatus')

const BATCH_SIZE = 500
const DAY_MS = 24 * 60 * 60 * 1000
// The tickets the job closes; resolved_at is compared with a cutoff passed as a parameter
const DUE = "status = 'resolved' AND resolved_at <= ?"

// GET_LOCK names are global to the MySQL server, so the database name is part of it (at most 64 characters)
async function lockName(conn) {
  const [[{ name }]] = await conn.query('SELECT DATABASE() AS name')
  return `ticketflow_auto_close:${name}`.slice(0, 64)
}

// Closes one batch in a transaction; returns the ids it actually closed (fewer than `ids` if some changed meanwhile)
async function closeBatch(ids, { at, cutoff, days, hooks }) {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    if (hooks.beforeUpdate) await hooks.beforeUpdate(ids) // tests: something happens between picking and updating
    const { sets, params } = statusSets('closed', { at })
    const [result] = await conn.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id IN (?) AND ${DUE}`, [
      ...params,
      ids,
      cutoff,
    ])
    let closed = ids
    if (result.affectedRows !== ids.length) {
      // Some no longer matched: the ones this UPDATE closed have exactly this closed_at (and are locked until commit)
      const [rows] = await conn.query(
        "SELECT id FROM tickets WHERE id IN (?) AND status = 'closed' AND closed_at = ?",
        [ids, at],
      )
      closed = rows.map((row) => row.id)
    }
    for (const id of closed) {
      await logStatusChange(conn, id, null, 'resolved', 'closed')
      await recordAudit('ticket_auto_closed', { ticketId: id, details: { days }, db: conn })
    }
    await conn.commit()
    return closed
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

// Runs the job once. Returns { checked, closed, failed, ids, days, skipped, durationMs }:
//   ids      the closed tickets (with dryRun: the ones that would be closed)
//   skipped  'locked' (another run holds the lock) | 'disabled' (auto_close_days = 0) | null
// Options: dryRun (change nothing, only list), batchSize, now (the clock: a function returning a Date), log, and
// hooks for the tests.
async function runAutoClose({
  dryRun = false,
  batchSize = BATCH_SIZE,
  now = () => new Date(Date.now()),
  log = console,
  hooks = {},
} = {}) {
  const started = process.hrtime.bigint()
  const summary = { checked: 0, closed: 0, failed: 0, ids: [], days: null, skipped: null, durationMs: 0 }
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
      log.log('[auto-close] Another run is in progress (lock taken); skipped')
      return finish()
    }

    try {
      summary.days = await settings.autoCloseDays()
      if (summary.days === 0) {
        summary.skipped = 'disabled'
        log.log('[auto-close] auto_close_days is 0: the job is switched off')
        return finish()
      }
      // TIMESTAMP columns keep whole seconds, so the time written is too (it is compared back in closeBatch)
      const at = new Date(Math.floor(now().getTime() / 1000) * 1000)
      const cutoff = new Date(at.getTime() - summary.days * DAY_MS)

      if (dryRun) {
        const [rows] = await pool.query(`SELECT id FROM tickets WHERE ${DUE} ORDER BY id`, [cutoff])
        summary.checked = rows.length
        summary.ids = rows.map((row) => row.id)
        log.log(
          `[auto-close] Dry run: ${rows.length} tickets resolved for ${summary.days}+ days would be closed` +
            (rows.length ? `: ${summary.ids.join(', ')}` : ''),
        )
        return finish()
      }

      let lastId = 0
      for (;;) {
        const [rows] = await pool.query(`SELECT id FROM tickets WHERE ${DUE} AND id > ? ORDER BY id LIMIT ?`, [
          cutoff,
          lastId,
          batchSize,
        ])
        if (rows.length === 0) break
        const ids = rows.map((row) => row.id)
        lastId = ids[ids.length - 1]
        summary.checked += ids.length
        try {
          const closed = await closeBatch(ids, { at, cutoff, days: summary.days, hooks })
          summary.closed += closed.length
          summary.ids.push(...closed)
        } catch (err) {
          summary.failed += ids.length
          log.error(`[auto-close] A batch of ${ids.length} tickets (ids ${ids[0]}–${lastId}) failed: ${err.message}`)
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
    `[auto-close] Done: checked ${summary.checked}, closed ${summary.closed}, failed ${summary.failed}, ` +
      `${summary.durationMs} ms (tickets resolved for ${summary.days}+ days)`,
  )
  return summary
}

module.exports = { runAutoClose, BATCH_SIZE }
