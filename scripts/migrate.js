// Brings the database up to date: applies the files in migrations/ that it hasn't run yet, in number order.
// Creates the database if it's missing, and never touches migrations that are already applied, so existing data
// stays. Applied files are recorded in the schema_migrations table. Usage: npm run db:migrate
// tests/globalSetup.js imports migrate() to build its throwaway test database with these same migrations.
require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { backup } = require('./backup-db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const FILE_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;

function readMigrations() {
  const numbers = new Set();
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();

  return files.map((file) => {
    const match = file.match(FILE_NAME);
    if (!match) {
      throw new Error(`${file} has the wrong name. Use the form 002_add_something.sql`);
    }
    if (numbers.has(match[1])) {
      throw new Error(`Two migrations use the number ${match[1]}. Renumber the one that isn't applied yet`);
    }
    numbers.add(match[1]);

    // Same line endings everywhere, so a Windows checkout doesn't count as an edited file
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').replace(/\r\n/g, '\n');
    return { file, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
  });
}

// Returns the migrations to run, or throws if the files no longer match what this database has run
function findPending(migrations, applied) {
  const byFile = new Map(migrations.map((migration) => [migration.file, migration]));

  for (const row of applied) {
    const migration = byFile.get(row.filename);
    if (!migration) {
      throw new Error(`${row.filename} was applied to this database but the file is missing. Update the code first`);
    }
    if (migration.checksum !== row.checksum) {
      throw new Error(`${row.filename} was edited after it was applied. Undo the edit and put the change in a new migration`);
    }
  }

  const appliedFiles = new Set(applied.map((row) => row.filename));
  const pending = migrations.filter((migration) => !appliedFiles.has(migration.file));

  // Order matters, so a new file can't slip in below one that has already run
  const latest = [...appliedFiles].sort().at(-1);
  const outOfOrder = pending.find((migration) => latest && migration.file < latest);
  if (outOfOrder) {
    throw new Error(`${outOfOrder.file} is new but numbered below ${latest}, which is already applied. Renumber it`);
  }
  return pending;
}

// A migration can report what it did by ending with a SELECT that has a `summary` column; those rows are printed.
// With several statements the driver returns one result per statement, and row sets are the arrays among them.
function summaryRows(results) {
  const sets = Array.isArray(results) && results.some(Array.isArray) ? results.filter(Array.isArray) : [results];
  return sets.flat().filter((row) => row && typeof row === 'object' && 'summary' in row);
}

// dbName defaults to DB_NAME from .env. backupFirst: false skips the backup, for a brand-new empty database.
// until: apply only the migrations up to and including this number (e.g. '004'); tests use it to build an older schema.
async function migrate({ dbName = process.env.DB_NAME, backupFirst = true, until } = {}) {
  if (!dbName) {
    throw new Error('DB_NAME is not set. Copy .env.example to .env first');
  }
  const migrations = readMigrations().filter((migration) => !until || migration.file.slice(0, 3) <= until);

  // Connect without selecting a database, since it may not exist yet
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true, // a migration file can contain several statements
  });

  try {
    // Two runs at once could apply the same migration twice; the lock ends with this connection
    const [[{ locked }]] = await connection.query("SELECT GET_LOCK('ticketflow_migrate', 0) AS locked");
    if (!locked) {
      throw new Error('Another db:migrate is running. Wait for it to finish');
    }

    // A database name can't be a ? placeholder; it comes from .env (not user input) and is quoted with backticks
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await connection.query(`USE \`${dbName}\``);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [applied] = await connection.query('SELECT filename, checksum FROM schema_migrations');
    const pending = findPending(migrations, applied);
    if (pending.length === 0) {
      console.log(`Database "${dbName}" is up to date (migrations applied: ${applied.length}).`);
      return;
    }

    // MySQL can't roll back schema changes, so a failed migration can only be undone from a backup.
    // If the backup fails this stops here, before anything has changed.
    const [tables] = await connection.query('SHOW TABLES');
    const backupFile = backupFirst && tables.length > 1 ? await backup() : null;

    for (const migration of pending) {
      try {
        const [results] = await connection.query(migration.sql);
        for (const { summary, ...counts } of summaryRows(results)) {
          const text = Object.entries(counts).map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value}`);
          console.log(`  ${summary}: ${text.join(', ')}`);
        }
      } catch (err) {
        const restore = backupFile ? ` Restore backups/${backupFile} before trying again.` : '';
        throw new Error(`${migration.file} failed and may be half applied: ${err.message}.${restore}`);
      }
      await connection.query('INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)', [
        migration.file,
        migration.checksum,
      ]);
      console.log(`Applied ${migration.file}`);
    }
    console.log(`Database "${dbName}" is up to date (migrations applied: ${applied.length + pending.length}).`);
  } finally {
    await connection.end();
  }
}

// Run directly by npm run db:migrate; tests/globalSetup.js imports migrate() instead
if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { migrate };
