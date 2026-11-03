// Express application setup: security headers, CORS, JSON parsing and routes.
// Kept separate from server.js so the app can be imported (e.g. by tests) without listening on a port.
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { notFound, errorHandler } = require('./middleware/errors');
const authRoutes = require('./routes/auth');
const metaRoutes = require('./routes/meta');
const ticketRoutes = require('./routes/tickets');
const userRoutes = require('./routes/users');
const statsRoutes = require('./routes/stats');

const app = express();

// Global middleware
app.use(helmet()); // sets secure HTTP headers
app.use(cors({ origin: process.env.CLIENT_URL })); // only allow the frontend origin
app.use(express.json()); // parse JSON request bodies

// Health check, used to confirm the API is up
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/users', userRoutes);
app.use('/api/stats', statsRoutes);

// Error handling: must stay at the very end, after all routes
app.use(notFound); // unknown routes -> 404
app.use(errorHandler); // every error -> JSON { message }

module.exports = app;
