// The mailer itself (src/mail/mailer.js), outside the test-mode transport: log mode in development, the startup SMTP
// check, the outbox folder, and the redaction of secrets in its messages.
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { createMailer, redact } = require('../src/mail/mailer')
const { loadMailConfig } = require('../src/config')

const fakeLog = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() })
const message = {
  to: 'ann@test.local',
  subject: 'Set your TicketFlow password',
  text: 'secret body text',
  html: '<p>secret body text</p>',
  link: 'http://localhost:5173/set-password?token=tok123',
}

describe('log mode (development with MAIL_ENABLED=false or no SMTP host)', () => {
  test('logs to, subject and the link instead of sending, and never the body', async () => {
    const { mail } = loadMailConfig({ NODE_ENV: 'development', MAIL_ENABLED: 'false', SMTP_HOST: 'smtp.example.com' })
    expect(mail.mode).toBe('log')
    const log = fakeLog()
    const result = await createMailer(mail, { log }).sendMail(message)

    expect(result).toEqual({ logged: true })
    expect(log.log).toHaveBeenCalledTimes(1)
    const [line] = log.log.mock.calls[0]
    expect(line).toContain('to=ann@test.local')
    expect(line).toContain('subject="Set your TicketFlow password"')
    expect(line).toContain('link=http://localhost:5173/set-password?token=tok123')
    expect(line).not.toContain('secret body text')
  })

  test('development without SMTP_HOST logs too', () => {
    expect(loadMailConfig({ NODE_ENV: 'development' }).mail.mode).toBe('log')
  })

  test('in production (MAIL_ENABLED=false) the link is left out of the log', async () => {
    const { mail } = loadMailConfig({ NODE_ENV: 'production', MAIL_ENABLED: 'false' })
    const log = fakeLog()
    await createMailer(mail, { log }).sendMail(message)
    expect(log.log.mock.calls[0][0]).not.toContain('tok123')
  })
})

describe('the startup check (verify)', () => {
  test('an unreachable SMTP server is a warning, not a crash, and the password is not in it', async () => {
    // A port nothing listens on: take a free one and close it again
    const port = await new Promise((resolve) => {
      const server = net.createServer().listen(0, '127.0.0.1', () => {
        const { port: free } = server.address()
        server.close(() => resolve(free))
      })
    })
    const { mail } = loadMailConfig({
      NODE_ENV: 'development',
      MAIL_ENABLED: 'true',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port),
      SMTP_USER: 'mailer',
      SMTP_PASS: 'smtp-pass-do-not-log',
    })
    expect(mail.mode).toBe('smtp')
    const log = fakeLog()
    await expect(createMailer(mail, { log }).verify()).resolves.toBe(false)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toMatch(/could not reach the SMTP server 127\.0\.0\.1:\d+/)
    expect(log.warn.mock.calls[0][0]).toMatch(/The API keeps running/)
    expect(log.warn.mock.calls[0][0]).not.toContain('smtp-pass-do-not-log')
  })

  test('log mode says emails are off', async () => {
    const log = fakeLog()
    await createMailer(loadMailConfig({ NODE_ENV: 'development' }).mail, { log }).verify()
    expect(log.log.mock.calls[0][0]).toMatch(/Email is off/)
  })
})

describe('MAIL_OUTBOX_DIR (development and tests)', () => {
  test('saves every email as a .json file; ignored in production', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticketflow-outbox-'))
    try {
      const { mail } = loadMailConfig({ NODE_ENV: 'development', MAIL_OUTBOX_DIR: dir })
      await createMailer(mail, { log: fakeLog() }).sendMail(message)
      const files = fs.readdirSync(dir)
      expect(files).toHaveLength(1)
      expect(JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'))).toMatchObject({
        to: 'ann@test.local',
        subject: 'Set your TicketFlow password',
        link: message.link,
      })

      const production = loadMailConfig({ NODE_ENV: 'production', MAIL_ENABLED: 'false', MAIL_OUTBOX_DIR: dir })
      expect(production.mail.outboxDir).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('redact', () => {
  test('removes the SMTP password and set-password tokens', () => {
    const text = redact('auth failed for pw123 at https://x/set-password?token=abc-DEF_1&x=1', { pass: 'pw123' })
    expect(text).toBe('auth failed for [redacted] at https://x/set-password?token=[redacted]&x=1')
  })
})
