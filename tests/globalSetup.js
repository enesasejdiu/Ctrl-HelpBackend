// Runs once before all test files: creates a fresh test database, applies every migration with the same code as
// `npm run db:migrate`, and adds the categories and priorities the app needs. tests/globalTeardown.js drops it.
const mysql = require('mysql2/promise')
const { assertTestDbName, newTestDbName, loadServerSettings } = require('./testDb')

module.exports = async function globalSetup() {
  const dbName = assertTestDbName(newTestDbName())
  const server = loadServerSettings()

  // Test files read the name from here (tests/setupEnv.js), and so does globalTeardown.js
  process.env.TEST_DB_NAME = dbName

  process.env.DOTENV_CONFIG_QUIET = 'true' // migrate.js loads .env too; keep the test output clean
  const { migrate } = require('../scripts/migrate')
  const { categories, priorities } = require('../scripts/reference-data')

  try {
    // migrate() creates the database; the backup is skipped because it is brand new and empty
    const log = console.log
    console.log = () => {} // migrate() prints "Applied ..." lines, which only clutter the test output
    try {
      await migrate({ dbName, backupFirst: false })
    } finally {
      console.log = log
    }

    const connection = await mysql.createConnection({ ...server, database: dbName })
    try {
      for (const [name, description] of categories) {
        await connection.query('INSERT INTO categories (name, description) VALUES (?, ?)', [name, description])
      }
      for (const [name, level, targetHours] of priorities) {
        await connection.query('INSERT INTO priorities (name, level, target_hours) VALUES (?, ?, ?)', [
          name,
          level,
          targetHours,
        ])
      }
    } finally {
      await connection.end()
    }
  } catch (err) {
    // Jest skips globalTeardown when globalSetup fails, so clean up here instead of leaving a database behind
    await require('./globalTeardown')()
    throw err
  }
}
