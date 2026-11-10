// Email notifications: who gets which email for each event. Routes call these AFTER their changes are saved (after
// the commit) and don't await them: the work runs in the background, and an error (a database problem while picking
// recipients, an SMTP failure) is logged and never reaches the request. A failed email never undoes the change.
//
//   passwordLink     new account or reset   → the user (one-time set-password link; only when email is set up)
//   forgotPassword   "Forgot password"      → the account with that email, if any (a reset link; at most one
//                                             every FORGOT_EVERY_MINUTES per account)
//   ticketCreated    new ticket             → IT: IT_NOTIFY_EMAIL if set, otherwise every active agent
//   ticketAssigned   assigned / reassigned  → the new assignee
//   commentAdded     comment by the requester → the assignee, or IT if unassigned
//                    comment by IT (agent/admin) → the requester; internal notes send nothing
//   ticketResolved   resolved               → the requester
//
// Rules for every event: the person who caused it never gets an email about it; deactivated users and users without
// an email address are skipped; each address gets at most one copy.
// Logs say who, which template and what went wrong, never the SMTP password or the email body (links, tokens).
const pool = require('../db')
const { getMailer, redact, sendMailSafe } = require('./mailer')
const templates = require('./templates')
const { TOKEN_HOURS, issueToken } = require('../passwordTokens')
const { recordAudit } = require('../audit')

// "Forgot password" sends an account at most one link this often, so it can't be used to flood someone's inbox
const FORGOT_EVERY_MINUTES = 5

const pending = new Set()

// Runs the work in the background and catches everything
function inBackground(event, work) {
  const job = (async () => {
    try {
      await work()
    } catch (err) {
      console.error(`[mail] ${event}: notification not sent: ${redact(err.message, getMailer().config)}`)
    }
  })()
  pending.add(job)
  job.finally(() => pending.delete(job))
}

// Waits until every notification started so far has finished (tests, and a clean shutdown)
async function settle() {
  while (pending.size > 0) await Promise.all([...pending])
}

// Sends one email; sendMailSafe logs (instead of throwing) if it fails
async function deliver(template, to, message) {
  await sendMailSafe({ template, to, ...message })
}

async function loadUser(id) {
  if (!id) return null
  const [[user]] = await pool.query('SELECT id, name, email, role, is_active FROM users WHERE id = ?', [id])
  return user ?? null
}

async function loadTicket(id) {
  const [[ticket]] = await pool.query(
    `SELECT t.id, t.title, t.description, t.resolution, t.requester_id, t.assigned_to,
            c.name AS category_name, p.name AS priority_name, requester.name AS requester_name
     FROM tickets t
     JOIN users requester ON requester.id = t.requester_id
     JOIN categories c ON c.id = t.category_id
     JOIN priorities p ON p.id = t.priority_id
     WHERE t.id = ?`,
    [id],
  )
  return ticket ?? null
}

// IT, for new tickets and comments on unassigned ones: the shared address if there is one, otherwise the agents.
// A shared address has no user behind it (id null).
async function itTeam() {
  const shared = getMailer().config.itNotifyEmail
  if (shared) return [{ id: null, name: null, email: shared, is_active: true }]
  const [agents] = await pool.query(
    "SELECT id, name, email, role, is_active FROM users WHERE role = 'agent' AND is_active = TRUE ORDER BY id",
  )
  return agents
}

// The people who really get the email: active, with an address, not the actor, each address once
function recipients(people, actor) {
  const seen = new Set()
  const actorEmail = actor?.email?.toLowerCase()
  return people.filter((person) => {
    if (!person || !person.email || !person.is_active) return false
    const email = person.email.toLowerCase()
    if ((actor && person.id === actor.id) || email === actorEmail || seen.has(email)) return false
    seen.add(email)
    return true
  })
}

const appUrl = () => getMailer().config.appUrl

// A one-time password link to the user: purpose 'setup' (new account) or 'reset' (an admin or HR reset it). token is
// the plain token, which only this email carries. Deactivated users get nothing. Only called when email is set up.
function passwordLink({ userId, token, purpose, actorId }) {
  inBackground('passwordLink', async () => {
    const [user, actor] = [await loadUser(userId), await loadUser(actorId)]
    for (const person of recipients([user], null)) {
      const link = templates.links.setPassword(appUrl(), token)
      const message = templates.passwordLink({
        purpose,
        name: person.name,
        email: person.email,
        actor: actor?.name ?? 'An administrator',
        link,
        hours: TOKEN_HOURS,
      })
      await deliver(purpose === 'reset' ? 'passwordReset' : 'accountSetup', person.email, { ...message, link })
    }
  })
}

function ticketCreated({ ticketId, actorId }) {
  inBackground('ticketCreated', async () => {
    const [ticket, actor] = [await loadTicket(ticketId), await loadUser(actorId)]
    if (!ticket) return
    const link = templates.links.ticket(appUrl(), ticket.id)
    for (const person of recipients(await itTeam(), actor)) {
      const message = templates.ticketCreated({ recipientName: person.name, ticket, actor: actor?.name, link })
      await deliver('ticketCreated', person.email, { ...message, link })
    }
  })
}

function ticketAssigned({ ticketId, assigneeId, actorId }) {
  inBackground('ticketAssigned', async () => {
    const [ticket, actor, assignee] = [await loadTicket(ticketId), await loadUser(actorId), await loadUser(assigneeId)]
    if (!ticket) return
    const link = templates.links.ticket(appUrl(), ticket.id)
    for (const person of recipients([assignee], actor)) {
      const message = templates.ticketAssigned({ recipientName: person.name, ticket, actor: actor?.name, link })
      await deliver('ticketAssigned', person.email, { ...message, link })
    }
  })
}

function commentAdded({ commentId, actorId }) {
  inBackground('commentAdded', async () => {
    const [[comment]] = await pool.query('SELECT id, ticket_id, content, is_internal FROM comments WHERE id = ?', [
      commentId,
    ])
    // Internal notes are for IT only: they never email the requester (or anyone)
    if (!comment || comment.is_internal) return
    const [ticket, actor] = [await loadTicket(comment.ticket_id), await loadUser(actorId)]
    if (!ticket) return

    let people
    let reason
    if (actor && actor.id === ticket.requester_id) {
      // The requester wrote: tell whoever handles the ticket, or IT while nobody does
      if (ticket.assigned_to) {
        people = [await loadUser(ticket.assigned_to)]
        reason = 'assignee'
      } else {
        people = await itTeam()
        reason = 'it'
      }
    } else {
      // IT wrote: tell the requester
      people = [await loadUser(ticket.requester_id)]
      reason = 'requester'
    }

    const link = templates.links.ticket(appUrl(), ticket.id)
    for (const person of recipients(people, actor)) {
      const message = templates.commentAdded({
        recipientName: person.name,
        ticket,
        actor: actor?.name,
        comment: comment.content,
        link,
        reason,
      })
      await deliver('commentAdded', person.email, { ...message, link })
    }
  })
}

function ticketResolved({ ticketId, actorId }) {
  inBackground('ticketResolved', async () => {
    const [ticket, actor] = [await loadTicket(ticketId), await loadUser(actorId)]
    if (!ticket) return
    const link = templates.links.ticket(appUrl(), ticket.id)
    for (const person of recipients([await loadUser(ticket.requester_id)], actor)) {
      const message = templates.ticketResolved({ recipientName: person.name, ticket, actor: actor?.name, link })
      await deliver('ticketResolved', person.email, { ...message, link })
    }
  })
}

// "Forgot password" for this email address. Runs entirely in the background, after the response, so the answer and
// its timing are the same whether or not the account exists. An active account gets a 'reset' link (its current
// password keeps working until a new one is set); unknown and deactivated addresses get nothing. A link already sent
// in the last FORGOT_EVERY_MINUTES means nothing new is sent. `ip` is only for the audit log.
function forgotPassword({ email, ip }) {
  inBackground('forgotPassword', async () => {
    const conn = await pool.getConnection()
    let user = null
    let link = null
    try {
      await conn.beginTransaction()
      // Locks the user row: two requests at once can't both send a link
      const [[row]] = await conn.query(
        'SELECT id, name, email, is_active FROM users WHERE email = ? AND is_active = TRUE FOR UPDATE',
        [email],
      )
      if (row) {
        const [[recent]] = await conn.query(
          `SELECT COUNT(*) AS n FROM password_tokens
           WHERE user_id = ? AND purpose = 'reset' AND used_at IS NULL AND created_at > NOW() - INTERVAL ? MINUTE`,
          [row.id, FORGOT_EVERY_MINUTES],
        )
        if (recent.n === 0) {
          user = row
          link = await issueToken(conn, row.id, 'reset')
          await recordAudit('password_reset_requested', { targetUserId: row.id, req: { ip }, db: conn })
        }
      }
      await conn.commit()
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
    if (!user) return
    const url = templates.links.setPassword(appUrl(), link.token)
    const message = templates.passwordLink({
      purpose: 'reset',
      requested: true,
      name: user.name,
      email: user.email,
      link: url,
      hours: TOKEN_HOURS,
    })
    await deliver('passwordForgot', user.email, { ...message, link: url })
  })
}

module.exports = {
  passwordLink,
  forgotPassword,
  ticketCreated,
  ticketAssigned,
  commentAdded,
  ticketResolved,
  settle,
  FORGOT_EVERY_MINUTES,
}
