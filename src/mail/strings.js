// Every text the emails use, in one place (English only for now; a second language would be a second object here).
// {name}-style placeholders are filled in by templates.js, which escapes the values for the HTML version.
module.exports = {
  appName: 'TicketFlow',
  greeting: 'Hello {name},',
  greetingNoName: 'Hello,',
  openTicket: 'Open ticket #{id}',
  footer: "You're receiving this because {reason}.",
  footerAutomatic: 'This is an automatic message from TicketFlow. Replies to this email are not read.',

  invite: {
    subject: 'Set your TicketFlow password',
    intro: '{actor} created a TicketFlow account for you ({email}). Choose your password to sign in.',
    button: 'Set your password',
    expiry: 'The link works once and expires in {hours} hours. If it has expired, ask {actor} to send you a new one.',
    reason: 'an account was created for you in TicketFlow',
  },
  ticketCreated: {
    subject: '[TicketFlow #{id}] New ticket: {title}',
    summary: '{actor} opened ticket #{id}: {title}',
    details: 'Category: {category} · Priority: {priority}',
    reason: "you're on the IT team that handles new tickets",
  },
  ticketAssigned: {
    subject: '[TicketFlow #{id}] Assigned to you: {title}',
    summary: '{actor} assigned ticket #{id} to you: {title}',
    details: 'Requested by {requester} · Priority: {priority}',
    reason: 'a ticket was assigned to you',
  },
  commentAdded: {
    subject: '[TicketFlow #{id}] New comment: {title}',
    summary: '{actor} commented on ticket #{id}: {title}',
    reasonRequester: 'you opened this ticket',
    reasonAssignee: 'this ticket is assigned to you',
    reasonIt: "you're on the IT team and this ticket has no one assigned yet",
  },
  ticketResolved: {
    subject: '[TicketFlow #{id}] Resolved: {title}',
    summary: '{actor} resolved your ticket #{id}: {title}',
    resolutionLabel: 'Resolution:',
    followUp: "If it isn't fixed, open the ticket and reopen it.",
    reason: 'you opened this ticket',
  },
}
