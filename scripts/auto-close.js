// Runs the auto-close job once (src/jobs/autoClose.js): closes tickets resolved for auto_close_days (default 7).
// The server also runs it every day at 03:00 Europe/Budapest (src/jobs/schedule.js).
//   npm run job:auto-close               close them now
//   npm run job:auto-close -- --dry-run  only list the ticket ids and the count that would be closed; changes nothing
// Exits with 1 if a batch failed.
require('dotenv').config({ quiet: true })

const pool = require('../src/db')
const { runAutoClose } = require('../src/jobs/autoClose')

if (require.main === module) {
  // Stop with a clear message before connecting if a DB_* setting is missing or malformed (src/config.js)
  require('../src/config').checkConfig('database')
  const dryRun = process.argv.includes('--dry-run')
  runAutoClose({ dryRun })
    .then((summary) => {
      if (summary.failed > 0) process.exitCode = 1
    })
    .catch((err) => {
      console.error('Auto-close failed:', err.message)
      process.exitCode = 1
    })
    .finally(() => pool.end())
}
