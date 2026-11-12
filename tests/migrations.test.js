// Schema and migrations, each test on a throwaway database of its own (so no test depends on another):
//   * the schema the app relies on (roles, the new user columns, the department foreign key)
//   * up → down → up of every migration that has a rollback file
//   * migration 005 (free-text users.department → departments + users.department_id) on messy fixture data,
//     a second run, the rollback, and the verification queries that ship with it
const fs = require('fs')
const path = require('path')
const mysql = require('mysql2/promise')
const { migrate } = require('../scripts/migrate')
const { rollback } = require('../scripts/rollback')
const { verify } = require('../scripts/verify-department-migration')
const { migrationLockName } = require('../scripts/migrationLock')
const { assertTestDbName, loadServerSettings } = require('./testDb')

const FILE = '005_link_users_to_departments.sql'
const UP = fs.readFileSync(path.join(__dirname, '..', 'migrations', FILE), 'utf8')
const server = loadServerSettings()
const opened = []
let dbCount = 0

// migrate()/rollback() print progress; keep the test output clean
async function quietly(fn) {
  const log = console.log
  console.log = () => {}
  try {
    return await fn()
  } finally {
    console.log = log
  }
}

// A new database migrated up to `until` (all migrations if not given), and a connection to it
async function newDatabase(until) {
  dbCount += 1
  const dbName = assertTestDbName(`${process.env.DB_NAME}_mig${dbCount}`)
  await quietly(() => migrate({ dbName, backupFirst: false, until }))
  const db = await mysql.createConnection({ ...server, database: dbName, multipleStatements: true })
  opened.push({ db, dbName })
  return { db, dbName }
}

afterAll(async () => {
  const connection = await mysql.createConnection(server)
  for (const { db, dbName } of opened) {
    await db.end()
    await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``)
  }
  await connection.end()
})

describe('schema', () => {
  let db
  beforeAll(async () => {
    ;({ db } = await newDatabase())
  })
  const column = async (table, name) => {
    const [[row]] = await db.query(
      `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, name],
    )
    return row
  }

  test('users.role has the hr role, next to employee, agent and admin', async () => {
    expect((await column('users', 'role')).type).toBe("enum('employee','agent','admin','hr')")
  })

  test('users.department_id is a nullable INT with a foreign key to departments, ON DELETE SET NULL', async () => {
    // MariaDB reports int(11), MySQL 8 just int
    expect(await column('users', 'department_id')).toMatchObject({
      type: expect.stringMatching(/^int(\(11\))?$/),
      nullable: 'YES',
    })
    const [[fk]] = await db.query(
      `SELECT k.REFERENCED_TABLE_NAME AS ref, k.REFERENCED_COLUMN_NAME AS refColumn, r.DELETE_RULE AS onDelete
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
       WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = 'users' AND k.COLUMN_NAME = 'department_id'`,
    )
    expect(fk).toEqual({ ref: 'departments', refColumn: 'id', onDelete: 'SET NULL' })
  })

  test('users.job_title is a nullable string; last_login_at a nullable timestamp', async () => {
    expect(await column('users', 'job_title')).toMatchObject({ type: 'varchar(255)', nullable: 'YES' })
    expect(await column('users', 'last_login_at')).toMatchObject({ type: 'timestamp', nullable: 'YES' })
  })

  test('users.failed_login_count is a NOT NULL int, default 0; locked_until a nullable datetime (migration 006)', async () => {
    const count = await column('users', 'failed_login_count')
    // MySQL 8+ reports "int", MariaDB "int(11)"
    expect(count.type).toMatch(/^int(\(11\))?$/)
    expect(count).toMatchObject({ nullable: 'NO' })
    expect(String(count.dflt)).toBe('0')
    expect(await column('users', 'locked_until')).toMatchObject({ type: 'datetime', nullable: 'YES' })
  })

  test('users.session_version is a NOT NULL int, default 0 (migration 007)', async () => {
    const version = await column('users', 'session_version')
    // MySQL 8+ reports "int", MariaDB "int(11)"
    expect(version.type).toMatch(/^int(\(11\))?$/)
    expect(version).toMatchObject({ nullable: 'NO' })
    expect(String(version.dflt)).toBe('0')
  })

  test('password_tokens stores a unique 64-character hash and a purpose per token, deleted with its user (migrations 010, 011)', async () => {
    expect(await column('password_tokens', 'token_hash')).toMatchObject({ type: 'char(64)', nullable: 'NO' })
    expect(await column('password_tokens', 'purpose')).toMatchObject({ type: "enum('setup','reset')", nullable: 'NO' })
    expect(await column('password_tokens', 'expires_at')).toMatchObject({ type: 'datetime', nullable: 'NO' })
    expect(await column('password_tokens', 'used_at')).toMatchObject({ type: 'datetime', nullable: 'YES' })
    const [{ insertId: userId }] = await db.query(
      "INSERT INTO users (name, email, password_hash) VALUES ('T', 't.tokens@test.local', 'x')",
    )
    const hash = 'a'.repeat(64)
    await db.query('INSERT INTO password_tokens (user_id, token_hash, expires_at) VALUES (?, ?, NOW())', [userId, hash])
    await expect(
      db.query('INSERT INTO password_tokens (user_id, token_hash, expires_at) VALUES (?, ?, NOW())', [userId, hash]),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' })
    await db.query('DELETE FROM users WHERE id = ?', [userId])
    const [left] = await db.query('SELECT id FROM password_tokens WHERE user_id = ?', [userId])
    expect(left).toHaveLength(0)
  })

  test('users.must_change_password is NOT NULL with default false', async () => {
    const row = await column('users', 'must_change_password')
    expect(row).toMatchObject({ type: 'tinyint(1)', nullable: 'NO' })
    expect(String(row.dflt)).toBe('0')
  })

  test('departments.name is unique regardless of letter case', async () => {
    await db.query("INSERT INTO departments (name) VALUES ('Sales')")
    await expect(db.query("INSERT INTO departments (name) VALUES ('SALES')")).rejects.toMatchObject({
      code: 'ER_DUP_ENTRY',
    })
  })
})

describe('up → down → up', () => {
  // 001 and 002 have no rollback file (db:rollback refuses them), so the round trip covers 016 down to 003
  test('rolling back 016, 015, 012, 011, 010, 009, 008, 007, 006, 005, 004 and 003, then migrating again, gives back the same schema', async () => {
    const { db, dbName } = await newDatabase()
    const schema = async () => {
      const tables = {}
      const [rows] = await db.query('SHOW TABLES')
      for (const name of rows.map((r) => Object.values(r)[0]).sort()) {
        const [[create]] = await db.query(`SHOW CREATE TABLE \`${name}\``)
        tables[name] = create['Create Table'].replace(/ AUTO_INCREMENT=\d+/, '')
      }
      delete tables.schema_migrations
      return tables
    }
    const applied = async () =>
      (await db.query('SELECT filename FROM schema_migrations ORDER BY filename'))[0].map((r) => r.filename)

    const before = await schema()
    for (let i = 0; i < 12; i += 1) await quietly(() => rollback({ dbName, backupFirst: false }))
    expect(await applied()).toEqual(['001_initial.sql', '002_hr_role_and_password_change.sql'])
    const [departments] = await db.query("SHOW TABLES LIKE 'departments'")
    expect(departments).toHaveLength(0)
    for (const table of ['password_setup_tokens', 'password_tokens', 'attachments', 'settings']) {
      const [tokens] = await db.query(`SHOW TABLES LIKE '${table}'`)
      expect(tokens).toHaveLength(0)
    }

    await quietly(() => migrate({ dbName, backupFirst: false }))
    expect(await schema()).toEqual(before)
    expect((await applied()).at(-1)).toBe('016_auto_close.sql')
  })

  test('011 keeps the links issued under 010 as setup links; rolling it back drops only reset links', async () => {
    const { db, dbName } = await newDatabase('010')
    const [{ insertId: userId }] = await db.query(
      "INSERT INTO users (name, email, password_hash) VALUES ('T', 't.011@test.local', 'x')",
    )
    await db.query('INSERT INTO password_setup_tokens (user_id, token_hash, expires_at) VALUES (?, ?, NOW())', [
      userId,
      'b'.repeat(64),
    ])

    // Only up to 011, so the rollback below undoes 011 (not a later migration)
    await quietly(() => migrate({ dbName, backupFirst: false, until: '011' }))
    const [[kept]] = await db.query('SELECT purpose FROM password_tokens WHERE user_id = ?', [userId])
    expect(kept.purpose).toBe('setup')

    await db.query(
      "INSERT INTO password_tokens (user_id, token_hash, purpose, expires_at) VALUES (?, ?, 'reset', NOW())",
      [userId, 'c'.repeat(64)],
    )
    await quietly(() => rollback({ dbName, backupFirst: false }))
    const [left] = await db.query('SELECT token_hash FROM password_setup_tokens WHERE user_id = ?', [userId])
    expect(left.map((r) => r.token_hash)).toEqual(['b'.repeat(64)])
  })

  test('016 backfills a resolved ticket without resolved_at from its history, else the migration time, never updated_at', async () => {
    const { db, dbName } = await newDatabase('015')
    const [{ insertId: userId }] = await db.query(
      "INSERT INTO users (name, email, password_hash) VALUES ('T', 't.016@test.local', 'x')",
    )
    const [[{ c }]] = await db.query('SELECT MIN(id) AS c FROM categories')
    const [[{ p }]] = await db.query('SELECT MIN(id) AS p FROM priorities')
    const longAgo = '2026-01-10 09:30:00'
    const insertTicket = async (title, status, resolvedAt) => {
      const [{ insertId }] = await db.query(
        `INSERT INTO tickets (title, description, requester_id, category_id, priority_id, status, resolved_at, updated_at)
         VALUES (?, 'd', ?, ?, ?, ?, ?, ?)`,
        [title, userId, c, p, status, resolvedAt, longAgo],
      )
      return insertId
    }
    const withHistory = await insertTicket('history', 'resolved', null)
    const without = await insertTicket('no history', 'resolved', null)
    const alreadySet = await insertTicket('set', 'resolved', '2026-03-01 08:00:00')
    const notResolved = await insertTicket('open', 'open', null)
    await db.query(
      "INSERT INTO ticket_history (ticket_id, changed_by, field_changed, old_value, new_value, changed_at) VALUES (?, ?, 'status', 'in_progress', 'resolved', '2026-02-02 10:00:00')",
      [withHistory, userId],
    )

    const before = new Date(Date.now() - 2000)
    await quietly(() => migrate({ dbName, backupFirst: false }))
    const resolvedAt = async (id) =>
      (await db.query('SELECT resolved_at FROM tickets WHERE id = ?', [id]))[0][0].resolved_at
    const fmt = (d) => d && d.toISOString()

    expect(fmt(await resolvedAt(withHistory))).toBe(fmt(new Date('2026-02-02 10:00:00')))
    expect((await resolvedAt(without)).getTime()).toBeGreaterThanOrEqual(before.getTime()) // the migration time
    expect(fmt(await resolvedAt(without))).not.toBe(fmt(new Date(longAgo))) // never updated_at
    expect(fmt(await resolvedAt(alreadySet))).toBe(fmt(new Date('2026-03-01 08:00:00'))) // left as it was
    expect(await resolvedAt(notResolved)).toBeNull()
    const [[setting]] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'auto_close_days'")
    expect(setting.setting_value).toBe('7')
  })

  test('a migration without a rollback file is refused, not half-undone', async () => {
    const { dbName } = await newDatabase('002')
    await expect(quietly(() => rollback({ dbName, backupFirst: false }))).rejects.toThrow(/has no rollback file/)
  })
})

describe('migration 005 on messy data', () => {
  // A database at 004 with a pre-existing department and the messy values from the spec. Returns its connection.
  async function fixture() {
    const { db, dbName } = await newDatabase('004')
    await db.query("INSERT INTO departments (name) VALUES ('Engineering')")
    const values = [
      ['Ana', 'Sales'],
      ['Besa', ' sales '],
      ['Cen', 'SALES'],
      ['Dua', 'Sales  Team'],
      ['Ela', ''],
      ['Fis', null],
      ['Gent', '   '],
      ['Hana', 'Slaes'],
      ['Ilir', 'engineering'],
      ['Jeta', 'Sales'],
    ]
    for (const [name, department] of values) {
      await db.query('INSERT INTO users (name, email, password_hash, department) VALUES (?, ?, ?, ?)', [
        name,
        `${name.toLowerCase()}@test.local`,
        'x',
        department,
      ])
    }
    // Already linked (to Engineering), with a text value that would otherwise mean Sales
    await db.query(
      "INSERT INTO users (name, email, password_hash, department, department_id) VALUES ('Kujtim', 'kujtim@test.local', 'x', 'Sales', 1)",
    )
    return { db, dbName }
  }

  // Runs 005 the way db:migrate does (and records it), with explicit merges in its mapping table. Returns the summary.
  async function runMigration(db, mapping = { Slaes: 'Sales' }) {
    await db.query(
      `CREATE TEMPORARY TABLE IF NOT EXISTS department_mapping_005 (from_name VARCHAR(100) PRIMARY KEY, to_name VARCHAR(100) NOT NULL)
       DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    )
    for (const [from, to] of Object.entries(mapping)) {
      await db.query('INSERT INTO department_mapping_005 (from_name, to_name) VALUES (?, ?)', [from, to])
    }
    const [results] = await db.query(UP)
    await db.query('INSERT IGNORE INTO schema_migrations (filename, checksum) VALUES (?, ?)', [FILE, 'test'])
    return results
      .filter(Array.isArray)
      .flat()
      .find((row) => row.summary)
  }

  async function users(db) {
    const [rows] = await db.query(
      'SELECT u.name, u.department, d.name AS linked FROM users u LEFT JOIN departments d ON d.id = u.department_id ORDER BY u.id',
    )
    return rows
  }
  async function departmentNames(db) {
    const [rows] = await db.query('SELECT name FROM departments ORDER BY id')
    return rows.map((r) => r.name)
  }

  test('creates the expected departments with the most common spelling, and reuses the existing one', async () => {
    const { db } = await fixture()
    const summary = await runMigration(db)
    expect(await departmentNames(db)).toEqual(['Engineering', 'Sales', 'Sales Team'])
    expect(summary).toMatchObject({
      departments_created: 2,
      departments_reused: 1,
      users_linked: 7,
      users_without_department: 3,
    })
  })

  test('links every user correctly, leaves the already-linked user alone, and keeps the old text', async () => {
    const { db } = await fixture()
    await runMigration(db)
    expect(await users(db)).toEqual([
      { name: 'Ana', department: 'Sales', linked: 'Sales' },
      { name: 'Besa', department: ' sales ', linked: 'Sales' },
      { name: 'Cen', department: 'SALES', linked: 'Sales' },
      { name: 'Dua', department: 'Sales  Team', linked: 'Sales Team' },
      { name: 'Ela', department: '', linked: null },
      { name: 'Fis', department: null, linked: null },
      { name: 'Gent', department: '   ', linked: null },
      { name: 'Hana', department: 'Slaes', linked: 'Sales' }, // through the mapping
      { name: 'Ilir', department: 'engineering', linked: 'Engineering' },
      { name: 'Jeta', department: 'Sales', linked: 'Sales' },
      { name: 'Kujtim', department: 'Sales', linked: 'Engineering' }, // untouched
    ])
  })

  test('without the mapping entry, "Slaes" becomes its own department (nothing is merged by guessing)', async () => {
    const { db } = await fixture()
    await runMigration(db, {})
    expect(await departmentNames(db)).toEqual(['Engineering', 'Sales', 'Sales Team', 'Slaes'])
  })

  test('the verification queries pass with the same mapping, and catch a wrong link without it', async () => {
    const { db } = await fixture()
    await runMigration(db)
    expect((await verify(db, { Slaes: 'Sales' })).filter((r) => !r.ok)).toEqual([])
    const failed = (await verify(db, {})).filter((r) => !r.ok).map((r) => r.check)
    expect(failed).toEqual(["Every user's department matches their old value"])
  })

  test('a second run changes nothing', async () => {
    const { db } = await fixture()
    await runMigration(db)
    const before = { users: await users(db), departments: await departmentNames(db) }
    const summary = await runMigration(db)
    expect(summary).toMatchObject({ departments_created: 0, departments_reused: 0, users_linked: 0 })
    expect({ users: await users(db), departments: await departmentNames(db) }).toEqual(before)
  })

  test('the rollback restores the previous state; the department that existed before survives', async () => {
    const { db, dbName } = await fixture()
    const before = { users: await users(db), departments: await departmentNames(db) }
    await runMigration(db)
    await quietly(() => rollback({ dbName, backupFirst: false }))

    expect({ users: await users(db), departments: await departmentNames(db) }).toEqual(before)
    const [tracking] = await db.query("SHOW TABLES LIKE 'department_migration_005'")
    expect(tracking).toHaveLength(0)
  })

  test('the rollback keeps a later change: a user put into a migrated department afterwards stays, and so does it', async () => {
    const { db, dbName } = await fixture()
    await runMigration(db)
    await db.query(
      "UPDATE users SET department_id = (SELECT id FROM departments WHERE name = 'Sales Team') WHERE name = 'Ela'",
    )
    await quietly(() => rollback({ dbName, backupFirst: false }))

    expect(await departmentNames(db)).toEqual(['Engineering', 'Sales Team'])
    const linked = Object.fromEntries((await users(db)).map((u) => [u.name, u.linked]))
    expect(linked).toMatchObject({ Dua: null, Ela: 'Sales Team', Kujtim: 'Engineering', Ana: null })
  })
})

describe('the migration lock (one per database)', () => {
  // Holds the lock for a database name on a separate connection, like a migration running in another process
  async function holdLock(name) {
    const holder = await mysql.createConnection(server)
    const [[{ locked }]] = await holder.query('SELECT GET_LOCK(?, 0) AS locked', [migrationLockName(name)])
    expect(locked).toBe(1)
    return holder
  }

  test('a migration of another database on the same server never gets in the way', async () => {
    const holder = await holdLock('ticketflow_someone_else')
    try {
      // The old single server-wide lock made this throw "Another db:migrate is running"
      await expect(newDatabase()).resolves.toBeDefined()
    } finally {
      await holder.end()
    }
  })

  test('two migrations of the same database still exclude each other', async () => {
    dbCount += 1
    const dbName = assertTestDbName(`${process.env.DB_NAME}_mig${dbCount}`)
    opened.push({ db: { end: async () => {} }, dbName })
    const holder = await holdLock(dbName)
    try {
      await expect(quietly(() => migrate({ dbName, backupFirst: false }))).rejects.toThrow(
        `Another db:migrate is running on "${dbName}"`,
      )
    } finally {
      await holder.end()
    }
  })

  test('a rollback uses the same per-database lock', async () => {
    const { dbName } = await newDatabase()
    const holder = await holdLock(dbName)
    try {
      await expect(quietly(() => rollback({ dbName, backupFirst: false }))).rejects.toThrow(
        `Another db:migrate or db:rollback is running on "${dbName}"`,
      )
    } finally {
      await holder.end()
    }
  })

  test('lock names fit MySQL and MariaDB (64 characters), and different databases never share one', () => {
    expect(migrationLockName('ticketflow')).toBe('ticketflow_migrate:ticketflow')
    const long = 'ticketflow_test_' + 'x'.repeat(80)
    expect(migrationLockName(long).length).toBeLessThanOrEqual(64)
    expect(migrationLockName(long)).not.toBe(migrationLockName(long + 'y'))
  })
})

describe('migration 015 (admin settings)', () => {
  const reference = require('../scripts/reference-data')
  const rows = async (db, sql) => (await db.query(sql))[0]
  // These look at 015 on its own, so their databases stop there (016 adds a setting of its own)
  const newDatabase015 = () => newDatabase('015')

  test('a fresh database gets the standard categories and priorities, Medium as the default, and the company name', async () => {
    const { db } = await newDatabase015()
    const categories = await rows(
      db,
      'SELECT name, description, sort_order, is_active FROM categories ORDER BY sort_order',
    )
    expect(categories).toEqual(
      reference.categories.map(([name, description], i) => ({ name, description, sort_order: i + 1, is_active: 1 })),
    )
    const priorities = await rows(
      db,
      'SELECT name, level, target_hours, is_default, is_active FROM priorities ORDER BY level',
    )
    expect(priorities).toEqual(
      reference.priorities.map(([name, level, hours]) => ({
        name,
        level,
        target_hours: hours,
        is_default: name === reference.defaultPriority ? 1 : 0,
        is_active: 1,
      })),
    )
    expect(await rows(db, 'SELECT setting_key, setting_value FROM settings')).toEqual([
      { setting_key: 'company_name', setting_value: 'TicketFlow' },
    ])
  })

  // A database from before 015, with its own lists and tickets using them
  async function before015() {
    const { db, dbName } = await newDatabase('012')
    await db.query(`
      INSERT INTO categories (name) VALUES ('Zeta'), ('Alpha'), ('Mid');
      INSERT INTO priorities (name, level, target_hours) VALUES ('Lowest', 1, 200), ('Normal', 2, 50), ('Urgent', 3, 2);
      INSERT INTO users (name, email, password_hash) VALUES ('T', 't.015@test.local', 'x');`)
    const [[user]] = await db.query("SELECT id FROM users WHERE email = 't.015@test.local'")
    for (const [category, priority] of [
      ['Zeta', 'Urgent'],
      ['Alpha', 'Lowest'],
      ['Mid', 'Normal'],
      ['Alpha', 'Urgent'],
    ]) {
      await db.query(
        `INSERT INTO tickets (title, description, requester_id, category_id, priority_id)
         SELECT 'T', 'D', ?, c.id, p.id FROM categories c, priorities p WHERE c.name = ? AND p.name = ?`,
        [user.id, category, priority],
      )
    }
    const links = () =>
      rows(
        db,
        'SELECT t.id, c.name AS category, p.name AS priority FROM tickets t JOIN categories c ON c.id = t.category_id JOIN priorities p ON p.id = t.priority_id ORDER BY t.id',
      )
    return { db, dbName, links, linksBefore: await links() }
  }

  test('an existing database keeps its own lists (no standard rows added) and every ticket keeps its links', async () => {
    const { db, dbName, links, linksBefore } = await before015()
    await quietly(() => migrate({ dbName, backupFirst: false }))
    expect(linksBefore).toHaveLength(4)
    expect(await links()).toEqual(linksBefore)
    expect(
      await rows(
        db,
        'SELECT COUNT(*) AS n FROM tickets t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN priorities p ON p.id = t.priority_id WHERE c.id IS NULL OR p.id IS NULL',
      ),
    ).toEqual([{ n: 0 }])
    // Its own names only, ordered by name as before; ranks keep the meaning order
    expect(await rows(db, 'SELECT name, sort_order FROM categories ORDER BY sort_order')).toEqual([
      { name: 'Alpha', sort_order: 1 },
      { name: 'Mid', sort_order: 2 },
      { name: 'Zeta', sort_order: 3 },
    ])
    // No "Medium": the second rank becomes the default
    expect(await rows(db, 'SELECT name, level, is_default FROM priorities ORDER BY level')).toEqual([
      { name: 'Lowest', level: 1, is_default: 0 },
      { name: 'Normal', level: 2, is_default: 1 },
      { name: 'Urgent', level: 3, is_default: 0 },
    ])
  })

  test('at most one default and unique ranks, enforced by the database', async () => {
    const { db } = await newDatabase015()
    await expect(db.query("UPDATE priorities SET is_default = TRUE WHERE name = 'High'")).rejects.toMatchObject({
      code: 'ER_DUP_ENTRY',
    })
    await expect(db.query("UPDATE priorities SET level = 1 WHERE name = 'High'")).rejects.toMatchObject({
      code: 'ER_DUP_ENTRY',
    })
  })

  test('rolling it back keeps every category, priority and ticket link; migrating again works', async () => {
    const { db, dbName, links, linksBefore } = await before015()
    await quietly(() => migrate({ dbName, backupFirst: false, until: '015' }))
    await quietly(() => rollback({ dbName, backupFirst: false }))
    expect(await links()).toEqual(linksBefore)
    expect(await rows(db, "SHOW TABLES LIKE 'settings'")).toHaveLength(0)
    const columns = (await rows(db, 'SHOW COLUMNS FROM priorities')).map((c) => c.Field)
    expect(columns).toEqual(['id', 'name', 'level', 'target_hours'])
    await quietly(() => migrate({ dbName, backupFirst: false }))
    expect(await links()).toEqual(linksBefore)
    expect(await rows(db, 'SELECT COUNT(*) AS n FROM priorities WHERE is_default')).toEqual([{ n: 1 }])
  })
})
