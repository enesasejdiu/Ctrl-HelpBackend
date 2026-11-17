// ticketVisibility.js – the one place that says which tickets a user may see: staff (agents and admins) see every
// ticket, everyone else (employees, HR) only the ones they raised. Two forms of the same rule:
//   canSeeTicket(user, requesterId)   for one ticket already loaded (GET /api/tickets/:id, its attachments)
//   visibleTicketsSql(user, alias)    as SQL for queries over many tickets (the ticket list, search suggestions), so
//                                     the database does the filtering and nothing the user may not see is ever loaded
const { isStaff } = require('./middleware/auth')

function canSeeTicket(user, requesterId) {
  return isStaff(user) || requesterId === user.id
}

// → { sql, params } to add to a WHERE with AND; sql is null when the user may see every ticket
function visibleTicketsSql(user, alias = 't') {
  return isStaff(user) ? { sql: null, params: [] } : { sql: `${alias}.requester_id = ?`, params: [user.id] }
}

module.exports = { canSeeTicket, visibleTicketsSql }
