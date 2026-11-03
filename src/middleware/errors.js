// Central error handling.
// Route handlers throw (or pass to next) an HttpError with a status code; errorHandler turns it into a JSON response.
// Express 5 forwards errors from async handlers automatically, so no try/catch wrappers are needed.

// An error that carries the HTTP status to respond with, e.g. throw new HttpError(404, 'Ticket not found')
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// Catch-all for requests that matched no route; register after all routes
function notFound(req, res, next) {
  next(new HttpError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

// Final error handler; Express recognises it as one by its 4 arguments, so keep `next` even though it's unused
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;

  // Unexpected errors: log the details server-side but never send them to the client
  if (status >= 500) {
    console.error(err);
    return res.status(500).json({ message: 'Something went wrong on the server' });
  }

  res.status(status).json({ message: err.message });
}

module.exports = { HttpError, notFound, errorHandler };
