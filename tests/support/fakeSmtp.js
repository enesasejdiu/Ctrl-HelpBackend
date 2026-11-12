// A real SMTP server inside the test process (smtp-server), so the app sends through its own nodemailer SMTP transport
// (the same code path as production) and the tests read what actually went over the wire, parsed with mailparser.
// Each test file starts its own server on a free port, so files running in parallel never see each other's mail.
//
//   const smtp = await startFakeSmtp()
//   beforeEach(() => smtp.useForApp())          // point the app's mailer at it (email set up, real SMTP)
//   const mail = await smtp.waitForMail({ to: 'ann@test.local', subject: /Reset/ })
//   smtp.extractLink(mail)                      // the first link into APP_URL in the text part
//   smtp.setMode('reject-connections')          // greeting 554: every send fails at once (a permanent error)
//   smtp.setMode('5xx')                         // 550 on RCPT TO: the server refuses every message
//   afterAll(() => smtp.stop())
//
// Only 5xx failures are simulated: a 4xx or a dropped connection makes the app wait 30 s before retrying
// (RETRY_DELAYS_MS in src/mail/mailer.js), which no test should sit through.
const { SMTPServer } = require('smtp-server')
const { simpleParser } = require('mailparser')
const { resetMailer, getMailer } = require('../../src/mail/mailer')
const notifications = require('../../src/mail/notifications')

const MAIL_FROM = 'Acme Helpdesk <helpdesk@acme.test>'
const SMTP_USER = 'smtp-test-user'
const SMTP_PASS = 'smtp-pass-Zq7-never-in-a-header'

async function startFakeSmtp() {
  const mails = []
  let mode = 'accept'
  const auths = []

  const server = new SMTPServer({
    // Plain SMTP on localhost: no TLS to set up, and login allowed without it (nodemailer sends AUTH PLAIN)
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authOptional: true,
    logger: false,
    onConnect(session, callback) {
      if (mode === 'reject-connections') {
        const err = new Error('No SMTP service here (test)')
        err.responseCode = 554
        return callback(err)
      }
      callback()
    },
    onAuth(auth, session, callback) {
      auths.push({ username: auth.username, password: auth.password })
      callback(null, { user: auth.username })
    },
    onRcptTo(address, session, callback) {
      if (mode === '5xx') {
        const err = new Error('Mailbox unavailable (test)')
        err.responseCode = 550
        return callback(err)
      }
      callback()
    },
    onData(stream, session, callback) {
      const chunks = []
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('end', async () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        try {
          const parsed = await simpleParser(raw)
          // Pushed before the 250 reply, so once the app's send has resolved the mail is here
          mails.push({
            envelope: {
              from: session.envelope.mailFrom?.address,
              to: session.envelope.rcptTo.map((r) => r.address),
            },
            raw,
            headers: parsed.headerLines.map((line) => line.line),
            // "Name <address>" (mailparser's own text quotes the name)
            from: parsed.from ? `${parsed.from.value[0].name} <${parsed.from.value[0].address}>` : undefined,
            to: parsed.to?.value.map((v) => v.address) ?? [],
            subject: parsed.subject,
            text: parsed.text ?? '',
            html: typeof parsed.html === 'string' ? parsed.html : '',
          })
          callback()
        } catch (err) {
          callback(err)
        }
      })
    },
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.server.address()

  // Email set up (MAIL_ENABLED, SMTP_HOST, MAIL_FROM; enabled: false = MAIL_ENABLED=false, the log mode) and pointed at this server, with a login so the tests can check
  // the password never ends up anywhere. NODE_ENV=test would force nodemailer's jsonTransport, so the mailer is built
  // with NODE_ENV=development for that one synchronous moment and then cached (getMailer is a singleton);
  // tests/setupAfterEnv.js resets it after every test, so call this in a beforeEach.
  function useForApp({ login = true, enabled = true } = {}) {
    Object.assign(process.env, {
      MAIL_ENABLED: enabled ? 'true' : 'false',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port),
      SMTP_SECURE: 'false',
      MAIL_FROM,
      SMTP_USER: login ? SMTP_USER : '',
      SMTP_PASS: login ? SMTP_PASS : '',
    })
    const nodeEnv = process.env.NODE_ENV
    resetMailer()
    try {
      process.env.NODE_ENV = 'development'
      const mailer = getMailer()
      const expected = enabled ? 'smtp' : 'log'
      if (mailer.config.mode !== expected) throw new Error(`expected the ${expected} mailer, got ${mailer.config.mode}`)
    } finally {
      process.env.NODE_ENV = nodeEnv
    }
  }

  // Email off again (the suite's default) and the SMTP settings cleared
  function stopUsingForApp() {
    for (const key of [
      'MAIL_ENABLED',
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_SECURE',
      'MAIL_FROM',
      'SMTP_USER',
      'SMTP_PASS',
    ]) {
      process.env[key] = ''
    }
    resetMailer()
  }

  // Every mail received so far, once the app's background notifications have finished
  async function getMails() {
    await notifications.settle()
    return [...mails]
  }

  function clearMails() {
    mails.length = 0
    auths.length = 0
  }

  const matches = (value, expected) =>
    expected === undefined || (expected instanceof RegExp ? expected.test(value ?? '') : value === expected)

  // The first mail to `to` whose subject matches (a string or a RegExp). Polls every 20 ms, up to timeoutMs, for mail
  // the app sends in the background; no fixed sleeps.
  async function waitForMail({ to, subject } = {}, { timeoutMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = mails.find(
        (mail) => (to === undefined || mail.envelope.to.includes(to.toLowerCase())) && matches(mail.subject, subject),
      )
      if (found) return found
      if (Date.now() > deadline) {
        const seen = mails.map((m) => `${m.envelope.to.join(',')}: ${m.subject}`).join('; ') || 'none'
        throw new Error(`No mail to ${to} with subject ${subject} within ${timeoutMs} ms (received: ${seen})`)
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  // The first link in the plain-text part that starts with `base` (default: APP_URL), or null
  function extractLink(mail, base = process.env.APP_URL) {
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`${escaped}[^\\s"'<>)]*`).exec(mail.text)
    return match ? match[0] : null
  }

  return {
    port,
    mails,
    auths,
    MAIL_FROM,
    SMTP_PASS,
    useForApp,
    stopUsingForApp,
    getMails,
    clearMails,
    waitForMail,
    extractLink,
    setMode(next) {
      if (!['accept', 'reject-connections', '5xx'].includes(next)) throw new Error(`unknown mode ${next}`)
      mode = next
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  }
}

module.exports = { startFakeSmtp, MAIL_FROM, SMTP_PASS }
