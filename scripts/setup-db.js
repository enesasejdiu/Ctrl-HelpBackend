// Creates the database (if missing) and all tables from db/schema.sql.
// Safe to re-run: every statement uses IF NOT EXISTS. Usage: npm run db:setup
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function setup() {
  const dbName = process.env.DB_NAME;

  // Connect without selecting a database, since it may not exist yet
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true, // schema.sql contains several statements
  });

  try {
    // A database name can't be a ? placeholder; it comes from .env (not user input) and is quoted with backticks
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await connection.query(`USE \`${dbName}\``);

    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await connection.query(schema);

    const [tables] = await connection.query('SHOW TABLES');
    console.log(`Database "${dbName}" is ready. Tables:`);
    tables.forEach((row) => console.log(`  - ${Object.values(row)[0]}`));
  } finally {
    await connection.end();
  }
}

setup().catch((err) => {
  console.error('Database setup failed:', err.message);
  process.exit(1);
});
