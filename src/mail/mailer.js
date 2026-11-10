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

// Retries for an email the SMTP server didn't take: after 30 seconds, 2 minutes and 10 minutes. They live in memory
// only (a restart drops them; Admin/HR can resend a link). Deliberately not a table: the queued emails would hold
// working set-password links in plain text. The test suite retries only when a test asks for it.
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000]

// Worth trying again: an SMTP 4xx ("try later") or no SMTP answer at all (connection refused, timeout, DNS). A 5xx is
// a permanent refusal (unknown address, login refused, ...): trying again won't help.
function isTemporaryFailure(err) {
  const code = Number(err?.responseCode)
  return !(code >= 500 && code < 600)
}

const wait = (ms) =>
  new Promise((resolve) => {
    // unref: a retry waiting here never keeps the process alive on its own
    setTimeout(resolve, ms).unref?.()
  })

function createMailer(config, { log = console, retryDelaysMs = config.mode === 'test' ? [] : RETRY_DELAYS_MS } = {}) {
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

  // Sends and never throws. A temporary failure is tried again after each of retryDelaysMs; when it still fails (or the
  // failure is permanent) it is logged and false is returned. Logs say recipient, template and error; never the SMTP
  // password, the body, a link or a token.
  async function sendMailSafe({ template = 'email', ...message }) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await sendMail(message)
        if (attempt > 1) log.log(`[mail] Sent "${template}" to ${message.to} on attempt ${attempt}`)
        return true
      } catch (err) {
        const reason = redact(err.message, config)
        const delay = retryDelaysMs[attempt - 1]
        if (delay !== undefined && isTemporaryFailure(err)) {
          log.warn(
            `[mail] Could not send "${template}" to ${message.to} (attempt ${attempt}): ${reason}. ` +
              `Trying again in ${Math.round(delay / 1000)} s`,
          )
          await wait(delay)
          continue
        }
        const gaveUp = attempt > 1 ? ` (gave up after ${attempt} attempts)` : ''
        log.error(`[mail] Could not send "${template}" to ${message.to}: ${reason}${gaveUp}`)
        return false
      }
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
  isTemporaryFailure,
  RETRY_DELAYS_MS,
  getMailer,
  resetMailer,
  redact,
  sendMail: (message) => getMailer().sendMail(message),
  sendMailSafe: (message) => getMailer().sendMailSafe(message),
  // Email is set up (MAIL_ENABLED=true, SMTP_HOST and MAIL_FROM): decided from the server's settings only
  isEmailConfigured: () => getMailer().config.emailConfigured,
}
