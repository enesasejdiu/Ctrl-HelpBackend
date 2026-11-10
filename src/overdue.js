// The overdue rule, shared by the ticket list and the statistics so both always agree.
// A ticket is overdue when it's still unfinished and older than its priority's target time.
// Use in queries where tickets are aliased `t` and priorities `p`.
const OVERDUE_SQL = `(t.status NOT IN ('resolved', 'closed')
  AND TIMESTAMPDIFF(HOUR, t.created_at, NOW()) > p.target_hours)`

module.exports = { OVERDUE_SQL }
