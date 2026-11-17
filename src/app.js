// Express application setup: security headers, CORS, JSON parsing and routes.
// Kept separate from server.js so the app can be imported (e.g. by tests) without listening on a port.
const express = require('express')
const helmet = require('helmet')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const { notFound, errorHandler } = require('./middleware/errors')
const { requestLogger } = require('./logger')
const apiRoutes = require('./routes')

// Read once, when the app is created: production adds HSTS and trusts the reverse proxy
const isProduction = process.env.NODE_ENV === 'production'

// Largest JSON body accepted; bigger ones get 413 PAYLOAD_TOO_LARGE (see middleware/errors.js). The biggest real body
// (a ticket description) is well under 10 KB.
const BODY_LIMIT = '100kb'
// Knowledge-base articles are up to 100,000 characters of Markdown: in UTF-8 and JSON (escaped line breaks and
// quotes) that can be several hundred KB, so /api/kb alone gets more room
const KB_BODY_LIMIT = '1mb'

const app = express()

// First of all: gives the request its id (X-Request-Id), req.log, and the access log line when it finishes
// (src/logger.js). /api/health is not logged.
app.use(requestLogger)

// Don't tell clients which framework this is (helmet removes the header too; this makes it explicit)
app.disable('x-powered-by')

// Behind proxies (production), the client's real IP is in X-Forwarded-For. Trust exactly TRUST_PROXY_HOPS of them (the
// proxies in front of the API: 1 = nginx, the default; 2 = Caddy → nginx, the HTTPS setup in deploy/), so req.ip (and
// with it the login rate limit and the audit log) is the real client, not a proxy. Trusting more hops than there are
// proxies would let a client pick its own IP, and fewer makes every user look like the proxy. Not in development: there
// is no proxy.
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS) || 1
if (isProduction) app.set('trust proxy', trustProxyHops)

// Security headers for a JSON API. Nothing it sends is a page, so the content security policy allows nothing at all,
// and no site may frame it. HSTS (HTTPS only, for 180 days) only in production: on http://localhost it would make
// the browser refuse plain http for localhost.
app.use(
  helmet({
    // Only these two directives (helmet's defaults are meant for web pages: scripts, styles, fonts)
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    frameguard: { action: 'deny' },
    strictTransportSecurity: isProduction ? { maxAge: 180 * 24 * 60 * 60, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
  }),
)

// CORS: only the frontend's origin, with cookies (credentials), and only the methods and headers the frontend uses.
// The origin is compared exactly with CLIENT_URL; any other origin (and every origin when CLIENT_URL is not set) gets
// no CORS headers at all, so the browser blocks other sites from reading responses. Never "*": browsers refuse
// credentials with it anyway.
const allowedOrigin = process.env.CLIENT_URL
app.use(
  cors({
    origin: (origin, callback) => callback(null, Boolean(allowedOrigin) && origin === allowedOrigin),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    maxAge: 600, // browsers may cache a preflight answer for 10 minutes
  }),
)
// The first parser that reads a body marks it read, so /api/kb's larger limit applies there and BODY_LIMIT everywhere else
app.use('/api/kb', express.json({ limit: KB_BODY_LIMIT }))
app.use(express.json({ limit: BODY_LIMIT })) // parse JSON request bodies
app.use(cookieParser()) // req.cookies, for the session and CSRF cookies

// Health check, used to confirm the API is up
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' })
})

// API routes, from the one list in routes/index.js. Each router runs requireAuth (except POST /api/auth/login), which
// also blocks users who still have a temporary password.
for (const [path, router] of apiRoutes) {
  app.use(path, router)
}

// Error handling: must stay at the very end, after all routes
app.use(notFound) // unknown routes -> 404
app.use(errorHandler) // every other error -> JSON { message }

module.exports = app
