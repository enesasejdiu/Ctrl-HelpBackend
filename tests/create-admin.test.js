// npm run create-admin (scripts/create-admin.js): the first admin of a new installation, from the command line.
// The real script runs as a child process on the throwaway test database (tests/setupEnv.js set DB_NAME), with the
// answers piped in like a person typing them, or given as --name/--email.
const path = require('path')
const { spawn } = require('child_process')
const pool = require('../src/db')
const { api, resetData, dbUser, createUser } = require('./helpers')
const { parseArgs, validate } = require('../scripts/create-admin')

beforeEach(resetData)

// Runs the script; `input` is what is typed (one answer per line). Email is set up when `email` is true.
function run({ args = [], input = '', email = false, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/create-admin.js', ...args], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        MAIL_ENABLED: email ? 'true' : '',
        SMTP_HOST: email ? 'smtp.test.invalid' : '',
        MAIL_FROM: email ? 'TicketFlow <no-reply@test.invalid>' : '',
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

const adminByEmail = async (email) => {
  const [[row]] = await pool.query('SELECT * FROM users WHERE email = ?', [email])
  return row
}

describe('without email: a temporary password', () => {
  test('asks for name and email, creates an admin, prints a temporary password that logs in', async () => {
    const res = await run({ input: 'Ann Admin\nAnn@Example.com\n' })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('Name: ')
    expect(res.stdout).toContain('Email: ')
    expect(res.stdout).toContain('Admin account created: Ann Admin <ann@example.com>')
    const password = /Temporary password \(shown only now\): (\S+)/.exec(res.stdout)?.[1]
    expect(password).toEqual(expect.any(String))

    const row = await adminByEmail('ann@example.com')
    expect(row).toMatchObject({ name: 'Ann Admin', role: 'admin', is_active: 1, must_change_password: 1 })
    expect(row.password_hash).not.toContain(password)

    const login = await api.post('/api/auth/login').send({ email: 'ann@example.com', password })
    expect(login.status).toBe(200)
    expect(login.body.user).toMatchObject({ role: 'admin', must_change_password: true })
  })

  test('takes --name and --email instead of asking', async () => {
    const res = await run({ args: ['--name', 'Ben Boss', '--email=ben@example.com'] })
    expect(res.code).toBe(0)
    expect(res.stdout).not.toContain('Name: ')
    expect(await adminByEmail('ben@example.com')).toMatchObject({ name: 'Ben Boss', role: 'admin' })
  })

  test('records user_created in the audit log, without an actor and without the password', async () => {
    const res = await run({ args: ['--name', 'Ann Admin', '--email', 'ann@example.com'] })
    const password = /Temporary password \(shown only now\): (\S+)/.exec(res.stdout)[1]
    const row = await adminByEmail('ann@example.com')
    const [[entry]] = await pool.query("SELECT * FROM audit_log WHERE action = 'user_created' AND target_user_id = ?", [
      row.id,
    ])
    expect(entry.actor_id).toBeNull()
    const details = typeof entry.details === 'string' ? JSON.parse(entry.details) : entry.details
    expect(details).toEqual({
      email: 'ann@example.com',
      role: 'admin',
      department_id: null,
      delivery: 'temporary_password',
      via: 'create-admin',
    })
    expect(JSON.stringify(entry)).not.toContain(password)
  })
})

describe('with email set up: a set-password link', () => {
  test('prints a one-time link (nothing is emailed); setting a password with it lets the admin log in', async () => {
    const res = await run({ args: ['--name', 'Ann Admin', '--email', 'ann@example.com'], email: true })
    expect(res.code).toBe(0)
    expect(res.stdout).toMatch(/Set-password link \(one-time, valid for 48 hours; nothing was emailed\)/)
    expect(res.stdout).not.toMatch(/Temporary password/)
    const link = /(http\S+\/set-password\?token=\S+)/.exec(res.stdout)[1]
    expect(link.startsWith(`${process.env.APP_URL}/set-password?token=`)).toBe(true)
    const token = new URL(link).searchParams.get('token')

    const set = await api.post('/api/auth/set-password').send({ token, new_password: 'a-strong-pass-42' })
    expect(set.status).toBe(200)
    const login = await api.post('/api/auth/login').send({ email: 'ann@example.com', password: 'a-strong-pass-42' })
    expect(login.status).toBe(200)
    expect(login.body.user).toMatchObject({ role: 'admin', must_change_password: false })
  })
})

describe('refusals: nothing is created', () => {
  test('an email that already has an account', async () => {
    const existing = await createUser({ role: 'employee' })
    const res = await run({ args: ['--name', 'Someone', '--email', existing.email.toUpperCase()] })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain(`create-admin: An account with the email ${existing.email} already exists`)
    expect((await dbUser(existing.id)).role).toBe('employee')
  })

  test("an invalid email or an empty name, with the API's own messages", async () => {
    const res = await run({ input: '\nnot-an-email\n' })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('Name is required')
    expect(res.stderr).toContain('Enter a valid email')
    const [[{ count }]] = await pool.query('SELECT COUNT(*) AS count FROM users')
    expect(count).toBe(0)
  })

  test('no answers at all (input closed) is the same as empty ones', async () => {
    const res = await run({ input: '' })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('Name is required')
  })

  test('production settings that are too weak: the config check stops it before asking', async () => {
    const res = await run({ args: ['--name', 'A', '--email', 'a@example.com'], env: { NODE_ENV: 'production' } })
    expect(res.code).toBe(1)
    expect(res.stderr).toMatch(/Invalid configuration/)
    const [[{ count }]] = await pool.query('SELECT COUNT(*) AS count FROM users')
    expect(count).toBe(0)
  })
})

describe('argument parsing', () => {
  test('--name value, --email=value', () => {
    expect(parseArgs(['--name', 'Ann', '--email=a@x.com'])).toEqual({ name: 'Ann', email: 'a@x.com' })
  })

  test('unknown arguments and missing values are refused', () => {
    expect(() => parseArgs(['--role', 'admin'])).toThrow(/Unknown argument: --role/)
    expect(() => parseArgs(['--name'])).toThrow(/--name needs a value/)
  })

  test('validate trims and lowercases like POST /api/users', () => {
    expect(validate({ name: '  Ann  ', email: ' Ann@X.com ' })).toEqual({ name: 'Ann', email: 'ann@x.com' })
  })
})
