// Runs once after all test files, also when tests fail: drops the test database created by globalSetup.js.
const mysql = require('mysql2/promise');
const { assertTestDbName, loadServerSettings } = require('./testDb');

module.exports = async function globalTeardown() {
  if (!process.env.TEST_DB_NAME) return; // setup never got as far as choosing a name
  const dbName = assertTestDbName(process.env.TEST_DB_NAME); // never drop anything that isn't a test database

  const connection = await mysql.createConnection(loadServerSettings());
  try {
    // The name passed assertTestDbName (letters, digits, _ only), so it is safe inside backticks
    await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  } finally {
    await connection.end();
  }
};
