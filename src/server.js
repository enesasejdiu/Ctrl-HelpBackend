// Entry point: loads environment variables, checks them, then starts the HTTP server.
// dotenv must run before app.js is required so process.env is populated for middleware config.
require('dotenv').config()

// Refuses to start (exit 1, with a list of problems) when a setting is missing or, in production, too weak
const config = require('./config').checkConfig('server')

// The attachments folder must exist and be writable; better to find out now than at the first upload
const { ensureUploadDir } = require('./attachments')
try {
  ensureUploadDir()
} catch (err) {
  console.error(`UPLOAD_DIR is not usable: ${err.message}\nFix UPLOAD_DIR in .env (see .env.example) and start again.`)
  process.exit(1)
}

const app = require('./app')
const { startSessionCleanup } = require('./sessionStore')

const PORT = config.PORT

// Express 5 passes listen errors (e.g. port already in use) to this callback instead of throwing
app.listen(PORT, (err) => {
  if (err) {
    console.error(`Failed to start server on port ${PORT}: ${err.message}`)
    process.exit(1)
  }
  console.log(`TicketFlow API running at http://localhost:${PORT}`)
  // Checks the SMTP connection once (production and development with SMTP_HOST). Only warns if it fails: the API
  // keeps working, emails just may not arrive.
  const mailer = require('./mail/mailer')
  // How new and reset passwords reach people: decided by the server's mail settings (isEmailConfigured)
  console.log(`Password delivery: ${mailer.isEmailConfigured() ? 'email link' : 'temporary password'}`)
  mailer.getMailer().verify()
})

// Deletes sessions that ended more than 7 days ago: now, then once a day (see src/sessionStore.js)
startSessionCleanup()
// The same for password links used or expired more than 7 days ago (see src/passwordTokens.js)
require('./passwordTokens').startPasswordTokenCleanup(require('./db'))
