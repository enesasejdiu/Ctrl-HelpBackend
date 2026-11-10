// Jest setupFilesAfterEnv: closes this test file's MySQL pool when its tests finish, so Jest exits cleanly
// (no "open handles" warning). Each test file gets its own copy of src/db.js, so each closes its own pool.
const pool = require('../src/db')
const notifications = require('../src/mail/notifications')
const { getMailer } = require('../src/mail/mailer')

// A test's emails finish before the next test starts (and resets the data they read), and every test starts with an
// empty outbox
afterEach(async () => {
  await notifications.settle()
  getMailer().outbox.length = 0
})

afterAll(async () => {
  // Emails go out in the background after a response; let them finish before the pool they read from closes
  await notifications.settle()
  await pool.end()
})
