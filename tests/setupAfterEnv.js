// Jest setupFilesAfterEnv: closes this test file's MySQL pool when its tests finish, so Jest exits cleanly
// (no "open handles" warning). Each test file gets its own copy of src/db.js, so each closes its own pool.
const pool = require('../src/db');

afterAll(async () => {
  await pool.end();
});
