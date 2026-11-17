// The audit log of security events (the audit_log table, migration 009), shown to admins by GET /api/audit.
// Routes call recordAudit() at the moment something happens. Details never contain a password, password hash, token or
// session id: callers don't pass them, and recordAudit() drops any key that looks like one, as a safety net.
const pool = require('./db')

// Every action the log records, in the order the filter dropdown shows them (GET /api/audit/actions)
const AUDIT_ACTIONS = [
  'login_success', // a successful login. details: { email }
  'login_failure', // a refused login. details: { email, reason: unknown_email | wrong_password | locked | deactivated }
  'account_locked', // the wrong password that locked the account. details: { email, minutes }
  'logout', // POST /api/auth/logout ended a session
  'logout_all', // POST /api/auth/logout-all ended every session of the user
  'password_changed', // the user changed their own password
  'password_reset', // an admin or HR reset the password (a temporary password or an emailed link)
  'password_reset_requested', // "Forgot password" sent the user a reset link (actor null: nobody is logged in)
  'password_reset_self', // the user set a new password with their "Forgot password" link
  'password_set_with_link', // a new account set its password with the emailed link (POST /api/auth/set-password)
  'user_created', // an admin or HR created the account (a set-password link is emailed). details: { email, role, department_id }
  'invite_resent', // an admin or HR sent the account a new set-password link
  'user_updated', // an admin or HR edited the account. details: { fields: [...] } (which fields, not their values)
  'role_changed', // details: { from, to }
  'user_activated',
  'user_deactivated',
  'attachment_uploaded', // a file was added to a ticket. details: { ticket_id, file_name, mime_type, size_bytes }
  'attachment_deleted', // details: { ticket_id, file_name, size_bytes } (never the file's content)
  // The daily job closed a ticket resolved for auto_close_days. actor null (the system); ticket_id set; details: { days }
  'ticket_auto_closed',
  // The escalation job told the admins about a ticket (src/jobs/escalation.js). actor null; ticket_id set;
  // details: { kind: unassigned | overdue }
  'ticket_escalated',
  // Knowledge base (routes/kb.js), by staff. details: { article_id, slug, title } (+ fields: [...] for an update, which
  // fields changed, not their values); for categories { category_id, name }
  'kb.article_created',
  'kb.article_updated',
  'kb.article_published',
  'kb.article_unpublished',
  'kb.article_deleted',
  'kb.category_created',
  'kb.category_updated',
  'kb.category_deleted',
  // Shared canned responses (routes/cannedResponses.js), by admins; personal ones are not logged. details:
  // { canned_response_id, title } (+ fields: [...] for an update: which fields changed, never the text)
  'canned.shared_created',
  'canned.shared_updated',
  'canned.shared_deleted',
]

// Keys that could carry a secret; never stored, whatever a caller passes
// (a session id is a secret, a count of sessions is not: `sid` and `session_id` are dropped, `sessions_ended` stays)
const SECRET_KEY = /pass|hash|token|secret|^sid$|session_?id|cookie|csrf/i

function withoutSecrets(details) {
  if (!details) return null
  const clean = {}
  for (const [key, value] of Object.entries(details)) {
    if (!SECRET_KEY.test(key) && value !== undefined) clean[key] = value
  }
  return Object.keys(clean).length > 0 ? clean : null
}

// Records one event. db: a transaction's connection, so the entry is saved together with the change it describes.
async function recordAudit(
  action,
  { actorId = null, targetUserId = null, ticketId = null, details = null, req = null, db = pool } = {},
) {
  if (!AUDIT_ACTIONS.includes(action)) throw new Error(`Unknown audit action: ${action}`)
  const clean = withoutSecrets(details)
  // ticket_id (migration 016): the ticket an entry is about, e.g. ticket_auto_closed
  await db.query(
    'INSERT INTO audit_log (actor_id, action, target_user_id, ticket_id, details, ip) VALUES (?, ?, ?, ?, ?, ?)',
    [actorId, action, targetUserId, ticketId, clean === null ? null : JSON.stringify(clean), req?.ip || null],
  )
}

// MySQL returns a JSON column already parsed; MariaDB (JSON = LONGTEXT) returns the text. Same result on both.
function parseDetails(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// One page of the log for GET /api/audit, newest first. Filters (all optional): user (as actor OR target), action,
// from / to (Date objects; from inclusive, to exclusive). Returns { entries, total }.
async function listAudit({ user, action, from, to, page, pageSize }, db = pool) {
  const where = []
  const params = []
  if (user !== undefined) {
    where.push('(a.actor_id = ? OR a.target_user_id = ?)')
    params.push(user, user)
  }
  if (action !== undefined) {
    where.push('a.action = ?')
    params.push(action)
  }
  if (from !== undefined) {
    where.push('a.created_at >= ?')
    params.push(from)
  }
  if (to !== undefined) {
    where.push('a.created_at < ?')
    params.push(to)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM audit_log a ${whereSql}`, params)
  const [rows] = await db.query(
    `SELECT a.id, a.created_at, a.action, a.details, a.ip,
            a.actor_id, actor.name AS actor_name, a.target_user_id, target.name AS target_name, a.ticket_id
     FROM audit_log a
     LEFT JOIN users actor ON actor.id = a.actor_id
     LEFT JOIN users target ON target.id = a.target_user_id
     ${whereSql}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  )

  const entries = rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    action: row.action,
    actor: row.actor_id === null ? null : { id: row.actor_id, name: row.actor_name },
    target: row.target_user_id === null ? null : { id: row.target_user_id, name: row.target_name },
    details: parseDetails(row.details),
    ip: row.ip,
  }))
  return { entries, total: Number(total) }
}

module.exports = { AUDIT_ACTIONS, recordAudit, listAudit, withoutSecrets }
