// Error tracking with Sentry (README "Error tracking"). Optional: OFF unless SENTRY_DSN is set. Off, the SDK is not even
// loaded, so nothing is sent and no network connection is made.
//
// What is sent, and only this: server errors (5xx, from src/middleware/errors.js) and crashes (uncaught exceptions and
// unhandled rejections, from src/server.js). Never 4xx. Each event carries
//   - the request id (tag request_id): the same id as in the logs and in the "reference" the user sees; when it is a
//     generated UUID it is also the Sentry event id (without dashes), so either finds the other
//   - method and route (the route pattern, e.g. /api/tickets/:id, never a query string)
//   - the user's id (nothing else about them)
//   - the error's type, message and stack (with emails, IP addresses, tokens and query strings masked)
// Never sent: cookies, headers (Authorization), request bodies, query-string values, emails, names, IP addresses,
// passwords, tokens, set-password links, temporary passwords. sendDefaultPii is off, no default integrations run (no
// breadcrumbs, no request data, no tracing), and scrubEvent() below removes anything else before an event leaves.
const { version } = require('../package.json')
const { safePath } = require('./logger')

const DEFAULT_RELEASE = `ticketflow-backend@${version}`

let Sentry = null // the SDK, once initSentry() has started it

// Starts Sentry if SENTRY_DSN is set. Returns true when it is on. `transport` is for the tests (a fake one).
function initSentry(env = process.env, { transport } = {}) {
  const dsn = env.SENTRY_DSN?.trim()
  if (!dsn) return false
  Sentry = require('@sentry/node')
  Sentry.init({
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || 'development',
    release: env.SENTRY_RELEASE?.trim() || DEFAULT_RELEASE,
    sendDefaultPii: false,
    // Nothing that collects on its own: no breadcrumbs (console output, HTTP calls), no request data, no tracing, no
    // automatic crash handlers (src/server.js reports crashes itself, after logging them)
    defaultIntegrations: false,
    integrations: [Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration()],
    skipOpenTelemetrySetup: true,
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    serverName: 'ticketflow-api', // instead of the machine's host name
    beforeBreadcrumb: () => null,
    beforeSend: scrubEvent,
    ...(transport && { transport }),
  })
  return true
}

const isSentryOn = () => Sentry !== null

// A Sentry event id is 32 hex characters: a generated request id (a UUID) without its dashes
function eventIdFor(requestId) {
  const hex = typeof requestId === 'string' ? requestId.replace(/-/g, '').toLowerCase() : ''
  return /^[0-9a-f]{32}$/.test(hex) ? hex : undefined
}

// The route without its values: the path with no query string, and ids (numbers, UUIDs, long hex) as :id, e.g.
// /api/tickets/12345/attachments → /api/tickets/:id/attachments. (Express has reset req.baseUrl by the time the error
// handler runs, so req.route alone can't give the full pattern.)
const ID_SEGMENT =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[A-Za-z0-9_-]{32,})$/i
function routeOf(req) {
  const path = safePath(req.originalUrl ?? req.url ?? '').split('?')[0]
  const route = path
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/')
  return route.length > 1 ? route.replace(/\/$/, '') : route
}

// A 5xx: called by the error handler. Returns the event id, or undefined when Sentry is off.
function captureServerError(err, req, status = 500) {
  if (!Sentry) return undefined
  const requestId = req.id
  return Sentry.withScope((scope) => {
    scope.setTag('kind', 'server-error')
    if (requestId) scope.setTag('request_id', String(requestId))
    scope.setTag('method', req.method)
    scope.setTag('route', routeOf(req))
    scope.setTag('status', String(status))
    scope.setUser(req.user?.id ? { id: String(req.user.id) } : null)
    return Sentry.captureException(err, { event_id: eventIdFor(requestId) })
  })
}

// A crash (uncaught exception or unhandled rejection): called by src/server.js before it exits
function captureCrash(err, kind) {
  if (!Sentry) return undefined
  return Sentry.withScope((scope) => {
    scope.setTag('kind', kind)
    scope.setUser(null)
    return Sentry.captureException(err instanceof Error ? err : new Error(String(err)))
  })
}

// Waits (at most timeoutMs) until queued events are sent; for a crash, before the process exits
async function flushSentry(timeoutMs = 2000) {
  if (!Sentry) return true
  return Sentry.flush(timeoutMs)
}

// ---- privacy ----

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
// Full (8 groups) or shortened with "::" (fe80::1ff:fe23:4567:890a, ::1, ::ffff:10.0.0.5 → its IPv4 part is masked too)
const IPV6 =
  /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?=[0-9a-f:]*::)[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){1,7}(?<=[0-9a-f]|::))(?!\w|:[0-9a-f])/gi
const IPV4_MAPPED = /::ffff:(?:\d{1,3}\.){3}\d{1,3}\b/gi // ::ffff:10.0.0.5, how Node shows an IPv4 client
const QUERY = /\?[^\s'"<>)]*/g // a URL's query string: ?token=..., ?email=...
// key=value / key: value / "key":"value" where the key ends in a secret word: password, temporary_password,
// newPassword, reset_token, SMTP_PASS, JWT_SECRET, ... (no \b before the word: "_" counts as a word character)
const SECRET_PAIR =
  /\b([\w-]*?(?:password|passwd|pass|token|secret|authorization|cookie|tf_session|tf_csrf))(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&)]+)/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi

// Masks what could identify a person or open an account, in any text that goes to Sentry
function scrubText(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(BEARER, 'Bearer [redacted]')
    .replace(SECRET_PAIR, (match, key, separator, value) => {
      const quote = /^["']/.test(value) ? value[0] : ''
      return `${key}${separator}${quote}[redacted]${quote}`
    })
    .replace(QUERY, '?[redacted]')
    .replace(EMAIL, '[email]')
    .replace(IPV4_MAPPED, '[ip]')
    .replace(IPV6, '[ip]')
    .replace(IPV4, '[ip]')
}

// The last step before an event is sent (beforeSend). Keeps the error, the stack and our tags; removes everything else.
function scrubEvent(event) {
  // Request: only the method and the route, never headers, cookies, body, query string, IP or environment
  if (event.request) {
    const route = event.tags?.route
    event.request = { method: event.request.method, ...(route && { url: route }) }
  }
  event.user = event.user?.id ? { id: String(event.user.id) } : undefined
  delete event.breadcrumbs
  delete event.extra
  delete event.modules
  if (event.contexts) {
    // runtime/os/device are harmless; anything else (custom contexts, cloud/culture data) is dropped
    event.contexts = Object.fromEntries(
      Object.entries(event.contexts).filter(([key]) => ['runtime', 'os', 'app', 'device', 'trace'].includes(key)),
    )
  }
  if (event.message) event.message = scrubText(event.message)
  if (event.logentry?.message) event.logentry.message = scrubText(event.logentry.message)
  for (const exception of event.exception?.values ?? []) {
    exception.value = scrubText(exception.value)
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars // local variables (off by default; never)
      if (frame.context_line) frame.context_line = scrubText(frame.context_line)
      if (frame.pre_context) frame.pre_context = frame.pre_context.map(scrubText)
      if (frame.post_context) frame.post_context = frame.post_context.map(scrubText)
    }
  }
  // Only our tags, and only plain values
  if (event.tags) {
    const allowed = ['kind', 'request_id', 'method', 'route', 'status']
    event.tags = Object.fromEntries(
      Object.entries(event.tags)
        .filter(([key]) => allowed.includes(key))
        .map(([key, value]) => [key, scrubText(String(value))]),
    )
  }
  return event
}

// Tests: back to "off"
async function closeSentry() {
  if (!Sentry) return
  await Sentry.close(2000)
  Sentry = null
}

module.exports = {
  initSentry,
  isSentryOn,
  captureServerError,
  captureCrash,
  flushSentry,
  closeSentry,
  scrubEvent,
  scrubText,
  eventIdFor,
  DEFAULT_RELEASE,
}
