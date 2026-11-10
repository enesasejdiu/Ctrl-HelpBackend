// Checks the settings in process.env (from .env) before anything connects: when the server starts (src/server.js) and
// before the database scripts run (migrate, seed, rollback, backup, ...).
//
// Missing or malformed settings always stop the program with a list of what's wrong. On top of that, three rules
// protect production: JWT_SECRET must be at least 32 characters, must not be a known placeholder, and CLIENT_URL must be
// https. With NODE_ENV=production a broken rule refuses to start; in development it is only a warning, so a local
// .env with a short secret and http://localhost still works.
const { z } = require('zod')

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

// Validates env for 'server' (everything) or 'database' (the DB_* settings only).
// Returns { config, warnings }. Throws ConfigError when the program must not start.
function loadConfig(env = process.env, { scope = 'server' } = {}) {
  const schema = scope === 'database' ? databaseSchema : serverSchema
  const result = schema.safeParse(env)
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => issue.message))
  }
  const config = { ...result.data, NODE_ENV: env.NODE_ENV || 'development' }

  const problems = scope === 'server' ? productionProblems(config) : []
  if (problems.length > 0 && config.NODE_ENV === 'production') {
    throw new ConfigError(problems)
  }
  return { config, warnings: problems }
}

// For entry points (server, scripts): checks env, prints warnings, and exits with a clear message if it must not start
function checkConfig(scope, { env = process.env, log = console, exit = process.exit } = {}) {
  try {
    const { config, warnings } = loadConfig(env, { scope })
    for (const warning of warnings) {
      log.warn(`Config warning (would refuse to start with NODE_ENV=production): ${warning}`)
    }
    return config
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err
    log.error(`${err.message}\nFix these settings in .env (see .env.example) and start again.`)
    return exit(1)
  }
}

module.exports = { loadConfig, checkConfig, ConfigError, PLACEHOLDER_SECRETS, MIN_SECRET_LENGTH }
