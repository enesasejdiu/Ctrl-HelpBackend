// Express application setup: security headers, CORS, JSON parsing and routes.
// Kept separate from server.js so the app can be imported (e.g. by tests) without listening on a port.
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { notFound, errorHandler } = require('./middleware/errors');
const apiRoutes = require('./routes');

const app = express();

// Global middleware
app.use(helmet()); // sets secure HTTP headers
// Only the frontend's origin, with cookies (credentials). Never "*": browsers refuse credentials with it anyway, and
// without CLIENT_URL no other origin is allowed at all (origin: false) instead of falling back to "*".
app.use(cors({ origin: process.env.CLIENT_URL || false, credentials: true }));
app.use(express.json()); // parse JSON request bodies
app.use(cookieParser()); // req.cookies, for the session and CSRF cookies

// Health check, used to confirm the API is up
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// API routes, from the one list in routes/index.js. Each router runs requireAuth (except POST /api/auth/login), which
// also blocks users who still have a temporary password.
for (const [path, router] of apiRoutes) {
  app.use(path, router);
}

// Error handling: must stay at the very end, after all routes
app.use(notFound); // unknown routes -> 404
app.use(errorHandler); // every other error -> JSON { message }

module.exports = app;
