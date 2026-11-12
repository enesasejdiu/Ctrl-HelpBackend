// Runs once before all test files: creates a fresh test database, applies every migration with the same code as
// `npm run db:migrate` (migration 015 adds the standard categories and priorities, as on a fresh install).
// tests/globalTeardown.js drops it.
const { assertTestDbName, newTestDbName } = require('./testDb')

module.exports = async function globalSetup() {
  const dbName = assertTestDbName(newTestDbName())

  // Test files read the name from here (tests/setupEnv.js), and so does globalTeardown.js
  process.env.TEST_DB_NAME = dbName

  process.env.DOTENV_CONFIG_QUIET = 'true' // migrate.js loads .env too; keep the test output clean
  const { migrate } = require('../scripts/migrate')

  try {
    // migrate() creates the database; the backup is skipped because it is brand new and empty
    const log = console.log
    console.log = () => {} // migrate() prints "Applied ..." lines, which only clutter the test output
    try {
      await migrate({ dbName, backupFirst: false })
    } finally {
      console.log = log
    }
  } catch (err) {
    // Jest skips globalTeardown when globalSetup fails, so clean up here instead of leaving a database behind
    await require('./globalTeardown')()
    throw err
  }
}
