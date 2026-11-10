// Jest setupFilesAfterEnv: closes this test file's MySQL pool when its tests finish, so Jest exits cleanly
// (no "open handles" warning). Each test file gets its own copy of src/db.js, so each closes its own pool.
const pool = require('../src/db')
const notifications = require('../src/mail/notifications')
const { getMailer, resetMailer } = require('../src/mail/mailer')

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
})
