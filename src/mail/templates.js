// Email templates: one function per email, each returning { subject, text, html }, all in a shared layout (header,
// the message, a button, and a footer saying why the person gets it). Texts come from strings.js.
//
// Safety:
// - Every piece of user content (names, ticket titles, comments, resolutions) is escaped for the HTML version: the
//   finished plain text of each paragraph is escaped as a whole, so no value can add tags or attributes.
// - Links are built by the caller from APP_URL only (see links below), never from request headers.
// - Subjects are one line: line breaks and control characters in a title become spaces.
const strings = require('./strings')

const EXCERPT_LENGTH = 300
const SUBJECT_TITLE_LENGTH = 120

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// "Hello {name}" + { name: 'Ann' } → "Hello Ann". Unknown placeholders stay as they are.
function fill(text, values = {}) {
  return text.replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
}

// One line, no control characters, at most `max` characters
function oneLine(value, max) {
  // Control characters (line breaks, tabs, NUL, ...) are exactly what this removes
  // eslint-disable-next-line no-control-regex
  const controls = /[\u0000-\u001f\u007f]+/g
  const line = String(value ?? '')
    .replace(controls, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

// At most EXCERPT_LENGTH characters of a comment, description or resolution (line breaks kept)
function excerpt(value) {
  const text = String(value ?? '').trim()
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…` : text
}

// Links into the app. appUrl is APP_URL from the config, without a trailing slash.
const links = {
  ticket: (appUrl, ticketId) => `${appUrl}/tickets/${Number(ticketId)}`,
  setPassword: (appUrl, token) => `${appUrl}/set-password?token=${encodeURIComponent(token)}`,
}

// Builds the email from blocks: { text } paragraphs, { quote } (an excerpt, shown indented) and one { button, link }.
function render({ subject, greetingName, blocks, reason }) {
  const greeting = greetingName ? fill(strings.greeting, { name: greetingName }) : strings.greetingNoName
  const footer = fill(strings.footer, { reason })

  const textParts = [greeting]
  const htmlParts = [`<p style="margin:0 0 16px">${escapeHtml(greeting)}</p>`]
  for (const block of blocks) {
    if (block.text !== undefined) {
      textParts.push(block.text)
      htmlParts.push(`<p style="margin:0 0 16px">${escapeHtml(block.text)}</p>`)
    } else if (block.quote !== undefined) {
      textParts.push(
        block.quote
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
      )
      htmlParts.push(
        `<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #c7d2fe;color:#374151">` +
          `${escapeHtml(block.quote).replace(/\r?\n/g, '<br>')}</blockquote>`,
      )
    } else if (block.button !== undefined) {
      textParts.push(`${block.button}: ${block.link}`)
      htmlParts.push(
        `<p style="margin:24px 0"><a href="${escapeHtml(block.link)}" style="display:inline-block;padding:10px 18px;` +
          `background:#4f46e5;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600">` +
          `${escapeHtml(block.button)}</a></p>` +
          `<p style="margin:0 0 16px;font-size:13px;color:#6b7280">${escapeHtml(block.link)}</p>`,
      )
    }
  }

  const text = `${textParts.join('\n\n')}\n\n--\n${footer}\n${strings.footerAutomatic}\n`
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:8px">
<tr><td style="padding:16px 24px;border-bottom:1px solid #e5e7eb;font-size:18px;font-weight:700;color:#4f46e5">${escapeHtml(strings.appName)}</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.5">${htmlParts.join('\n')}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">${escapeHtml(footer)}<br>${escapeHtml(strings.footerAutomatic)}</td></tr>
</table>
</body></html>`
  return { subject, text, html }
}

const ticketSubject = (template, ticket) =>
  fill(template, { id: ticket.id, title: oneLine(ticket.title, SUBJECT_TITLE_LENGTH) })
const ticketButton = (ticket) => fill(strings.openTicket, { id: ticket.id })

// A one-time password link: purpose 'setup' (new account) or 'reset' (an admin or HR reset the password)
function passwordLink({ purpose, name, email, actor, link, hours }) {
  const s = purpose === 'reset' ? strings.passwordReset : strings.accountSetup
  return render({
    subject: s.subject,
    greetingName: name,
    blocks: [
      { text: fill(s.intro, { actor, email }) },
      { button: s.button, link },
      { text: fill(strings.passwordLink.expiry, { hours }) },
      { text: strings.passwordLink.unexpected },
    ],
    reason: s.reason,
  })
}

// New ticket → IT
function ticketCreated({ recipientName, ticket, actor, link }) {
  const s = strings.ticketCreated
  return render({
    subject: ticketSubject(s.subject, ticket),
    greetingName: recipientName,
    blocks: [
      { text: fill(s.summary, { actor, id: ticket.id, title: oneLine(ticket.title, 255) }) },
      { text: fill(s.details, { category: ticket.category_name, priority: ticket.priority_name }) },
      { quote: excerpt(ticket.description) },
      { button: ticketButton(ticket), link },
    ],
    reason: s.reason,
  })
}

// Assigned or reassigned → the new assignee
function ticketAssigned({ recipientName, ticket, actor, link }) {
  const s = strings.ticketAssigned
  return render({
    subject: ticketSubject(s.subject, ticket),
    greetingName: recipientName,
    blocks: [
      { text: fill(s.summary, { actor, id: ticket.id, title: oneLine(ticket.title, 255) }) },
      { text: fill(s.details, { requester: ticket.requester_name, priority: ticket.priority_name }) },
      { button: ticketButton(ticket), link },
    ],
    reason: s.reason,
  })
}

// New comment → the other side. reason: 'requester' | 'assignee' | 'it'
function commentAdded({ recipientName, ticket, actor, comment, link, reason }) {
  const s = strings.commentAdded
  const reasons = { requester: s.reasonRequester, assignee: s.reasonAssignee, it: s.reasonIt }
  return render({
    subject: ticketSubject(s.subject, ticket),
    greetingName: recipientName,
    blocks: [
      { text: fill(s.summary, { actor, id: ticket.id, title: oneLine(ticket.title, 255) }) },
      { quote: excerpt(comment) },
      { button: ticketButton(ticket), link },
    ],
    reason: reasons[reason],
  })
}

// Resolved → the employee who opened it
function ticketResolved({ recipientName, ticket, actor, link }) {
  const s = strings.ticketResolved
  return render({
    subject: ticketSubject(s.subject, ticket),
    greetingName: recipientName,
    blocks: [
      { text: fill(s.summary, { actor, id: ticket.id, title: oneLine(ticket.title, 255) }) },
      ...(ticket.resolution ? [{ text: s.resolutionLabel }, { quote: excerpt(ticket.resolution) }] : []),
      { text: s.followUp },
      { button: ticketButton(ticket), link },
    ],
    reason: s.reason,
  })
}

module.exports = {
  passwordLink,
  ticketCreated,
  ticketAssigned,
  commentAdded,
  ticketResolved,
  links,
  escapeHtml,
  excerpt,
  EXCERPT_LENGTH,
}
