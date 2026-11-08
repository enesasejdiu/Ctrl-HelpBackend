// Central error handling.
// Route handlers throw (or pass to next) an HttpError with a status code; errorHandler turns it into a JSON response.
// Express 5 forwards errors from async handlers automatically, so no try/catch wrappers are needed.

// An error that carries the HTTP status to respond with, e.g. throw new HttpError(404, 'Ticket not found').
// `code` is optional: a fixed name the frontend can react to (e.g. 'PASSWORD_CHANGE_REQUIRED'), sent as { code }.
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (code) this.code = code;
  }
}

// Catch-all for requests that matched no route; register after all routes
function notFound(req, res, next) {
  next(new HttpError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

// Final error handler; Express recognises it as one by its 4 arguments, so keep `next` even though it's unused
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // express.json() rejects a malformed body with a 400; give a clear message instead of the parser's
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Request body is not valid JSON' });
  }

  const status = err.status || 500;

  // Unexpected errors: log the details server-side but never send them to the client
  if (status >= 500) {
    console.error(err);
    return res.status(500).json({ message: 'Something went wrong on the server' });
  }

  // Only our own HttpError codes are sent; other errors can carry a `code` too (e.g. from MySQL) that must stay private
  const code = err instanceof HttpError ? err.code : undefined;
  res.status(status).json(code ? { message: err.message, code } : { message: err.message });
}

module.exports = { HttpError, notFound, errorHandler };
