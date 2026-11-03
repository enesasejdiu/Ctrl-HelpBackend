// Entry point: loads environment variables, then starts the HTTP server.
// dotenv must run before app.js is required so process.env is populated for middleware config.
require('dotenv').config();

const app = require('./app');

const PORT = process.env.PORT || 5050;

// Express 5 passes listen errors (e.g. port already in use) to this callback instead of throwing
app.listen(PORT, (err) => {
  if (err) {
    console.error(`Failed to start server on port ${PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`TicketFlow API running at http://localhost:${PORT}`);
});
