// Checks the settings in process.env (from .env) before anything connects: when the server starts (src/server.js) and
// before the database scripts run (migrate, seed, rollback, backup, ...).
//
// Missing or malformed settings always stop the program with a list of what's wrong. On top of that, three rules
// protect production: JWT_SECRET must be at least 32 characters, must not be a known placeholder, and CLIENT_URL must be
// https. With NODE_ENV=production a broken rule refuses to start; in development it is only a warning, so a local
// .env with a short secret and http://localhost still works.
//
// The email settings (SMTP_*, MAIL_*, APP_URL, IT_NOTIFY_EMAIL) are checked by loadMailConfig() below, which the
// mailer (src/mail/mailer.js) also uses. Malformed values always stop the program. Email is off unless MAIL_ENABLED=true;
// in production MAIL_ENABLED=true then also needs SMTP_HOST, MAIL_FROM and an https APP_URL.
// "Email is set up" (mail.emailConfigured, isEmailConfigured() in the mailer) = MAIL_ENABLED=true, SMTP_HOST and
// MAIL_FROM set. Only then do passwords go out as emailed links; otherwise admins see a temporary password, as before.
const { z } = require('zod')
const { DEFAULT_LOCKOUT_MINUTES, MAX_LOCKOUT_MINUTES, parseLockoutMinutes } = require('./lockout')

const MIN_SECRET_LENGTH = 32

// Values copied from examples and tutorials: anyone can guess them, so they must never sign production logins
const PLACEHOLDER_SECRETS = [
  'change_this_to_a_long_random_string',
  'secret',
  'changeme',
  'change_me',
  'your_jwt_secret',
  'jwt_secret',
  'mysecret',
  'supersecret',
  'password',
]

const GENERATE_SECRET = `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

const port = (name) =>
  z.coerce
    .number({ error: `${name} must be a number` })
    .int(`${name} must be a whole number`)
    .min(1, `${name} must be between 1 and 65535`)
    .max(65535, `${name} must be between 1 and 65535`)
const required = (name) =>
  z
    .string({ error: `${name} is missing` })
    .trim()
    .min(1, `${name} is missing`)

// What the database scripts need
const databaseSchema = z.object({
  DB_HOST: required('DB_HOST'),
  DB_PORT: port('DB_PORT'),
  DB_USER: required('DB_USER'),
  // May be empty (e.g. XAMPP's root user has no password), but has to be set, so a forgotten line is noticed
  DB_PASSWORD: z.string({ error: 'DB_PASSWORD is missing (set it to an empty value if the user has no password)' }),
  DB_NAME: required('DB_NAME'),
})

// What the server needs on top of that
const serverSchema = databaseSchema.extend({
  PORT: port('PORT'),
  CLIENT_URL: z.url({
    protocol: /^https?$/,
    error: 'CLIENT_URL must be the frontend address, e.g. https://helpdesk.example.com',
  }),
  JWT_SECRET: required('JWT_SECRET'),
})

// The email settings. A blank value (SMTP_HOST=) counts as not set.
const MAIL_KEYS = [
  'MAIL_ENABLED',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
  'APP_URL',
  'IT_NOTIFY_EMAIL',
]
const trueOrFalse = (name) => z.enum(['true', 'false'], { error: `${name} must be true or false` }).optional()
const mailSchema = z.object({
  MAIL_ENABLED: trueOrFalse('MAIL_ENABLED'),
  SMTP_HOST: z.string().trim().optional(),
  SMTP_PORT: port('SMTP_PORT').optional(),
  SMTP_SECURE: trueOrFalse('SMTP_SECURE'),
  SMTP_USER: z.string().trim().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z
    .string()
    .trim()
    // "address@example.com" or "Name <address@example.com>"
    .regex(/^(?:[^<>\r\n]*<[^\s@<>]+@[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+)$/, {
      error: 'MAIL_FROM must be an address, e.g. "TicketFlow <no-reply@example.com>"',
    })
    .optional(),
  APP_URL: z
    .url({ protocol: /^https?$/, error: 'APP_URL must be the frontend address, e.g. https://helpdesk.example.com' })
    .optional(),
  IT_NOTIFY_EMAIL: z.email('IT_NOTIFY_EMAIL must be an email address').optional(),
})
const DEFAULT_SMTP_PORT = 587
const DEV_MAIL_FROM = 'TicketFlow <no-reply@localhost>'

class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

// The three production rules; returns the broken ones as messages
function productionProblems(settings) {
  const problems = []
  const secret = settings.JWT_SECRET
  if (PLACEHOLDER_SECRETS.includes(secret.toLowerCase())) {
    problems.push(`JWT_SECRET is a placeholder ("${secret}"). Generate a real one with: ${GENERATE_SECRET}`)
  } else if (secret.length < MIN_SECRET_LENGTH) {
    problems.push(
      `JWT_SECRET is only ${secret.length} characters; use at least ${MIN_SECRET_LENGTH}. Generate one with: ${GENERATE_SECRET}`,
    )
  }
  if (new URL(settings.CLIENT_URL).protocol !== 'https:') {
    problems.push(`CLIENT_URL must use https in production (got ${settings.CLIENT_URL})`)
  }
  return problems
}

// The email settings, checked. Returns { mail, notices }; throws ConfigError when the program must not start.
// mail.mode says what the mailer does: 'smtp' (send), 'log' (print instead of sending) or 'test' (the test suite:
// nodemailer's jsonTransport, nothing leaves the process). NODE_ENV=test is always 'test', whatever else is set.
// notices are worth knowing but not mistakes (e.g. email switched off).
function loadMailConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development'
  const production = nodeEnv === 'production'
  const raw = {}
  for (const key of MAIL_KEYS) {
    if (env[key] !== undefined && env[key].trim() !== '') raw[key] = env[key]
  }

  const result = mailSchema.safeParse(raw)
  if (!result.success) throw new ConfigError(result.error.issues.map((issue) => issue.message))
  const settings = result.data

  // Off unless switched on: without email, passwords are temporary ones shown to the admin (the fallback)
  const enabled = settings.MAIL_ENABLED === 'true'
  const problems = []
  if (Boolean(settings.SMTP_USER) !== Boolean(settings.SMTP_PASS)) {
    problems.push('SMTP_USER and SMTP_PASS must be set together (or both left empty for a server without login)')
  }
  if (production && enabled) {
    for (const key of ['SMTP_HOST', 'MAIL_FROM', 'APP_URL']) {
      if (!settings[key]) problems.push(`${key} is missing (needed to send email; or set MAIL_ENABLED=false)`)
    }
    if (settings.APP_URL && new URL(settings.APP_URL).protocol !== 'https:') {
      problems.push(`APP_URL must use https in production (got ${settings.APP_URL})`)
    }
  }
  if (problems.length > 0) throw new ConfigError(problems)

  const notices = []
  if (nodeEnv !== 'test' && enabled && (!settings.SMTP_HOST || !settings.MAIL_FROM)) {
    notices.push(
      'MAIL_ENABLED=true but SMTP_HOST or MAIL_FROM is empty: emails are logged instead of sent, and passwords are temporary ones',
    )
  }

  const emailConfigured = enabled && Boolean(settings.SMTP_HOST) && Boolean(settings.MAIL_FROM)
  let mode = emailConfigured ? 'smtp' : 'log'
  if (nodeEnv === 'test') mode = 'test'
  return {
    mail: {
      mode,
      production,
      // Email is set up: passwords for new and reset accounts go out as one-time links (see src/passwordTokens.js).
      // Decided here, from the server's settings only. In tests it can be true while mode is 'test' (nothing is sent).
      emailConfigured,
      host: settings.SMTP_HOST ?? null,
      port: settings.SMTP_PORT ?? DEFAULT_SMTP_PORT,
      secure: settings.SMTP_SECURE === 'true',
      user: settings.SMTP_USER ?? null,
      pass: settings.SMTP_PASS ?? null,
      from: settings.MAIL_FROM ?? DEV_MAIL_FROM,
      // Links in emails are built from this only, never from a request's Host header. Development falls back to
      // CLIENT_URL.
      appUrl: (settings.APP_URL ?? env.CLIENT_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
      itNotifyEmail: settings.IT_NOTIFY_EMAIL?.toLowerCase() ?? null,
      // Development and tests only: every email is also written to this folder as a .json file (the e2e tests read
      // the set-password links from there). Ignored in production.
      outboxDir: production ? null : env.MAIL_OUTBOX_DIR?.trim() || null,
    },
    notices,
  }
}

// Validates env for 'server' (everything, including config.mail) or 'database' (the DB_* settings only).
// Returns { config, warnings, notices }. Throws ConfigError when the program must not start.
// LOCKOUT_MINUTES (src/lockout.js) may only shorten or lengthen the lockout in the test environment. Anywhere else a
// value other than 15 is refused (in production the lock is always 15 minutes), and in tests it must be a valid number.
function lockoutProblems(env) {
  const raw = env.LOCKOUT_MINUTES
  if (raw === undefined || raw === '') return []
  if (env.NODE_ENV !== 'test') {
    return Number(raw) === DEFAULT_LOCKOUT_MINUTES
      ? []
      : [
          `LOCKOUT_MINUTES can only be changed when NODE_ENV=test; the lockout is always ${DEFAULT_LOCKOUT_MINUTES} minutes here (got ${raw}). Remove it from .env`,
        ]
  }
  return parseLockoutMinutes(raw) === null
    ? [`LOCKOUT_MINUTES must be a whole number of minutes from 1 to ${MAX_LOCKOUT_MINUTES} (got ${raw})`]
    : []
}

function loadConfig(env = process.env, { scope = 'server' } = {}) {
  const schema = scope === 'database' ? databaseSchema : serverSchema
  const result = schema.safeParse(env)
  const issues = result.success ? [] : result.error.issues.map((issue) => issue.message)
  let mail = null
  let notices = []
  if (scope === 'server') {
    issues.push(...lockoutProblems(env))
    // Collected together with the other problems, so one start lists everything that is wrong
    try {
      ;({ mail, notices } = loadMailConfig(env))
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err
      issues.push(...err.problems)
    }
  }
  if (issues.length > 0) {
    throw new ConfigError(issues)
  }
  const config = { ...result.data, NODE_ENV: env.NODE_ENV || 'development', ...(mail && { mail }) }

  const problems = scope === 'server' ? productionProblems(config) : []
  if (problems.length > 0 && config.NODE_ENV === 'production') {
    throw new ConfigError(problems)
  }
  return { config, warnings: problems, notices }
}

// For entry points (server, scripts): checks env, prints warnings, and exits with a clear message if it must not start
function checkConfig(scope, { env = process.env, log = console, exit = process.exit } = {}) {
  try {
    const { config, warnings, notices } = loadConfig(env, { scope })
    for (const warning of warnings) {
      log.warn(`Config warning (would refuse to start with NODE_ENV=production): ${warning}`)
    }
    for (const notice of notices) {
      log.warn(`Config note: ${notice}`)
    }
    return config
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err
    log.error(`${err.message}\nFix these settings in .env (see .env.example) and start again.`)
    return exit(1)
  }
}

module.exports = { loadConfig, loadMailConfig, checkConfig, ConfigError, PLACEHOLDER_SECRETS, MIN_SECRET_LENGTH }
