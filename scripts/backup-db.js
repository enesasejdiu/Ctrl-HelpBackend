// Writes a full SQL backup of the database to backups/<DB_NAME>-<YYYY-MM-DD-HHmm>.sql. Usage: npm run db:backup
// Uses mysqldump when it's installed, otherwise a plain mysql2 export (e.g. XAMPP, where mysqldump isn't on PATH).
// Restore with: mysql -u root <DB_NAME> < backups/<file>.sql
// Backups contain emails and password hashes, so backups/ is in .gitignore and must never be committed.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const mysql = require('mysql2/promise');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const dbName = process.env.DB_NAME;
const dbPort = Number(process.env.DB_PORT) || 3306;

// Local time as YYYY-MM-DD-HHmm
function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${date}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function hasMysqldump() {
  return !spawnSync('mysqldump', ['--version']).error;
}

function dumpWithMysqldump(file) {
  // With GTID on, the dump would contain a GTID_PURGED line that the same server refuses to restore.
  // Only MySQL's mysqldump has this option; MariaDB's (XAMPP) rejects it and doesn't write that line anyway.
  const help = spawnSync('mysqldump', ['--help'], { encoding: 'utf8' }).stdout || '';
  const gtidOption = help.includes('--set-gtid-purged') ? ['--set-gtid-purged=OFF'] : [];

  return new Promise((resolve, reject) => {
    const output = fs.openSync(file, 'w');
    const child = spawn(
      'mysqldump',
      [
        `--host=${process.env.DB_HOST}`,
        `--port=${dbPort}`,
        `--user=${process.env.DB_USER}`,
        '--single-transaction', // consistent snapshot without locking the tables
        '--no-tablespaces', // otherwise a user without the PROCESS privilege gets an error
        ...gtidOption,
        dbName,
      ],
      {
        // Password via the environment, so it doesn't show up in the process list
        env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD || '' },
        stdio: ['ignore', output, 'pipe'],
      }
    );
    fs.closeSync(output); // the child process has its own handle

    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(errors.trim() || `mysqldump exited with code ${code}`));
    });
  });
}

// Fallback: writes each table's CREATE statement and its rows as INSERTs
async function dumpWithMysql2(file) {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: dbPort,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: dbName,
    dateStrings: true, // keep timestamps exactly as stored instead of converting them to JS dates
  });

  try {
    const lines = ['SET FOREIGN_KEY_CHECKS = 0;'];
    const [tables] = await connection.query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");

    for (const row of tables) {
      const table = Object.values(row)[0];
      const id = mysql.escapeId(table);
      const [[created]] = await connection.query(`SHOW CREATE TABLE ${id}`);
      lines.push(`DROP TABLE IF EXISTS ${id};`, `${created['Create Table']};`);

      const [rows] = await connection.query(`SELECT * FROM ${id}`);
      for (const data of rows) {
        const values = Object.values(data).map((value) => mysql.escape(value));
        lines.push(`INSERT INTO ${id} VALUES (${values.join(', ')});`);
      }
    }

    lines.push('SET FOREIGN_KEY_CHECKS = 1;');
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
  } finally {
    await connection.end();
  }
}

async function backup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `${dbName}-${timestamp()}.sql`);
  // Written under a temporary name, so a failed run can never look like a finished backup
  const tempFile = `${file}.tmp`;

  try {
    const useMysqldump = hasMysqldump();
    await (useMysqldump ? dumpWithMysqldump(tempFile) : dumpWithMysql2(tempFile));

    if (fs.statSync(tempFile).size === 0) {
      throw new Error('The backup file is empty');
    }
    fs.renameSync(tempFile, file);

    const size = (fs.statSync(file).size / 1024).toFixed(1);
    console.log(`Backup written with ${useMysqldump ? 'mysqldump' : 'mysql2'}: backups/${path.basename(file)} (${size} KB)`);
  } finally {
    fs.rmSync(tempFile, { force: true });
  }
}

backup().catch((err) => {
  console.error('Backup failed:', err.message);
  process.exitCode = 1;
});
