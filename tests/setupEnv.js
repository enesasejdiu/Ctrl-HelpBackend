// Jest setupFiles: runs in every test file BEFORE any app code is loaded, so src/db.js connects to the test database.
const { assertTestDbName } = require('./testDb')

// Set by tests/globalSetup.js; throws (before anything connects) if it is missing or not a test database
process.env.DB_NAME = assertTestDbName(process.env.TEST_DB_NAME)
process.env.JWT_SECRET = 'test-only-jwt-secret-not-used-anywhere-else'
process.env.NODE_ENV = 'test'
// The frontend origin CORS allows (with credentials); fixed so the CORS tests don't depend on .env
process.env.CLIENT_URL = 'http://localhost:5173'
// Email: NODE_ENV=test always uses nodemailer's jsonTransport (nothing is sent). Links come from APP_URL; the shared IT
// address and the outbox folder are off unless a test sets them. A blank value counts as not set, and dotenv never
// overwrites it, so the developer's .env can't change what the tests see.
process.env.APP_URL = 'http://localhost:5173'
process.env.IT_NOTIFY_EMAIL = ''
process.env.MAIL_OUTBOX_DIR = ''
process.env.SMTP_USER = ''
process.env.SMTP_PASS = ''

// Host, user and password from .env. dotenv never overwrites variables that are already set, so DB_NAME stays.
require('dotenv').config({ quiet: true })
