// The demo seed: departments first, users linked by department_id, and running it twice makes no duplicates.
const pool = require('../src/db');
const { seed, departments } = require('../scripts/seed');
const { resetData } = require('./helpers');

// The seed prints a summary; keep the test output clean
async function quietSeed() {
  const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return await seed({ force: true });
  } finally {
    spy.mockRestore();
  }
}

afterEach(resetData); // leave the shared test database empty for the other test files (afterAll could run after the pool is closed)

test('creates the departments, links users by department_id, and leaves one empty and one user without', async () => {
  expect(await quietSeed()).toBe(true);

  const [rows] = await pool.query(
    `SELECT d.name, COUNT(u.id) AS users FROM departments d LEFT JOIN users u ON u.department_id = d.id
     GROUP BY d.id ORDER BY d.id`
  );
  expect(rows.map((r) => r.name)).toEqual(departments);
  expect(rows.find((r) => r.name === 'Operations').users).toBe(0);
  const [[{ withoutDepartment }]] = await pool.query(
    'SELECT COUNT(*) AS withoutDepartment FROM users WHERE department_id IS NULL'
  );
  expect(withoutDepartment).toBeGreaterThanOrEqual(1);

  // Nothing is written to the old free-text column any more
  const [[{ oldValues }]] = await pool.query('SELECT COUNT(*) AS oldValues FROM users WHERE department IS NOT NULL');
  expect(oldValues).toBe(0);
});

test('seeding twice gives the same departments, no duplicates', async () => {
  await quietSeed();
  await quietSeed();
  const [rows] = await pool.query('SELECT name FROM departments ORDER BY id');
  expect(rows.map((r) => r.name)).toEqual(departments);
});

test('an existing department with another letter case is reused, not duplicated', async () => {
  await quietSeed();
  // The upsert path, without the wipe: insert the seed's names again over existing (differently cased) rows
  await pool.query("UPDATE departments SET name = 'it' WHERE name = 'IT'");
  for (const name of departments) {
    await pool.query('INSERT INTO departments (name) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)', [name]);
  }
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM departments');
  expect(n).toBe(departments.length);
});

test('refuses to wipe a database that has users unless forced', async () => {
  await quietSeed();
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await seed({ force: false })).toBe(false);
  } finally {
    error.mockRestore();
    process.exitCode = 0;
  }
});
