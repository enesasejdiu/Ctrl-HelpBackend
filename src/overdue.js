// The overdue rule, shared by the ticket list, the statistics and the escalation job, so all of them always agree.
// A ticket is overdue when it's still unfinished and older than its priority's target time.
// Use in queries where tickets are aliased `t` and priorities `p`.

// The rule as of `at`: an SQL expression for the current time ('NOW()'), or '?' with a time passed as a parameter
// (the escalation job's clock, src/jobs/escalation.js)
const overdueSqlAt = (at) => `(t.status NOT IN ('resolved', 'closed')
  AND TIMESTAMPDIFF(HOUR, t.created_at, ${at}) > p.target_hours)`

const OVERDUE_SQL = overdueSqlAt('NOW()')

module.exports = { OVERDUE_SQL, overdueSqlAt }
