// Jest setupFiles: runs in every test file BEFORE any app code is loaded, so src/db.js connects to the test database.
const { assertTestDbName } = require('./testDb')

// Set by tests/globalSetup.js; throws (before anything connects) if it is missing or not a test database
process.env.DB_NAME = assertTestDbName(process.env.TEST_DB_NAME)
process.env.JWT_SECRET = 'test-only-jwt-secret-not-used-anywhere-else'
process.env.NODE_ENV = 'test'
// The frontend origin CORS allows (with credentials); fixed so the CORS tests don't depend on .env
process.env.CLIENT_URL = 'http://localhost:5173'
// Never listened on (supertest uses its own port); set so scripts that run the server's config check
// (scripts/create-admin.js) pass it without a .env, as in CI. Tests that start a real server pass their own PORT.
process.env.PORT = '5050'
// Email: NODE_ENV=test always uses nodemailer's jsonTransport (nothing is sent). Links come from APP_URL; the shared IT
// address and the outbox folder are off unless a test sets them. A blank value counts as not set, and dotenv never
// overwrites it, so the developer's .env can't change what the tests see.
process.env.APP_URL = 'http://localhost:5173'
process.env.IT_NOTIFY_EMAIL = ''
process.env.MAIL_OUTBOX_DIR = ''
process.env.SMTP_USER = ''
process.env.SMTP_PASS = ''
// Email is not set up by default, so passwords are temporary ones (the fallback). Tests for the emailed links switch it
// on with useEmail() from helpers.js; nothing is sent either way.
process.env.MAIL_ENABLED = ''
process.env.SMTP_HOST = ''
process.env.MAIL_FROM = ''

// Attachment files go to a new, empty folder for each test file, deleted when that file's tests are done
// (setupAfterEnv.js), so tests never write into the real ./uploads
process.env.UPLOAD_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ticketflow-uploads-'))

// Attachments: a 200 KB size limit instead of 10 MB, so no test has to build big files (only allowed with NODE_ENV=test).
// The one test of the real 10 MB limit (tests/real-size/) clears it, and runs in its own Jest run.
process.env.ATTACHMENT_MAX_BYTES = String(200 * 1024)

// Host, user and password from .env. dotenv never overwrites variables that are already set, so DB_NAME stays.
require('dotenv').config({ quiet: true })
