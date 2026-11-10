// Server-side sessions (the sessions table, migration 008). Every login gets a row; its id goes into the JWT as "sid".
// requireAuth only accepts a token whose row exists, isn't revoked and hasn't expired, so ending a session here ends it
// for real, even for someone who copied the token before. All times come from the database clock (NOW()).
const crypto = require('crypto')
const pool = require('./db')
const { SESSION_HOURS } = require('./session')

// last_seen_at is written at most this often per session, not on every request
const LAST_SEEN_EVERY_SECONDS = 60
// Expired and revoked rows are kept this long (useful when looking into a login), then deleted
const KEEP_ENDED_DAYS = 7

// 32 random bytes as base64url: 43 URL-safe characters (sessions.id is CHAR(43))
function newSessionId() {
  return crypto.randomBytes(32).toString('base64url')
}

// Creates the row for a new login and returns its id. Lasts as long as the token (8 hours).
async function createSession(userId, req, db = pool) {
  const id = newSessionId()
  const userAgent = (req.get('user-agent') || '').slice(0, 255) || null
  await db.query(
    `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
     VALUES (?, ?, NOW() + INTERVAL ? HOUR, ?, ?)`,
    [id, userId, SESSION_HOURS, req.ip || null, userAgent],
  )
  return id
}

// The session for requireAuth: { user_id, active } or null. active = not revoked and not expired. Also records
// last_seen_at, at most once a minute.
async function findActiveSession(sid, db = pool) {
  if (typeof sid !== 'string' || sid.length !== 43) return null
  const [rows] = await db.query(
    `SELECT user_id,
            revoked_at IS NULL AND expires_at > NOW() AS active,
            TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) AS seen_seconds_ago
     FROM sessions WHERE id = ?`,
    [sid],
  )
  const session = rows[0]
  if (!session) return null
  if (session.active && session.seen_seconds_ago >= LAST_SEEN_EVERY_SECONDS) {
    await db.query('UPDATE sessions SET last_seen_at = NOW() WHERE id = ?', [sid])
  }
  return { user_id: session.user_id, active: Boolean(session.active) }
}

// Ends one session (logout). Fine if it is already ended or gone.
async function revokeSession(sid, db = pool) {
  await db.query('UPDATE sessions SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL', [sid])
}

// Ends every session of a user, except `keepSid` if given (a password change keeps the session that made it)
async function revokeUserSessions(userId, { keepSid = null, db = pool } = {}) {
  await db.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL AND id <> ?', [
    userId,
    keepSid ?? '',
  ])
}

// Deletes sessions that expired or were revoked more than KEEP_ENDED_DAYS ago. Returns how many were deleted.
async function cleanupSessions(db = pool) {
  const [result] = await db.query(
    `DELETE FROM sessions
     WHERE expires_at < NOW() - INTERVAL ? DAY OR revoked_at < NOW() - INTERVAL ? DAY`,
    [KEEP_ENDED_DAYS, KEEP_ENDED_DAYS],
  )
  return result.affectedRows
}

// Runs cleanupSessions now, then every `everyMs` (a day). The timer is unref()'d, so it never keeps the process alive on
// its own. A failure (e.g. the database is briefly down) is only logged. Returns the timer (clearInterval stops it).
const DAY_MS = 24 * 60 * 60 * 1000
function startSessionCleanup({ everyMs = DAY_MS, log = console } = {}) {
  const run = () =>
    cleanupSessions()
      .then((deleted) => {
        if (deleted > 0)
          log.log(`Session cleanup: deleted ${deleted} sessions ended more than ${KEEP_ENDED_DAYS} days ago`)
      })
      .catch((err) => log.error(`Session cleanup failed: ${err.message}`))
  run()
  return setInterval(run, everyMs).unref()
}

module.exports = {
  createSession,
  findActiveSession,
  revokeSession,
  revokeUserSessions,
  cleanupSessions,
  startSessionCleanup,
  LAST_SEEN_EVERY_SECONDS,
  KEEP_ENDED_DAYS,
}
