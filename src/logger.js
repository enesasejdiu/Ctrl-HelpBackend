// The API's logger (pino) and its request logging (pino-http). README "Logs" shows what a line looks like.
//
// - Production: one JSON line per entry on stdout (docker compose logs api).
// - Development: the same entries, made readable by pino-pretty (a dev dependency; JSON if it isn't installed).
// - Tests: silent. A test that checks the output uses captureLogs() below.
// LOG_LEVEL (src/config.js) sets the lowest level written: fatal, error, warn, info (the default), debug, trace, silent.
//
// Every request gets an id (requestId below): it is on each line logged for that request (request_id) and goes back to
// the client in the X-Request-Id header, so one request's lines can be found with grep <id>.
//
// Secrets are kept out by construction: a request is logged only as method, path (query values removed), status,
// duration and user id. Headers and bodies are never logged. `redact` below is the second line of defence, for an
// object that is logged with one of those fields anyway.
const crypto = require('crypto')
const pino = require('pino')
const pinoHttp = require('pino-http')

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']
const DEFAULT_LOG_LEVEL = 'info'

// What replaces a redacted value
const REDACTED = '[redacted]'

// Field names that hold secrets, wherever they appear (top level or one object down, e.g. { user: { password } })
const SECRET_KEYS = [
  'password',
  'currentPassword',
  'newPassword',
  'current_password',
  'new_password',
  'password_hash',
  'temporaryPassword',
  'temporary_password',
  'token',
  'link',
  'setPasswordLink',
  'resetLink',
  'secret',
  'JWT_SECRET',
  'SMTP_PASS',
  'pass',
  'authorization',
  'cookie',
  'set-cookie',
  'body',
]
const REDACT_PATHS = [
  ...SECRET_KEYS.flatMap((key) => [`["${key}"]`, `*["${key}"]`]),
  // Request and response headers, if a whole req/res is ever logged
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.headers.authorization',
  '*.headers.cookie',
  '*.headers["set-cookie"]',
  // mysql2 puts the query text (and with it the values) on its errors
  'err.sql',
]

// LOG_LEVEL from the environment; anything invalid falls back to the default (the config check reports it)
function levelFromEnv(env = process.env) {
  if (env.NODE_ENV === 'test') return 'silent'
  const level = env.LOG_LEVEL?.trim().toLowerCase()
  return LOG_LEVELS.includes(level) ? level : DEFAULT_LOG_LEVEL
}

// Readable output for development, if pino-pretty is installed (it isn't in the production image)
function prettyStream(env = process.env) {
  if (env.NODE_ENV === 'production' || env.NODE_ENV === 'test') return null
  try {
    return require('pino-pretty')({
      colorize: true,
      sync: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
    })
  } catch {
    return null
  }
}

// Where the lines go. A forwarding stream, so captureLogs() can point it somewhere else for a test.
let target = prettyStream() ?? pino.destination({ dest: 1, sync: true })
const output = { write: (line) => target.write(line) }

const logger = pino(
  {
    level: levelFromEnv(),
    base: undefined, // no pid/hostname on every line: Docker already knows which container it came from
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) }, // "level":"info" instead of "level":30
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    serializers: { err: pino.stdSerializers.err },
  },
  output,
)

// A console-shaped wrapper ({ log, info, warn, error, debug }) for the modules that take a `log` option
// (src/shutdown.js, src/mail/mailer.js, ...). Scripts keep passing console, so their output stays plain text.
// An Error as the second argument is logged with its stack: log.error('Job failed', err).
function asConsole(log = logger) {
  const at = (level) => (message, err) =>
    err instanceof Error ? log[level]({ err }, String(message)) : log[level](String(message))
  return { log: at('info'), info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') }
}

// ---- requests ----

// An incoming X-Request-Id is kept only if it is short and plain (from a proxy or the client); anything else (too long,
// spaces, quotes, newlines that could forge log lines) is replaced by a new id.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/

function requestId(req, res) {
  const incoming = req.headers['x-request-id']
  const id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID()
  res.setHeader('X-Request-Id', id)
  return id
}

// The path with only the query string's keys, no values: /api/auth/set-password/validate?token=abc → ...validate?token
function safePath(url = '') {
  const [pathname, query] = url.split('?', 2)
  if (query === undefined) return pathname
  const keys = [...new Set([...new URLSearchParams(query).keys()])]
  return keys.length > 0 ? `${pathname}?${keys.join('&')}` : pathname
}

// Health checks (Docker, every few seconds) would drown everything else
const NOT_LOGGED = new Set(['/api/health'])

// The access log: one line per request when its response is finished. req.log is the request's logger (request_id on
// every line); route handlers use it for anything they log.
const requestLogger = pinoHttp({
  logger,
  genReqId: requestId,
  quietReqLogger: true, // req.log carries only request_id, not the whole request
  customAttributeKeys: { reqId: 'request_id', responseTime: 'duration_ms' },
  autoLogging: { ignore: (req) => NOT_LOGGED.has(safePath(req.url).split('?')[0]) },
  // The error handler logs failures (with the details); the access line stays at info so it is never doubled up
  customLogLevel: () => 'info',
  // Only these fields: never headers, bodies or query values
  serializers: {
    req: (req) => ({ method: req.method, path: safePath(req.raw?.originalUrl ?? req.url) }),
    res: (res) => ({ status: res.statusCode }),
  },
  wrapSerializers: false,
  customProps: (req) => (req.user?.id ? { user_id: req.user.id } : {}),
  customSuccessMessage: (req, res, ms) =>
    `${req.method} ${safePath(req.originalUrl ?? req.url)} ${res.statusCode} ${Math.round(ms)}ms`,
  customErrorMessage: (req, res) => `${req.method} ${safePath(req.originalUrl ?? req.url)} ${res.statusCode}`,
})

// ---- tests ----

// Collects every line logged (as parsed objects) from now until restore(), at `level` (default debug). Every test
// ends with stopLogCapture() (tests/setupAfterEnv.js), so a capture never outlives its test.
const normal = { target, level: logger.level }

function captureLogs({ level = 'debug' } = {}) {
  const lines = []
  target = { write: (line) => lines.push(JSON.parse(line)) }
  logger.level = level
  return {
    lines,
    text: () => lines.map((line) => JSON.stringify(line)).join('\n'),
    restore: stopLogCapture,
  }
}

function stopLogCapture() {
  target = normal.target
  logger.level = normal.level
}

module.exports = {
  logger,
  asConsole,
  requestLogger,
  requestId,
  safePath,
  captureLogs,
  stopLogCapture,
  levelFromEnv,
  LOG_LEVELS,
  DEFAULT_LOG_LEVEL,
  REDACTED,
}
