// Deletes sessions that expired or were revoked more than 7 days ago (the server also does this on start and once a
// day). Only ended sessions are removed; nobody is logged out. Usage: npm run db:sessions:cleanup
require('dotenv').config()

const pool = require('../src/db')
const { cleanupSessions, KEEP_ENDED_DAYS } = require('../src/sessionStore')

if (require.main === module) {
  // Stop with a clear message before connecting if a DB_* setting is missing or malformed (src/config.js)
  require('../src/config').checkConfig('database')
  cleanupSessions()
    .then((deleted) => console.log(`Deleted ${deleted} sessions that ended more than ${KEEP_ENDED_DAYS} days ago.`))
    .catch((err) => {
      console.error('Session cleanup failed:', err.message)
      process.exitCode = 1
    })
    .finally(() => pool.end())
}
