// The safety check every suite that creates test data runs first (in a beforeAll): the database the pool is really
// connected to must be a throwaway ticketflow_test_* database on a local or CI server. Anything else throws, and the
// suite stops before it writes a single row. This never runs db:seed and never touches the real ticketflow database.
const pool = require('../../src/db')
const { assertTestDbName } = require('../testDb')

// Local servers, and the CI service container (127.0.0.1). TEST_DB_ALLOWED_HOSTS (comma-separated) adds more, e.g. a
// throwaway Docker host.
const ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1']

function allowedHosts(env = process.env) {
  const extra = (env.TEST_DB_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
  return [...ALLOWED_HOSTS, ...extra]
}

// Throws unless DB_NAME, DB_HOST and the server's own idea of the current database are all the throwaway one
async function assertThrowawayDb() {
  const name = assertTestDbName(process.env.DB_NAME)
  const host = String(process.env.DB_HOST ?? 'localhost')
    .trim()
    .toLowerCase()
  if (!allowedHosts().includes(host)) {
    throw new Error(
      `Refusing to run: DB_HOST "${host}" is not a local or CI test server (allowed: ${allowedHosts().join(', ')}; ` +
        'add a throwaway host with TEST_DB_ALLOWED_HOSTS)',
    )
  }
  const [[{ current }]] = await pool.query('SELECT DATABASE() AS current')
  if (current !== name) {
    throw new Error(`Refusing to run: connected to database "${current}", expected the test database "${name}"`)
  }
  return { name, host }
}

module.exports = { assertThrowawayDb, allowedHosts }
