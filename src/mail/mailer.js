// The one place that talks to nodemailer. Everything else sends with sendMailSafe({ to, subject, html, text, template })
// (usually through src/mail/notifications.js), which logs a failure instead of throwing, so an email never fails a
// request. isEmailConfigured() says whether email is set up (then passwords go out as one-time links).
//
// What happens to an email depends on config.mail.mode (from src/config.js loadMailConfig):
//   smtp  real SMTP (SMTP_HOST, ...). The server checks the connection once at startup (verify) and only warns if it
//         fails, so a mail outage never stops the API.
//   log   email is not set up (MAIL_ENABLED is not true, or SMTP_HOST / MAIL_FROM is missing): to and subject are
//         printed instead of sending; never the body, a link or a token. A local catcher like Mailpit or MailHog is the alternative (README).
//   test  the test suite: nodemailer's jsonTransport (nothing leaves the process), and every email lands in
//         getMailer().outbox for assertions.
// With MAIL_OUTBOX_DIR set (development and tests only), every email is also saved there as a .json file.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const nodemailer = require('nodemailer')
const { loadMailConfig } = require('../config')

// Removes secrets from an error message before it is logged: the SMTP password, and any set-password token
function redact(message, config) {
  let text = String(message ?? '')
  if (config?.pass) text = text.split(config.pass).join('[redacted]')
  return text.replace(/token=[^\s&"'<>]+/gi, 'token=[redacted]')
}

function createTransport(config) {
  if (config.mode === 'smtp') {
    return nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure, // true = TLS from the start (usually port 465); false = STARTTLS if offered (587)
      ...(config.user && { auth: { user: config.user, pass: config.pass } }),
    })
  }
  if (config.mode === 'test') return nodemailer.createTransport({ jsonTransport: true })
  return null
}

function createMailer(config, { log = console } = {}) {
  let transport = createTransport(config)
  const outbox = []

  function saveToOutboxDir(message) {
    if (!config.outboxDir) return
    fs.mkdirSync(config.outboxDir, { recursive: true })
    const file = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`
    fs.writeFileSync(path.join(config.outboxDir, file), JSON.stringify(message, null, 2))
  }

  // Sends one email. Rejects if the SMTP server refuses it; use sendMailSafe() unless the caller handles that itself.
  // `link` is optional and only kept in the test outbox / MAIL_OUTBOX_DIR, never logged.
  async function sendMail({ to, subject, html, text, link }) {
    const message = { from: config.from, to, subject, text, html }
    saveToOutboxDir({ ...message, link })

    if (config.mode === 'log') {
      log.log(`[mail] Not sent (email is off): to=${to} subject="${subject}"`)
      return { logged: true }
    }

    const info = await transport.sendMail(message)
    if (config.mode === 'test') outbox.push({ ...message, link })
    return info
  }

  // Startup check of the SMTP connection: logs a warning instead of failing
  async function verify() {
    if (config.mode !== 'smtp') {
      if (config.mode === 'log') log.log('[mail] Email is off: emails are logged instead of sent')
      return false
    }
    try {
      await transport.verify()
      log.log(`[mail] SMTP server ${config.host}:${config.port} is ready`)
      return true
    } catch (err) {
      log.warn(
        `[mail] Warning: could not reach the SMTP server ${config.host}:${config.port} (${redact(err.message, config)}). ` +
          'The API keeps running, but emails may not be delivered.',
      )
      return false
    }
  }

  // Sends and never throws: a failure is logged (recipient, template, error; never the SMTP password, the body, a link
  // or a token) and false is returned
  async function sendMailSafe({ template = 'email', ...message }) {
    try {
      await sendMail(message)
      return true
    } catch (err) {
      log.error(`[mail] Could not send "${template}" to ${message.to}: ${redact(err.message, config)}`)
      return false
    }
  }

  return {
    config,
    outbox,
    sendMail,
    sendMailSafe,
    verify,
    // Tests: swap in a transport that fails, to check that a failed email never breaks a request
    setTransport(replacement) {
      transport = replacement
    },
  }
}

// The app's mailer, made on first use from the environment (already checked by src/config.js at startup)
let mailer = null
function getMailer() {
  if (!mailer) mailer = createMailer(loadMailConfig(process.env).mail)
  return mailer
}

// Tests: start again with a fresh mailer (e.g. after changing process.env)
function resetMailer() {
  mailer = null
}

module.exports = {
  createMailer,
  getMailer,
  resetMailer,
  redact,
  sendMail: (message) => getMailer().sendMail(message),
  sendMailSafe: (message) => getMailer().sendMailSafe(message),
  // Email is set up (MAIL_ENABLED=true, SMTP_HOST and MAIL_FROM): decided from the server's settings only
  isEmailConfigured: () => getMailer().config.emailConfigured,
}
