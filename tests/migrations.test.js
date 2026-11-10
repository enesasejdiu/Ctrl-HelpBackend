// Schema and migrations, each test on a throwaway database of its own (so no test depends on another):
//   * the schema the app relies on (roles, the new user columns, the department foreign key)
//   * up → down → up of every migration that has a rollback file
//   * migration 005 (free-text users.department → departments + users.department_id) on messy fixture data,
//     a second run, the rollback, and the verification queries that ship with it
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { migrate } = require('../scripts/migrate');
const { rollback } = require('../scripts/rollback');
const { verify } = require('../scripts/verify-department-migration');
const { assertTestDbName, loadServerSettings } = require('./testDb');

const FILE = '005_link_users_to_departments.sql';
const UP = fs.readFileSync(path.join(__dirname, '..', 'migrations', FILE), 'utf8');
const server = loadServerSettings();
const opened = [];
let dbCount = 0;

// migrate()/rollback() print progress; keep the test output clean
async function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

// A new database migrated up to `until` (all migrations if not given), and a connection to it
async function newDatabase(until) {
  dbCount += 1;
  const dbName = assertTestDbName(`${process.env.DB_NAME}_mig${dbCount}`);
  await quietly(() => migrate({ dbName, backupFirst: false, until }));
  const db = await mysql.createConnection({ ...server, database: dbName, multipleStatements: true });
  opened.push({ db, dbName });
  return { db, dbName };
}

afterAll(async () => {
  const connection = await mysql.createConnection(server);
  for (const { db, dbName } of opened) {
    await db.end();
    await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  }
  await connection.end();
});

describe('schema', () => {
  let db;
  beforeAll(async () => {
    ({ db } = await newDatabase());
  });
  const column = async (table, name) => {
    const [[row]] = await db.query(
      `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, name]
    );
    return row;
  };

  test('users.role has the hr role, next to employee, agent and admin', async () => {
    expect((await column('users', 'role')).type).toBe("enum('employee','agent','admin','hr')");
  });

  test('users.department_id is a nullable INT with a foreign key to departments, ON DELETE SET NULL', async () => {
    // MariaDB reports int(11), MySQL 8 just int
    expect(await column('users', 'department_id')).toMatchObject({
      type: expect.stringMatching(/^int(\(11\))?$/),
      nullable: 'YES',
    });
    const [[fk]] = await db.query(
      `SELECT k.REFERENCED_TABLE_NAME AS ref, k.REFERENCED_COLUMN_NAME AS refColumn, r.DELETE_RULE AS onDelete
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
       WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = 'users' AND k.COLUMN_NAME = 'department_id'`
    );
    expect(fk).toEqual({ ref: 'departments', refColumn: 'id', onDelete: 'SET NULL' });
  });

  test('users.job_title is a nullable string; last_login_at a nullable timestamp', async () => {
    expect(await column('users', 'job_title')).toMatchObject({ type: 'varchar(255)', nullable: 'YES' });
    expect(await column('users', 'last_login_at')).toMatchObject({ type: 'timestamp', nullable: 'YES' });
  });

  test('users.failed_login_count is a NOT NULL int, default 0; locked_until a nullable datetime (migration 006)', async () => {
    const count = await column('users', 'failed_login_count');
    // MySQL 8+ reports "int", MariaDB "int(11)"
    expect(count.type).toMatch(/^int(\(11\))?$/);
    expect(count).toMatchObject({ nullable: 'NO' });
    expect(String(count.dflt)).toBe('0');
    expect(await column('users', 'locked_until')).toMatchObject({ type: 'datetime', nullable: 'YES' });
  });

  test('users.session_version is a NOT NULL int, default 0 (migration 007)', async () => {
    const version = await column('users', 'session_version');
    // MySQL 8+ reports "int", MariaDB "int(11)"
    expect(version.type).toMatch(/^int(\(11\))?$/);
    expect(version).toMatchObject({ nullable: 'NO' });
    expect(String(version.dflt)).toBe('0');
  });

  test('users.must_change_password is NOT NULL with default false', async () => {
    const row = await column('users', 'must_change_password');
    expect(row).toMatchObject({ type: 'tinyint(1)', nullable: 'NO' });
    expect(String(row.dflt)).toBe('0');
  });

  test('departments.name is unique regardless of letter case', async () => {
    await db.query("INSERT INTO departments (name) VALUES ('Sales')");
    await expect(db.query("INSERT INTO departments (name) VALUES ('SALES')")).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });
});

describe('up → down → up', () => {
  // 001 and 002 have no rollback file (db:rollback refuses them), so the round trip covers 007 down to 003
  test('rolling back 007, 006, 005, 004 and 003, then migrating again, gives back the same schema', async () => {
    const { db, dbName } = await newDatabase();
    const schema = async () => {
      const tables = {};
      const [rows] = await db.query('SHOW TABLES');
      for (const name of rows.map((r) => Object.values(r)[0]).sort()) {
        const [[create]] = await db.query(`SHOW CREATE TABLE \`${name}\``);
        tables[name] = create['Create Table'].replace(/ AUTO_INCREMENT=\d+/, '');
      }
      delete tables.schema_migrations;
      return tables;
    };
    const applied = async () => (await db.query('SELECT filename FROM schema_migrations ORDER BY filename'))[0].map((r) => r.filename);

    const before = await schema();
    for (let i = 0; i < 5; i += 1) await quietly(() => rollback({ dbName, backupFirst: false }));
    expect(await applied()).toEqual(['001_initial.sql', '002_hr_role_and_password_change.sql']);
    const [departments] = await db.query("SHOW TABLES LIKE 'departments'");
    expect(departments).toHaveLength(0);

    await quietly(() => migrate({ dbName, backupFirst: false }));
    expect(await schema()).toEqual(before);
    expect((await applied()).at(-1)).toBe('007_session_version.sql');
  });

  test('a migration without a rollback file is refused, not half-undone', async () => {
    const { dbName } = await newDatabase('002');
    await expect(quietly(() => rollback({ dbName, backupFirst: false }))).rejects.toThrow(/has no rollback file/);
  });
});

describe('migration 005 on messy data', () => {
  // A database at 004 with a pre-existing department and the messy values from the spec. Returns its connection.
  async function fixture() {
    const { db, dbName } = await newDatabase('004');
    await db.query("INSERT INTO departments (name) VALUES ('Engineering')");
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
    ];
    for (const [name, department] of values) {
      await db.query('INSERT INTO users (name, email, password_hash, department) VALUES (?, ?, ?, ?)', [
        name,
        `${name.toLowerCase()}@test.local`,
        'x',
        department,
      ]);
    }
    // Already linked (to Engineering), with a text value that would otherwise mean Sales
    await db.query(
      "INSERT INTO users (name, email, password_hash, department, department_id) VALUES ('Kujtim', 'kujtim@test.local', 'x', 'Sales', 1)"
    );
    return { db, dbName };
  }

  // Runs 005 the way db:migrate does (and records it), with explicit merges in its mapping table. Returns the summary.
  async function runMigration(db, mapping = { Slaes: 'Sales' }) {
    await db.query(
      `CREATE TEMPORARY TABLE IF NOT EXISTS department_mapping_005 (from_name VARCHAR(100) PRIMARY KEY, to_name VARCHAR(100) NOT NULL)
       DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    for (const [from, to] of Object.entries(mapping)) {
      await db.query('INSERT INTO department_mapping_005 (from_name, to_name) VALUES (?, ?)', [from, to]);
    }
    const [results] = await db.query(UP);
    await db.query('INSERT IGNORE INTO schema_migrations (filename, checksum) VALUES (?, ?)', [FILE, 'test']);
    return results.filter(Array.isArray).flat().find((row) => row.summary);
  }

  async function users(db) {
    const [rows] = await db.query(
      'SELECT u.name, u.department, d.name AS linked FROM users u LEFT JOIN departments d ON d.id = u.department_id ORDER BY u.id'
    );
    return rows;
  }
  async function departmentNames(db) {
    const [rows] = await db.query('SELECT name FROM departments ORDER BY id');
    return rows.map((r) => r.name);
  }

  test('creates the expected departments with the most common spelling, and reuses the existing one', async () => {
    const { db } = await fixture();
    const summary = await runMigration(db);
    expect(await departmentNames(db)).toEqual(['Engineering', 'Sales', 'Sales Team']);
    expect(summary).toMatchObject({ departments_created: 2, departments_reused: 1, users_linked: 7, users_without_department: 3 });
  });

  test('links every user correctly, leaves the already-linked user alone, and keeps the old text', async () => {
    const { db } = await fixture();
    await runMigration(db);
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
    ]);
  });

  test('without the mapping entry, "Slaes" becomes its own department (nothing is merged by guessing)', async () => {
    const { db } = await fixture();
    await runMigration(db, {});
    expect(await departmentNames(db)).toEqual(['Engineering', 'Sales', 'Sales Team', 'Slaes']);
  });

  test('the verification queries pass with the same mapping, and catch a wrong link without it', async () => {
    const { db } = await fixture();
    await runMigration(db);
    expect((await verify(db, { Slaes: 'Sales' })).filter((r) => !r.ok)).toEqual([]);
    const failed = (await verify(db, {})).filter((r) => !r.ok).map((r) => r.check);
    expect(failed).toEqual(["Every user's department matches their old value"]);
  });

  test('a second run changes nothing', async () => {
    const { db } = await fixture();
    await runMigration(db);
    const before = { users: await users(db), departments: await departmentNames(db) };
    const summary = await runMigration(db);
    expect(summary).toMatchObject({ departments_created: 0, departments_reused: 0, users_linked: 0 });
    expect({ users: await users(db), departments: await departmentNames(db) }).toEqual(before);
  });

  test('the rollback restores the previous state; the department that existed before survives', async () => {
    const { db, dbName } = await fixture();
    const before = { users: await users(db), departments: await departmentNames(db) };
    await runMigration(db);
    await quietly(() => rollback({ dbName, backupFirst: false }));

    expect({ users: await users(db), departments: await departmentNames(db) }).toEqual(before);
    const [tracking] = await db.query("SHOW TABLES LIKE 'department_migration_005'");
    expect(tracking).toHaveLength(0);
  });

  test('the rollback keeps a later change: a user put into a migrated department afterwards stays, and so does it', async () => {
    const { db, dbName } = await fixture();
    await runMigration(db);
    await db.query("UPDATE users SET department_id = (SELECT id FROM departments WHERE name = 'Sales Team') WHERE name = 'Ela'");
    await quietly(() => rollback({ dbName, backupFirst: false }));

    expect(await departmentNames(db)).toEqual(['Engineering', 'Sales Team']);
    const linked = Object.fromEntries((await users(db)).map((u) => [u.name, u.linked]));
    expect(linked).toMatchObject({ Dua: null, Ela: 'Sales Team', Kujtim: 'Engineering', Ana: null });
  });
});
