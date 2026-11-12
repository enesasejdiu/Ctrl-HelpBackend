// Every text the emails use, in one place (English only for now; a second language would be a second object here).
// {name}-style placeholders are filled in by templates.js, which escapes the values for the HTML version.
// {company} is the company name from the admin settings (src/settings.js; "TicketFlow" until an admin changes it).
module.exports = {
  greeting: 'Hello {name},',
  greetingNoName: 'Hello,',
  openTicket: 'Open ticket #{id}',
  footer: "You're receiving this because {reason}.",
  footerAutomatic: 'This is an automatic message from {company}. Replies to this email are not read.',

  // The two one-time password links (src/passwordTokens.js)
  passwordLink: {
    expiry: 'This link expires in {hours} hours and can be used once.',
    unexpected: "If you didn't expect this, contact your administrator.",
  },
  accountSetup: {
    subject: 'Set up your {company} account',
    intro: '{actor} created a {company} account for you ({email}). Choose a password to sign in.',
    button: 'Set your password',
    reason: 'an account was created for you in {company}',
  },
  // "Forgot password" on the sign-in page (purpose 'forgot': 1 hour; the current password keeps working)
  passwordForgot: {
    subject: 'Reset your {company} password',
    intro: 'We received a request to reset the password of your {company} account ({email}).',
    button: 'Choose a new password',
    expiry: 'This link expires in 1 hour and can be used once.',
    ignore: "If you didn't request this, you can ignore this email. Your password hasn't changed.",
    reason: 'a password reset was requested for your {company} account',
  },
  // After a "Forgot password" link set a new password (no link in it)
  passwordChanged: {
    subject: 'Your {company} password was changed',
    body: "Your {company} password was changed. If this wasn't you, contact your administrator.",
    reason: 'the password of your {company} account was changed',
  },
  passwordReset: {
    subject: 'Reset your {company} password',
    intro:
      '{actor} reset the password of your {company} account ({email}). Your old password no longer works. Choose a new one to sign in.',
    button: 'Choose a new password',
    reason: 'the password of your {company} account was reset',
  },
  ticketCreated: {
    subject: '[{company} #{id}] New ticket: {title}',
    summary: '{actor} opened ticket #{id}: {title}',
    details: 'Category: {category} · Priority: {priority}',
    reason: "you're on the IT team that handles new tickets",
  },
  ticketAssigned: {
    subject: '[{company} #{id}] Assigned to you: {title}',
    summary: '{actor} assigned ticket #{id} to you: {title}',
    details: 'Requested by {requester} · Priority: {priority}',
    reason: 'a ticket was assigned to you',
  },
  commentAdded: {
    subject: '[{company} #{id}] New comment: {title}',
    summary: '{actor} commented on ticket #{id}: {title}',
    reasonRequester: 'you opened this ticket',
    reasonAssignee: 'this ticket is assigned to you',
    reasonIt: "you're on the IT team and this ticket has no one assigned yet",
  },
  ticketResolved: {
    subject: '[{company} #{id}] Resolved: {title}',
    summary: '{actor} resolved your ticket #{id}: {title}',
    resolutionLabel: 'Resolution:',
    followUp: "If it isn't fixed, open the ticket and reopen it.",
    reason: 'you opened this ticket',
  },
}
