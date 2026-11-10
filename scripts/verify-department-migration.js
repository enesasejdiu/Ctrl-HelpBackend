// Checks that migration 005 linked users to departments correctly. Read-only.
// Usage: npm run db:verify-departments (reads DB_NAME from .env). The explicit merges are read from the
// mapping in migrations/005_link_users_to_departments.sql, so the check uses exactly what the migration used.
require('dotenv').config({ quiet: true })

const fs = require('fs')
const path = require('path')
const mysql = require('mysql2/promise')

const MIGRATION = path.join(__dirname, '..', 'migrations', '005_link_users_to_departments.sql')

// Trim, collapse whitespace; the database compares without case or accents, so the check does too
const clean = (value) => (value ?? '').trim().replace(/\s+/g, ' ')
const fold = (value) => clean(value).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// The ('from', 'to') pairs in the migration's uncommented INSERT INTO department_mapping_005 lines
function mappingFromMigration(sql = fs.readFileSync(MIGRATION, 'utf8')) {
  const mapping = {}
  for (const line of sql.split('\n')) {
    if (!/^\s*INSERT\b.*department_mapping_005/i.test(line)) continue
    for (const [, from, to] of line.matchAll(/\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*\)/g)) {
      mapping[from.replace(/''/g, "'")] = to.replace(/''/g, "'")
    }
  }
  return mapping
}

// Runs the four checks; returns [{ check, ok, detail }]
async function verify(db, mapping = mappingFromMigration()) {
  const merges = new Map(Object.entries(mapping).map(([from, to]) => [fold(from), clean(to)]))
  const expected = (old) => merges.get(fold(old)) ?? clean(old)
  const results = []

  const [unlinked] = await db.query(
    `SELECT id, department FROM users
     WHERE department_id IS NULL AND TRIM(REGEXP_REPLACE(COALESCE(department, ''), '[[:space:]]+', ' ')) <> ''`,
  )
  results.push({
    check: 'Every user with an old value has a department',
    ok: unlinked.length === 0,
    detail: unlinked.length ? `not linked: user ids ${unlinked.map((u) => u.id).join(', ')}` : 'all linked',
  })

  // Only the users 005 linked: users who already had a department_id were left alone on purpose
  const [[tracking]] = await db.query(
    "SELECT COUNT(*) AS present FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'department_migration_005'",
  )
  const [linked] = tracking.present
    ? await db.query(
        `SELECT u.id, u.department, d.name FROM users u
         JOIN department_migration_005 t ON t.kind = 'user' AND t.row_id = u.id
         JOIN departments d ON d.id = u.department_id`,
      )
    : [[]]
  const mismatched = linked.filter((u) => fold(u.name) !== fold(expected(u.department)))
  results.push({
    check: "Every user's department matches their old value",
    ok: mismatched.length === 0,
    detail: mismatched.length
      ? mismatched.map((u) => `user ${u.id}: ${JSON.stringify(u.department)} is in "${u.name}"`).join('; ')
      : `${linked.length} users checked`,
  })

  const [duplicates] = await db.query(
    'SELECT LOWER(name) COLLATE utf8mb4_bin AS name, COUNT(*) AS n FROM departments GROUP BY 1 HAVING n > 1',
  )
  results.push({
    check: 'No two departments share a name (ignoring case)',
    ok: duplicates.length === 0,
    detail: duplicates.length ? duplicates.map((d) => `"${d.name}" ×${d.n}`).join(', ') : 'none',
  })

  const [[counts]] = await db.query(
    `SELECT SUM(department_id IS NULL) AS without_department,
            SUM(department_id IS NULL AND TRIM(REGEXP_REPLACE(COALESCE(department, ''), '[[:space:]]+', ' ')) = '')
              AS without_department_and_empty_value,
            SUM(TRIM(REGEXP_REPLACE(COALESCE(department, ''), '[[:space:]]+', ' ')) = '') AS empty_value
     FROM users`,
  )
  const without = Number(counts.without_department)
  // Users without a department are exactly those with an empty old value (minus any of those who already had one)
  results.push({
    check: 'Users without a department are the ones with an empty old value',
    ok: without === Number(counts.without_department_and_empty_value),
    detail: `${without} without a department, ${Number(counts.empty_value)} with an empty old value`,
  })

  return results
}

if (require.main === module) {
  // Stop with a clear message before connecting if a DB_* setting is missing or malformed (src/config.js)
  require('../src/config').checkConfig('database')
  ;(async () => {
    const db = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    })
    try {
      const results = await verify(db)
      for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check} (${r.detail})`)
      if (results.some((r) => !r.ok)) process.exitCode = 1
    } finally {
      await db.end()
    }
  })().catch((err) => {
    console.error('Verification failed:', err.message)
    process.exitCode = 1
  })
}

module.exports = { verify, mappingFromMigration }
