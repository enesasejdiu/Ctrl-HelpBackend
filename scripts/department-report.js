// Read-only report on users' free-text department values, before they are turned into rows in departments.
// Shows each raw value, the groups normalization makes (trim, collapse spaces, ignore case), the canonical name each
// group would get, groups that match an existing department, and likely near-duplicates that need a manual mapping.
// Usage: npm run db:department-report (reads DB_NAME from .env). It never writes anything.
require('dotenv').config({ quiet: true })

const mysql = require('mysql2/promise')

// Same rule the migration uses: trim, collapse runs of whitespace, compare without case
const clean = (value) => (value ?? '').trim().replace(/\s+/g, ' ')
const keyOf = (value) => clean(value).toLowerCase()
// The database also ignores accents (utf8mb4_unicode_ci), so "Café" and "Cafe" would be one department there
const collationKey = (value) => keyOf(value).normalize('NFD').replace(/[̀-ͯ]/g, '')

// Edit distance, for spotting typos such as "Slaes" / "Sales"
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}

// Why two group keys look like the same department, or null
function nearDuplicateReason(a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  const initials = long
    .split(/[\s&/-]+/)
    .filter((w) => !['and', 'of', 'the'].includes(w))
    .map((w) => w[0])
    .join('')
  if (short.replace(/[^a-z]/g, '') === initials && short.length >= 2) return 'abbreviation'
  const d = distance(a, b)
  if (d <= 2 && 1 - d / long.length >= 0.6) return `typo (edit distance ${d})`
  if (short.length >= 3 && long.split(' ').includes(short)) return 'one contains the other'
  return null
}

async function report(dbName = process.env.DB_NAME) {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: dbName,
  })
  try {
    await connection.query('START TRANSACTION READ ONLY')
    const [raw] = await connection.query(
      // MIN(): every row in a BINARY group has the same value; MySQL's ONLY_FULL_GROUP_BY refuses a bare column here
      `SELECT MIN(department) AS value, COUNT(*) AS users,
              SUM(department_id IS NOT NULL) AS already_linked
       FROM users GROUP BY BINARY department ORDER BY value`,
    )
    const [existing] = await connection.query('SELECT id, name FROM departments ORDER BY name')
    const [[totals]] = await connection.query(
      `SELECT COUNT(*) AS users,
              SUM(department IS NULL) AS null_value,
              SUM(department IS NOT NULL AND TRIM(department) = '') AS blank_value,
              SUM(department_id IS NOT NULL) AS already_linked
       FROM users`,
    )
    await connection.query('COMMIT')

    const nonEmpty = raw.filter((r) => clean(r.value) !== '')
    const groups = new Map()
    for (const row of nonEmpty) {
      const key = keyOf(row.value)
      if (!groups.has(key)) groups.set(key, { key, spellings: [] })
      groups.get(key).spellings.push({ value: row.value, users: Number(row.users), linked: Number(row.already_linked) })
    }
    for (const group of groups.values()) {
      // Most common spelling after trimming; on a tie, the first alphabetically
      const counts = new Map()
      for (const s of group.spellings) counts.set(clean(s.value), (counts.get(clean(s.value)) || 0) + s.users)
      group.name = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0]
      group.users = group.spellings.reduce((sum, s) => sum + s.users, 0)
      group.alreadyLinked = group.spellings.reduce((sum, s) => sum + s.linked, 0)
      group.reuses = existing.find((d) => collationKey(d.name) === collationKey(group.name))
    }

    const keys = [...groups.keys()]
    const nearDuplicates = []
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        const reason = nearDuplicateReason(keys[i], keys[j])
        if (reason) nearDuplicates.push([groups.get(keys[i]).name, groups.get(keys[j]).name, reason])
      }
    }
    const collisions = keys.filter((k, i) => keys.findIndex((o) => collationKey(o) === collationKey(k)) !== i)

    return { dbName, totals, raw, groups: [...groups.values()], existing, nearDuplicates, collisions }
  } finally {
    await connection.end()
  }
}

function print(r) {
  const q = (v) => (v === null ? 'NULL' : JSON.stringify(v))
  console.log(`Database: ${r.dbName}`)
  console.log(`Users: ${r.totals.users}, already linked to a department: ${Number(r.totals.already_linked)}\n`)

  console.log('1. Raw values (exact spelling) and how many users have each')
  for (const row of r.raw) console.log(`   ${q(row.value).padEnd(30)} ${row.users}`)

  console.log('\n2. Groups after normalization → the department name each would get')
  for (const g of r.groups) {
    const reuse = g.reuses ? `reuses existing department #${g.reuses.id} "${g.reuses.name}"` : 'new department'
    console.log(
      `   "${g.name}" (${g.users} users, ${reuse}${g.alreadyLinked ? `; ${g.alreadyLinked} already linked, left alone` : ''})`,
    )
    for (const s of g.spellings) console.log(`      ${q(s.value).padEnd(28)} ${s.users}`)
  }

  console.log('\n3. Likely near-duplicates (NOT merged unless you add them to the mapping)')
  if (r.nearDuplicates.length === 0) console.log('   none found')
  for (const [a, b, why] of r.nearDuplicates) console.log(`   "${a}"  ~  "${b}"   (${why})`)
  if (r.collisions.length)
    console.log(`   Groups the database would treat as one (accents): ${r.collisions.join(', ')}`)

  console.log('\n4. Users with no department value')
  console.log(`   NULL: ${Number(r.totals.null_value)}, empty or only spaces: ${Number(r.totals.blank_value)}`)

  console.log('\n5. Departments that already exist')
  if (r.existing.length === 0) console.log('   none')
  for (const d of r.existing) console.log(`   #${d.id} "${d.name}"`)
}

if (require.main === module) {
  report()
    .then(print)
    .catch((err) => {
      console.error('Report failed:', err.message)
      process.exitCode = 1
    })
}

module.exports = { report, clean, keyOf }
