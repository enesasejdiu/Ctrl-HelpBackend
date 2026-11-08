// Migration 005 (free-text users.department → departments + users.department_id) on a database of its own, built
// with migrations 001–004 and filled with messy data. Also the verification queries that ship with the migration.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { migrate } = require('../scripts/migrate');
const { rollback } = require('../scripts/rollback');
const { assertTestDbName, loadServerSettings } = require('./testDb');
const { verify } = require('../scripts/verify-department-migration');

const FILE = '005_link_users_to_departments.sql';
const UP = fs.readFileSync(path.join(__dirname, '..', 'migrations', FILE), 'utf8');
const dbName = assertTestDbName(`${process.env.DB_NAME}_m005`);
const server = loadServerSettings();
let db;

// Every user: name, the old text value and the department name they're linked to (or null)
async function users() {
  const [rows] = await db.query(
    `SELECT u.name, u.department, d.name AS linked FROM users u LEFT JOIN departments d ON d.id = u.department_id ORDER BY u.id`
  );
  return rows;
}
async function departmentNames() {
  const [rows] = await db.query('SELECT name FROM departments ORDER BY id');
  return rows.map((r) => r.name);
}

// Runs 005 the way db:migrate does (and records it), optionally with explicit merges in its mapping table.
// Returns the summary row.
async function runMigration(mapping = {}) {
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

beforeAll(async () => {
  const log = console.log;
  console.log = () => {};
  try {
    await migrate({ dbName, backupFirst: false, until: '004' });
  } finally {
    console.log = log;
  }
  db = await mysql.createConnection({ ...server, database: dbName, multipleStatements: true });

  // A department that already exists, and the messy values from the spec
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
});

afterAll(async () => {
  if (db) await db.end();
  const connection = await mysql.createConnection(server);
  await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await connection.end();
});

// The tests below run in order on the same database: migrate, migrate again, verify, roll back
describe('migration 005', () => {
  test('creates the expected departments with the most common spelling, and reuses the existing one', async () => {
    const summary = await runMigration({ Slaes: 'Sales' });

    expect(await departmentNames()).toEqual(['Engineering', 'Sales', 'Sales Team']);
    expect(summary).toMatchObject({
      departments_created: 2,
      departments_reused: 1,
      users_linked: 7,
      users_without_department: 3,
    });
  });

  test('links every user correctly and leaves the already-linked user alone', async () => {
    expect(await users()).toEqual([
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

  test('the old text column is still there and unchanged', async () => {
    const [[column]] = await db.query("SHOW COLUMNS FROM users LIKE 'department'");
    expect(column).toBeDefined();
    expect((await users()).map((u) => u.department)).toContain(' sales ');
  });

  test('the verification queries all pass (with the same mapping)', async () => {
    const results = await verify(db, { Slaes: 'Sales' });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results).toHaveLength(4);
  });

  test('without the mapping entry, verification reports the user whose department differs', async () => {
    const results = await verify(db, {});
    const failed = results.filter((r) => !r.ok).map((r) => r.check);
    expect(failed).toEqual(["Every user's department matches their old value"]);
  });

  test('a second run changes nothing', async () => {
    const before = { users: await users(), departments: await departmentNames() };
    const summary = await runMigration({ Slaes: 'Sales' });
    expect(summary).toMatchObject({ departments_created: 0, departments_reused: 0, users_linked: 0 });
    expect({ users: await users(), departments: await departmentNames() }).toEqual(before);
  });

  test('the rollback restores the previous state; the department that existed before survives', async () => {
    // A user put into a migrated department later (not by 005): the rollback keeps them and that department
    await db.query("UPDATE users SET department_id = (SELECT id FROM departments WHERE name = 'Sales Team') WHERE name = 'Ela'");

    const log = console.log;
    console.log = () => {};
    try {
      await rollback({ dbName, backupFirst: false });
    } finally {
      console.log = log;
    }

    expect(await departmentNames()).toEqual(['Engineering', 'Sales Team']);
    const linked = Object.fromEntries((await users()).map((u) => [u.name, u.linked]));
    expect(linked).toEqual({
      Ana: null,
      Besa: null,
      Cen: null,
      Dua: null, // 005 gave Dua "Sales Team"; that is undone, but the department stays because Ela is in it
      Ela: 'Sales Team',
      Fis: null,
      Gent: null,
      Hana: null,
      Ilir: null,
      Jeta: null,
      Kujtim: 'Engineering',
    });
    const [tracking] = await db.query("SHOW TABLES LIKE 'department_migration_005'");
    expect(tracking).toHaveLength(0);
  });
});
