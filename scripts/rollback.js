// Undoes the most recently applied migration by running its file in migrations/down/ (same name), then removes it
// from schema_migrations so the next db:migrate applies it again. One migration per run. Backs up first.
// Usage: npm run db:rollback. Rolling back usually deletes data, so read the down file before running it.
require('dotenv').config()

const fs = require('fs')
const path = require('path')
const mysql = require('mysql2/promise')
const { backup } = require('./backup-db')
const { migrationLockName } = require('./migrationLock')

const DOWN_DIR = path.join(__dirname, '..', 'migrations', 'down')

// dbName defaults to DB_NAME from .env. backupFirst: false skips the backup (throwaway test databases only).
async function rollback({ dbName = process.env.DB_NAME, backupFirst = true } = {}) {
  if (!dbName) {
    throw new Error('DB_NAME is not set. Copy .env.example to .env first')
  }

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: dbName,
    multipleStatements: true, // a down file can contain several statements
  })

  try {
    // The same per-database lock as db:migrate, so a migrate and a rollback of this database can't run at the same time
    const [[{ locked }]] = await connection.query('SELECT GET_LOCK(?, 0) AS locked', [migrationLockName(dbName)])
    if (!locked) {
      throw new Error(`Another db:migrate or db:rollback is running on "${dbName}". Wait for it to finish`)
    }

    const [[latest]] = await connection.query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1')
    if (!latest) {
      throw new Error('No migrations have been applied, so there is nothing to roll back')
    }

    const downFile = path.join(DOWN_DIR, latest.filename)
    if (!fs.existsSync(downFile)) {
      throw new Error(
        `${latest.filename} has no rollback file (migrations/down/${latest.filename}), so it can't be undone`,
      )
    }
    const sql = fs.readFileSync(downFile, 'utf8')

    // As with db:migrate, a rollback that fails partway can only be undone from the backup
    const backupFile = backupFirst ? await backup() : null
    try {
      await connection.query(sql)
    } catch (err) {
      const restore = backupFile ? ` If it changed anything, restore backups/${backupFile}.` : ''
      throw new Error(`Rolling back ${latest.filename} failed: ${err.message}.${restore}`, { cause: err })
    }
    await connection.query('DELETE FROM schema_migrations WHERE filename = ?', [latest.filename])
    console.log(`Rolled back ${latest.filename}`)
  } finally {
    // Release the lock explicitly: closing the connection releases it too, but the server does that a moment later,
    // so the next migrate or rollback (e.g. several in a row) could still find it taken and give up
    await connection.query('SELECT RELEASE_LOCK(?)', [migrationLockName(dbName)]).catch(() => {})
    await connection.end()
  }
}

if (require.main === module) {
  // Stop with a clear message before connecting if a DB_* setting is missing or malformed (src/config.js)
  require('../src/config').checkConfig('database')
  rollback().catch((err) => {
    console.error('Rollback failed:', err.message)
    process.exitCode = 1
  })
}

module.exports = { rollback }
