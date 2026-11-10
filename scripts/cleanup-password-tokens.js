// Deletes password links (password_tokens) used or expired more than 7 days ago (the server also does this on start and
// once a day). Links that can still be used are never removed. Usage: npm run db:password-tokens:cleanup
require('dotenv').config()

const pool = require('../src/db')
const { cleanupPasswordTokens, KEEP_ENDED_DAYS } = require('../src/passwordTokens')

if (require.main === module) {
  // Stop with a clear message before connecting if a DB_* setting is missing or malformed (src/config.js)
  require('../src/config').checkConfig('database')
  cleanupPasswordTokens(pool)
    .then((deleted) =>
      console.log(`Deleted ${deleted} password links used or expired more than ${KEEP_ENDED_DAYS} days ago.`),
    )
    .catch((err) => {
      console.error('Password link cleanup failed:', err.message)
      process.exitCode = 1
    })
    .finally(() => pool.end())
}
