// Email notifications: who gets which email for each event. Routes call these AFTER their changes are saved (after
// the commit) and don't await them: the work runs in the background, and an error (a database problem while picking
// recipients, an SMTP failure) is logged and never reaches the request. A failed email never undoes the change.
//
//   userInvited      new account            → the new user (set-password link)
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
const { getMailer, redact } = require('./mailer')
const templates = require('./templates')
const { INVITE_HOURS } = require('../passwordSetup')

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

// Sends one email and logs (instead of throwing) if it fails
async function deliver(template, to, message) {
  try {
    await getMailer().sendMail({ to, ...message })
  } catch (err) {
    console.error(`[mail] Could not send "${template}" to ${to}: ${redact(err.message, getMailer().config)}`)
  }
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

// New account → the set-password link, to the new user. `token` is the plain token, which only this email carries.
function userInvited({ userId, token, actorId }) {
  inBackground('userInvited', async () => {
    const [user, actor] = [await loadUser(userId), await loadUser(actorId)]
    for (const person of recipients([user], null)) {
      const link = templates.links.setPassword(appUrl(), token)
      const message = templates.invite({
        name: person.name,
        email: person.email,
        actor: actor?.name ?? 'An administrator',
        link,
        hours: INVITE_HOURS,
      })
      await deliver('invite', person.email, { ...message, link })
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

module.exports = { userInvited, ticketCreated, ticketAssigned, commentAdded, ticketResolved, settle }
