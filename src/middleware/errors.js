// Central error handling.
// Route handlers throw (or pass to next) an HttpError with a status code; errorHandler turns it into a JSON response.
// Express 5 forwards errors from async handlers automatically, so no try/catch wrappers are needed.

// An error that carries the HTTP status to respond with, e.g. throw new HttpError(404, 'Ticket not found').
// `code` is optional: a fixed name the frontend can react to (e.g. 'PASSWORD_CHANGE_REQUIRED'), sent as { code }.
// `details` is optional too: extra fields for the response body, e.g. { user_count: 3 }.
class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    if (code) this.code = code
    if (details) this.details = details
  }
}

const { logger, safePath } = require('../logger')

// Catch-all for requests that matched no route; register after all routes. The path is shown without the query
// string's values (they could be a token), as in the logs.
function notFound(req, res, next) {
  next(new HttpError(404, `Route not found: ${req.method} ${safePath(req.originalUrl)}`))
}

// Logs a failed request on the request's logger (request_id on the line): 5xx at error with the stack, 4xx at warn
// with only the message. Never the body or headers (src/logger.js).
function logFailure(req, status, err) {
  const log = req.log ?? logger
  const context = {
    method: req.method,
    path: safePath(req.originalUrl),
    status,
    ...(req.user?.id && { user_id: req.user.id }),
  }
  if (status >= 500) {
    log.error({ ...context, err }, err.message || 'Unexpected error')
  } else {
    log.warn({ ...context, ...(err.code && typeof err.code === 'string' && { code: err.code }) }, err.message)
  }
}

// Final error handler; Express recognises it as one by its 4 arguments, so keep `next` even though it's unused
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // express.json() rejects a malformed body with a 400; give a clear message instead of the parser's
  if (err.type === 'entity.parse.failed') {
    logFailure(req, 400, err)
    return res.status(400).json({ message: 'Request body is not valid JSON' })
  }
  // Bigger than the limit in app.js (express.json); the body is not read any further
  if (err.type === 'entity.too.large') {
    logFailure(req, 413, err)
    return res.status(413).json({ message: 'Request body is too large (at most 100 KB)', code: 'PAYLOAD_TOO_LARGE' })
  }

  const status = err.status || 500
  logFailure(req, status, err)

  // Unexpected errors: the details are only in the log. The client gets the request id, so a user can quote it and
  // the matching log lines can be found (README "Logs").
  if (status >= 500) {
    const reference = req.id ?? res.getHeader('X-Request-Id')
    return res.status(500).json({ message: `Something went wrong (reference: ${reference})`, request_id: reference })
  }

  // Only our own HttpError codes and details are sent; other errors can carry a `code` too (e.g. from MySQL) that must
  // stay private
  if (!(err instanceof HttpError)) {
    return res.status(status).json({ message: err.message })
  }
  res.status(status).json({ message: err.message, ...(err.code && { code: err.code }), ...err.details })
}

module.exports = { HttpError, notFound, errorHandler }
