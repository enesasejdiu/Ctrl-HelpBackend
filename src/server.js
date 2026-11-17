// Entry point: loads environment variables, checks them, then starts the HTTP server.
// dotenv must run before app.js is required so process.env is populated for middleware config.
require('dotenv').config()

// Everything the server says goes through the logger (src/logger.js): JSON lines in production, readable in development
const { logger, asConsole } = require('./logger')
const log = asConsole(logger)

// Refuses to start (exit 1, with a list of problems) when a setting is missing or, in production, too weak
const config = require('./config').checkConfig('server', { log })

// Error tracking (src/sentry.js): only with SENTRY_DSN; without it nothing is loaded or sent
const sentry = require('./sentry')
if (sentry.initSentry()) logger.info('Error tracking: Sentry is on (5xx errors and crashes, no personal data)')

// A crash (an uncaught exception, an unhandled rejection): logged, sent to Sentry (if on), exit 1 (src/crash.js)
require('./crash').installCrashHandlers()

// The attachments folder must exist and be writable; better to find out now than at the first upload
const { ensureUploadDir } = require('./attachments')
try {
  ensureUploadDir()
} catch (err) {
  logger.fatal(
    { err },
    `UPLOAD_DIR is not usable: ${err.message}. Fix UPLOAD_DIR in .env (see .env.example) and start again.`,
  )
  process.exit(1)
}

const app = require('./app')
const { startSessionCleanup } = require('./sessionStore')

const PORT = config.PORT

// Express 5 passes listen errors (e.g. port already in use) to this callback instead of throwing
const server = app.listen(PORT, (err) => {
  if (err) {
    logger.fatal({ err }, `Failed to start server on port ${PORT}: ${err.message}`)
    process.exit(1)
  }
  logger.info({ port: PORT, node_env: config.NODE_ENV }, `TicketFlow API running at http://localhost:${PORT}`)
  // Checks the SMTP connection once (production and development with SMTP_HOST). Only warns if it fails: the API
  // keeps working, emails just may not arrive.
  const mailer = require('./mail/mailer')
  // How new and reset passwords reach people: decided by the server's mail settings (isEmailConfigured)
  logger.info(`Password delivery: ${mailer.isEmailConfigured() ? 'email link' : 'temporary password'}`)
  mailer.getMailer().verify()
})

// Deletes sessions that ended more than 7 days ago: now, then once a day (see src/sessionStore.js)
const sessionCleanup = startSessionCleanup({ log })
// Closes tickets resolved for auto_close_days, every day at 03:00 Europe/Budapest (src/jobs/schedule.js)
const autoClose = require('./jobs/schedule').startAutoCloseSchedule({ log })
// Escalation emails to the admins, every 5 minutes (src/jobs/escalation.js)
const escalation = require('./jobs/schedule').startEscalationSchedule({ log })
// The same for password links used or expired more than 7 days ago (see src/passwordTokens.js)
const pool = require('./db')
const tokenCleanup = require('./passwordTokens').startPasswordTokenCleanup(pool, { log })

// SIGTERM (docker stop) or SIGINT (Ctrl+C): finish open requests, close the database pool, exit 0 (src/shutdown.js)
require('./shutdown').handleShutdownSignals(
  { server, pool, timers: [sessionCleanup, tokenCleanup], jobs: [autoClose, escalation] },
  { log },
)
