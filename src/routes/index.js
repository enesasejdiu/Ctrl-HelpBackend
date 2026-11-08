// Every API router and the path it's mounted at. app.js mounts exactly these, and tests/routes.test.js walks the same
// list to check that every route needs a login and respects must_change_password, so a new router added here is
// checked automatically.
module.exports = [
  ['/api/auth', require('./auth')],
  ['/api/meta', require('./meta')],
  ['/api/tickets', require('./tickets')],
  ['/api/users', require('./users')],
  ['/api/stats', require('./stats')],
  ['/api/departments', require('./departments')],
];
