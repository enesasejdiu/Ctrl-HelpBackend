// Entry point: loads environment variables, checks them, then starts the HTTP server.
// dotenv must run before app.js is required so process.env is populated for middleware config.
require('dotenv').config()

// Refuses to start (exit 1, with a list of problems) when a setting is missing or, in production, too weak
const config = require('./config').checkConfig('server')

const app = require('./app')

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
  require('./mail/mailer').getMailer().verify()
})
