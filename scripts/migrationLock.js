// The name of the MySQL lock that keeps two migrations (or rollbacks) of the same database from running at once.
// One lock per database: GET_LOCK names are global to the whole MySQL server, so a single shared name made every
// migration wait for (or, with a 0 timeout, fail because of) migrations of unrelated databases on the same server,
// e.g. the test suite's throwaway databases while the e2e tests or a developer migrated theirs.
// MySQL and MariaDB allow at most 64 characters; a longer database name is shortened to a hash of it.
const crypto = require('crypto')

const PREFIX = 'ticketflow_migrate:'
const MAX_LENGTH = 64

function migrationLockName(dbName) {
  const name = `${PREFIX}${dbName}`
  if (name.length <= MAX_LENGTH) return name
  return `${PREFIX}${crypto
    .createHash('sha256')
    .update(dbName)
    .digest('hex')
    .slice(0, MAX_LENGTH - PREFIX.length)}`
}

module.exports = { migrationLockName }
