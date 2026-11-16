// Creates an admin account from the command line: the first admin of a new installation (nobody can log in yet to
// create one with POST /api/users), or a new admin when nobody who can still log in is an admin.
//   npm run create-admin                                  asks for the name and email
//   npm run create-admin -- --name "Ann Admin" --email ann@example.com
//   docker compose run --rm api npm run create-admin      the same, in the Docker Compose setup (README)
// The password is handed out like POST /api/users does it: with email set up, a one-time set-password link (48 hours);
// otherwise a temporary password, which must be changed at the first login. Either is printed here, once, and never
// stored or logged anywhere else. The account creation is in the audit log (user_created, no actor).
require('dotenv').config({ quiet: true })

const readline = require('node:readline/promises')
const bcrypt = require('bcryptjs')
const { z } = require('zod')
const { name: nameSchema, email: emailSchema } = require('../src/schemas/common')

// Reads --name and --email from the arguments; anything not given there is asked for (one line each from stdin)
function parseArgs(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i++) {
    const match = /^--(name|email)(?:=(.*))?$/.exec(argv[i])
    if (!match) throw new Error(`Unknown argument: ${argv[i]} (use --name "..." and --email ...)`)
    values[match[1]] = match[2] ?? argv[++i]
    if (values[match[1]] === undefined) throw new Error(`--${match[1]} needs a value`)
  }
  return values
}

async function ask(given, { input = process.stdin, output = process.stdout } = {}) {
  const missing = ['name', 'email'].filter((key) => given[key] === undefined)
  if (missing.length === 0) return given
  const rl = readline.createInterface({ input, output, terminal: false })
  // Piped input (one answer per line) can arrive before the questions are asked; collect the lines as they come
  const lines = []
  const waiting = []
  rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)))
  // Input that ends (Ctrl+D, or piped input run out) answers every remaining question with nothing
  let closed = false
  rl.on('close', () => {
    closed = true
    waiting.splice(0).forEach((resolve) => resolve(undefined))
  })
  const nextLine = () => {
    if (lines.length) return Promise.resolve(lines.shift())
    if (closed) return Promise.resolve(undefined)
    return new Promise((resolve) => waiting.push(resolve))
  }
  const answers = { ...given }
  try {
    for (const key of missing) {
      output.write(key === 'name' ? 'Name: ' : 'Email: ')
      answers[key] = (await nextLine()) ?? ''
      if (!input.isTTY) output.write('\n')
    }
  } finally {
    rl.close()
  }
  return answers
}

// Checks name and email with the same rules as POST /api/users; throws with every problem listed
function validate(answers) {
  const result = z.object({ name: nameSchema, email: emailSchema }).safeParse(answers)
  if (!result.success) throw new Error(result.error.issues.map((issue) => issue.message).join('\n'))
  return result.data
}

// Creates the admin. Returns { user, delivery: 'email' | 'temporary_password', link?, temporaryPassword? }.
async function createAdmin({ name, email }, { db, emailConfigured, appUrl }) {
  const { makeTemporaryPassword } = require('../src/temporaryPassword')
  const { issueToken, unusablePasswordHash } = require('../src/passwordTokens')
  const { recordAudit } = require('../src/audit')
  const templates = require('../src/mail/templates')

  const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email])
  if (existing.length > 0) throw new Error(`An account with the email ${email} already exists`)

  const temporaryPassword = emailConfigured ? null : makeTemporaryPassword()
  const passwordHash = emailConfigured ? await unusablePasswordHash() : await bcrypt.hash(temporaryPassword, 10)
  const conn = await db.getConnection()
  let userId
  let token = null
  try {
    await conn.beginTransaction()
    const [result] = await conn.query(
      `INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES (?, ?, ?, 'admin', TRUE)`,
      [name, email, passwordHash],
    )
    userId = result.insertId
    if (emailConfigured) ({ token } = await issueToken(conn, userId, 'setup'))
    await recordAudit('user_created', {
      targetUserId: userId,
      details: {
        email,
        role: 'admin',
        department_id: null,
        delivery: emailConfigured ? 'email' : 'temporary_password',
        via: 'create-admin',
      },
      db: conn,
    })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    if (err.code === 'ER_DUP_ENTRY')
      throw new Error(`An account with the email ${email} already exists`, { cause: err })
    throw err
  } finally {
    conn.release()
  }

  const user = { id: userId, name, email, role: 'admin' }
  return emailConfigured
    ? { user, delivery: 'email', link: templates.links.setPassword(appUrl, token) }
    : { user, delivery: 'temporary_password', temporaryPassword }
}

async function main({ argv = process.argv.slice(2), input, output = process.stdout } = {}) {
  // Same checks as the server (refuses weak or missing settings in production), then the answers
  const config = require('../src/config').checkConfig('server')
  const { TOKEN_HOURS } = require('../src/passwordTokens')
  const answers = validate(await ask(parseArgs(argv), { input, output }))
  const pool = require('../src/db')
  try {
    const created = await createAdmin(answers, {
      db: pool,
      emailConfigured: config.mail.emailConfigured,
      appUrl: config.mail.appUrl,
    })
    output.write(`\nAdmin account created: ${created.user.name} <${created.user.email}> (id ${created.user.id})\n`)
    if (created.delivery === 'email') {
      output.write(
        `Set-password link (one-time, valid for ${TOKEN_HOURS} hours; nothing was emailed):\n  ${created.link}\n`,
      )
      output.write('Open it in a browser, choose a password, then log in.\n')
    } else {
      output.write(`Temporary password (shown only now): ${created.temporaryPassword}\n`)
      output.write('Log in with it; you will be asked to choose your own password straight away.\n')
    }
  } finally {
    await pool.end()
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`create-admin: ${err.message}`)
    process.exitCode = 1
  })
}

module.exports = { createAdmin, parseArgs, validate, ask, main }
