// Shared by the test setup files: the test database's name rules and how to connect to the MySQL server.
// Tests only ever use a throwaway database named ticketflow_test_<timestamp>, never the real ticketflow database.

const TEST_DB_PREFIX = 'ticketflow_test_';

// Called before anything connects or drops: throws unless the name is clearly a throwaway test database
function assertTestDbName(name) {
  if (typeof name !== 'string' || !name.startsWith(TEST_DB_PREFIX) || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Refusing to run: the test database name must start with "${TEST_DB_PREFIX}", got "${name}"`);
  }
  return name;
}

// A new name for every run, so two runs at once never share (or drop) the same database
function newTestDbName() {
  return `${TEST_DB_PREFIX}${Date.now()}_${process.pid}`;
}

// Server settings (host, user, password) come from .env; the database name never does
function loadServerSettings() {
  require('dotenv').config({ quiet: true });
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  };
}

module.exports = { TEST_DB_PREFIX, assertTestDbName, newTestDbName, loadServerSettings };
