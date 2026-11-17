// The one ticket-visibility rule (src/ticketVisibility.js), in both its forms: staff see every ticket, everyone else
// (employees and HR) only their own. The routes that use it are tested through the API in matrix.test.js and
// suggestions.test.js; this pins the rule itself.
const { canSeeTicket, visibleTicketsSql } = require('../src/ticketVisibility')

const user = (role, id = 7) => ({ id, role })

describe('canSeeTicket', () => {
  test.each(['agent', 'admin'])('%s sees every ticket', (role) => {
    expect(canSeeTicket(user(role), 99)).toBe(true)
  })

  test.each(['employee', 'hr'])('%s sees only tickets they raised', (role) => {
    expect(canSeeTicket(user(role, 7), 7)).toBe(true)
    expect(canSeeTicket(user(role, 7), 8)).toBe(false)
  })
})

describe('visibleTicketsSql', () => {
  test.each(['agent', 'admin'])('%s: no filter', (role) => {
    expect(visibleTicketsSql(user(role))).toEqual({ sql: null, params: [] })
  })

  test.each(['employee', 'hr'])('%s: only rows they raised, with the id as a parameter (never in the SQL)', (role) => {
    expect(visibleTicketsSql(user(role, 7))).toEqual({ sql: 't.requester_id = ?', params: [7] })
    expect(visibleTicketsSql(user(role, 7), 'x')).toEqual({ sql: 'x.requester_id = ?', params: [7] })
  })
})
