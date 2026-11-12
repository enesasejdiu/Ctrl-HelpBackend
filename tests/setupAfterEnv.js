// Jest setupFilesAfterEnv: closes this test file's MySQL pool when its tests finish, so Jest exits cleanly
// (no "open handles" warning). Each test file gets its own copy of src/db.js, so each closes its own pool.
const fs = require('fs')
const os = require('os')
const path = require('path')
const pool = require('../src/db')
const notifications = require('../src/mail/notifications')
const { getMailer, resetMailer } = require('../src/mail/mailer')

// Before any test file creates data: the pool must really be on the throwaway ticketflow_test_* database, on a local
// or CI server (tests/support/guard.js). Otherwise the whole file stops here.
beforeAll(async () => {
  await require('./support/guard').assertThrowawayDb()
})

// A test's emails finish before the next test starts (and resets the data they read), and every test starts with an
// empty outbox, with email not set up again (the default; see useEmail() in helpers.js)
afterEach(async () => {
  await notifications.settle()
  getMailer().outbox.length = 0
  process.env.MAIL_ENABLED = ''
  process.env.SMTP_HOST = ''
  process.env.MAIL_FROM = ''
  resetMailer()
})

afterAll(async () => {
  // Emails go out in the background after a response; let them finish before the pool they read from closes
  await notifications.settle()
  await pool.end()
  // This file's attachments folder (setupEnv.js); only ever a ticketflow-uploads-* folder in the OS temp folder
  const dir = process.env.UPLOAD_DIR
  if (dir && path.basename(dir).startsWith('ticketflow-uploads-') && dir.startsWith(os.tmpdir())) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
