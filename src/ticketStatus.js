// ticketStatus.js – the one place that knows what a status change does to a ticket's timestamps, used by every code
// path that changes a status: the status and assign routes (routes/tickets.js), unassigning when a staff member is
// deactivated (routes/users.js), and the auto-close job (jobs/autoClose.js).
//
//   → resolved            resolved_at = now, closed_at cleared
//   → closed              closed_at = now; resolved_at stays (closed tickets still count as resolved in the
//                         statistics, and auto-close needs it)
//   → any other status    resolved_at and closed_at cleared: the ticket is unfinished again (reopened, back to in
//                         progress, ...). The statistics and the auto-close job treat resolved_at as "resolved since".
//
// `at` is the time to write (a Date); without it the database's NOW() is used, as the routes always have.
const STATUSES = ['open', 'assigned', 'in_progress', 'waiting_for_user', 'resolved', 'closed', 'reopened']

// The SET fragments and their parameters for moving a ticket to `status`, e.g.
//   const { sets, params } = statusSets('resolved')
//   await db.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`, [...params, id])
function statusSets(status, { at } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`Unknown ticket status: ${status}`)
  const now = at ? '?' : 'NOW()'
  const nowParams = at ? [at] : []
  const sets = ['status = ?']
  const params = [status]
  if (status === 'resolved') {
    sets.push(`resolved_at = ${now}`, 'closed_at = NULL')
    params.push(...nowParams)
  } else if (status === 'closed') {
    sets.push(`closed_at = ${now}`)
    params.push(...nowParams)
  } else {
    sets.push('resolved_at = NULL', 'closed_at = NULL')
  }
  return { sets, params }
}

// Records a status change in the ticket's history. changedBy null = the system (e.g. the auto-close job).
async function logStatusChange(db, ticketId, changedBy, from, to) {
  await db.query(
    "INSERT INTO ticket_history (ticket_id, changed_by, field_changed, old_value, new_value) VALUES (?, ?, 'status', ?, ?)",
    [ticketId, changedBy, from, to],
  )
}

module.exports = { statusSets, logStatusChange, STATUSES }
