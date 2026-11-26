// API documentation: the OpenAPI 3.0 spec (built by swagger-jsdoc from the @openapi JSDoc blocks in src/routes/ and
// the shared components in src/docs/components.yaml) and the Swagger UI options. app.js serves the UI at /api-docs and
// the raw spec at /api-docs.json.
//
// The spec is built once, when this file is first required. It describes the API; it never changes how a route
// behaves.
//
// How to try requests from the docs page: authentication is the httpOnly tf_session cookie set by POST /api/auth/login
// (src/session.js), not a Bearer token. Swagger UI is served by this same server, so after "Try it out" on
// POST /api/auth/login the browser keeps the cookie and sends it with every later request. Changes
// (POST/PATCH/PUT/DELETE) also need X-CSRF-Token: requestInterceptor below copies it from the readable tf_csrf cookie,
// so nothing has to be pasted into "Authorize".
const path = require('path')
const swaggerJsdoc = require('swagger-jsdoc')
const { version } = require('../../package.json')

// Where "Try it out" sends requests. API_URL is the API's public address (e.g. https://helpdesk.example.com when
// nginx serves the API under the same origin); the fallback is this server on localhost.
const serverUrl = (process.env.API_URL || `http://localhost:${process.env.PORT || 5050}`).replace(/\/+$/, '')

const definition = {
  openapi: '3.0.3',
  info: {
    title: 'IT Helpdesk API',
    version,
    description: [
      'Internal IT helpdesk (TicketFlow): employees report problems as tickets, IT staff (agents) work them, admins',
      'manage settings and see statistics, and HR manages employee accounts. There is no self-registration: accounts',
      'are created by an admin or HR (`POST /api/users`).',
      '',
      '### Roles',
      '| Role (API value) | Who | Can |',
      '|---|---|---|',
      '| `employee` | Employee | Raise tickets, see and comment on their own tickets, close/reopen them once resolved, rate them |',
      '| `agent` | IT staff | See and work every ticket, internal notes, take/release tickets, write knowledge-base articles |',
      '| `admin` | Administrator | Everything agents can, plus users, settings, statistics, audit log, deleting |',
      '| `hr` | HR | Manage **employee** accounts and departments; for tickets, HR works like an employee |',
      '',
      '"Staff" in this document means `agent` and `admin`.',
      '',
      '### Authentication',
      '1. Call `POST /api/auth/login` (use **Try it out** below). The response sets two cookies:',
      '   `tf_session` (the session token, httpOnly) and `tf_csrf`.',
      '2. Your browser now sends `tf_session` with every request from this page automatically.',
      '3. Every `POST`, `PATCH`, `PUT` and `DELETE` also needs the header `X-CSRF-Token` with the value of the',
      '   `tf_csrf` cookie. This page adds it for you. Other clients (curl, Postman) must copy it themselves.',
      '',
      'An `Authorization: Bearer` header is **ignored** by this API. A user who still has a temporary password',
      '(`must_change_password: true`) gets `403 PASSWORD_CHANGE_REQUIRED` everywhere except `GET /api/auth/me` and',
      '`POST /api/auth/change-password`.',
      '',
      '### Errors',
      'Every error is JSON with a `message` ready to show, and for some errors a fixed `code` to react to.',
      'Failed request validation answers `{ message, errors: [{ field, message }] }`.',
      '',
      '### Lists',
      '`GET /api/tickets` and `GET /api/users` return a plain array unless `page` is sent; with `page` they return',
      '`{ items, total, page, pageSize }`.',
    ].join('\n'),
  },
  servers: [{ url: serverUrl, description: process.env.API_URL ? 'API_URL' : 'Local development server' }],
  // Every endpoint needs the session cookie unless it says otherwise (security: [] on the public ones)
  security: [{ cookieAuth: [] }],
  tags: [
    { name: 'Auth', description: 'Login, logout, the current user, and passwords' },
    { name: 'Users', description: 'User accounts (created by admin or HR only)' },
    { name: 'Tickets', description: 'Problems reported by employees' },
    { name: 'Comments', description: 'Replies and staff-only internal notes on a ticket' },
    { name: 'Ratings', description: "The requester's satisfaction rating of a closed ticket" },
    { name: 'Attachments', description: 'Files on tickets (images, PDFs, text, CSV)' },
    { name: 'Statistics', description: 'Dashboard numbers, including resolution times (admin)' },
    { name: 'Departments', description: 'Company departments users belong to' },
    { name: 'Categories', description: 'Ticket categories (admin settings)' },
    { name: 'Priorities', description: 'Ticket priorities and their target resolution times (admin settings)' },
    { name: 'Settings', description: 'Company-wide settings' },
    { name: 'Meta', description: 'Lookup data for forms and filters' },
    { name: 'Knowledge Base', description: 'Help articles and their categories' },
    { name: 'Canned Responses', description: 'Prepared replies for staff' },
    { name: 'Search', description: 'Similar tickets and articles while writing a new ticket' },
    { name: 'Audit', description: 'Security and admin audit log (admin)' },
    { name: 'Health', description: 'Liveness check' },
  ],
}

const spec = swaggerJsdoc({
  definition,
  apis: [
    path.join(__dirname, '../routes/*.js'),
    path.join(__dirname, '../app.js'),
    path.join(__dirname, 'components.yaml'),
  ],
  failOnErrors: true, // a YAML mistake in a JSDoc block stops the server instead of silently dropping the endpoint
})

// Runs in the browser (swagger-ui-express writes it into swagger-ui-init.js, so it must not use anything from this
// file): copies the tf_csrf cookie into X-CSRF-Token, unless one was entered under "Authorize"
/* global document -- this function runs in the browser, not in Node */
function requestInterceptor(request) {
  const match = document.cookie.match(/(?:^|;\s*)tf_csrf=([^;]+)/)
  const hasHeader = Object.keys(request.headers).some((name) => name.toLowerCase() === 'x-csrf-token')
  if (match && !hasHeader) request.headers['X-CSRF-Token'] = decodeURIComponent(match[1])
  return request
}

const uiOptions = {
  customSiteTitle: 'IT Helpdesk API docs',
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    docExpansion: 'none',
    filter: true,
    tryItOutEnabled: false,
    validatorUrl: null, // never send the spec to swagger.io's validator
    requestInterceptor,
  },
}

// The docs page loads scripts, styles and images, which the API's own policy (default-src 'none', app.js) forbids.
// This one allows only this server's files (plus the inline styles Swagger UI uses), and requests to the API itself.
const connectSources = ["'self'", new URL(serverUrl).origin].filter((value, index, all) => all.indexOf(value) === index)
const DOCS_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src ${connectSources.join(' ')}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

module.exports = { spec, uiOptions, DOCS_CSP, serverUrl }
