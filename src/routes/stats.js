// Dashboard statistics for admins.
// Mounted at /api/stats. GET / returns everything in one object so the dashboard needs a single request.
// "Resolution time" everywhere means hours from created_at to resolved_at, for tickets that have been resolved.
const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { OVERDUE_SQL } = require('../overdue');

const router = express.Router();

// Average resolution time in hours, rounded to 1 decimal (NULL when there's nothing to average).
// Minutes / 60 instead of TIMESTAMPDIFF(HOUR) so a 90-minute fix counts as 1.5h, not 1h.
const AVG_HOURS_SQL = 'ROUND(AVG(TIMESTAMPDIFF(MINUTE, t.created_at, t.resolved_at)) / 60, 1)';

// MySQL returns ROUND/AVG/SUM results as strings (DECIMAL); convert to numbers, keeping NULL as null
function toNumber(value) {
  return value === null ? null : Number(value);
}

router.use(requireAuth, requireRole('admin'));

router.get('/', async (req, res) => {
  // Total number of tickets
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM tickets');

  // How many tickets are in each status (only statuses that occur), in workflow order
  const [byStatus] = await pool.query(
    'SELECT status, COUNT(*) AS count FROM tickets GROUP BY status ORDER BY status'
  );

  // Average resolution time and number of resolved tickets. Closed tickets keep their resolved_at, so they count;
  // tickets moved back to an unfinished status have it cleared, so they don't.
  const [[resolution]] = await pool.query(
    `SELECT ${AVG_HOURS_SQL} AS avg_hours, COUNT(*) AS resolved_count
     FROM tickets t WHERE t.resolved_at IS NOT NULL`
  );

  // Unfinished tickets older than their priority's target time (same rule as the ticket list)
  const [[{ overdueCount }]] = await pool.query(
    `SELECT COUNT(*) AS overdueCount
     FROM tickets t JOIN priorities p ON p.id = t.priority_id
     WHERE ${OVERDUE_SQL}`
  );

  // Per priority: ticket count and average resolution time vs. the target.
  // LEFT JOIN keeps priorities that have no tickets (count 0, avg null).
  const [byPriority] = await pool.query(
    `SELECT p.name, p.target_hours, COUNT(t.id) AS count, ${AVG_HOURS_SQL} AS avg_hours
     FROM priorities p LEFT JOIN tickets t ON t.priority_id = p.id
     GROUP BY p.id
     ORDER BY p.level DESC`
  );

  // Ticket count per category, most tickets first; LEFT JOIN keeps empty categories
  const [byCategory] = await pool.query(
    `SELECT c.name, COUNT(t.id) AS count
     FROM categories c LEFT JOIN tickets t ON t.category_id = c.id
     GROUP BY c.id
     ORDER BY count DESC, c.name`
  );

  // Workload per active agent/admin: tickets currently assigned to them, how many of those are resolved
  // (COUNT ignores NULL resolved_at), and their average resolution time. LEFT JOIN keeps staff with no tickets.
  const [byAgent] = await pool.query(
    `SELECT u.name, COUNT(t.id) AS assigned, COUNT(t.resolved_at) AS resolved, ${AVG_HOURS_SQL} AS avg_hours
     FROM users u LEFT JOIN tickets t ON t.assigned_to = u.id
     WHERE u.is_active = TRUE AND u.role IN ('agent', 'admin')
     GROUP BY u.id
     ORDER BY assigned DESC, u.name`
  );

  // Tickets created vs. resolved per ISO week for the last 8 weeks (including the current one), oldest first.
  // The recursive CTE lists the Monday of each week, so weeks with no activity still appear with 0.
  const [trend] = await pool.query(
    `WITH RECURSIVE weeks (n, monday) AS (
       SELECT 0, CURDATE() - INTERVAL WEEKDAY(CURDATE()) DAY
       UNION ALL
       SELECT n + 1, monday - INTERVAL 1 WEEK FROM weeks WHERE n < 7
     )
     SELECT DATE_FORMAT(w.monday, '%x-W%v') AS week,
       (SELECT COUNT(*) FROM tickets
        WHERE created_at >= w.monday AND created_at < w.monday + INTERVAL 1 WEEK) AS created,
       (SELECT COUNT(*) FROM tickets
        WHERE resolved_at >= w.monday AND resolved_at < w.monday + INTERVAL 1 WEEK) AS resolved
     FROM weeks w
     ORDER BY w.monday`
  );

  res.json({
    total: Number(total),
    byStatus: byStatus.map((r) => ({ status: r.status, count: Number(r.count) })),
    avgResolutionHours: toNumber(resolution.avg_hours),
    resolvedCount: Number(resolution.resolved_count),
    overdueCount: Number(overdueCount),
    byPriority: byPriority.map((r) => ({
      name: r.name,
      target_hours: r.target_hours,
      count: Number(r.count),
      avg_hours: toNumber(r.avg_hours),
    })),
    byCategory: byCategory.map((r) => ({ name: r.name, count: Number(r.count) })),
    byAgent: byAgent.map((r) => ({
      name: r.name,
      assigned: Number(r.assigned),
      resolved: Number(r.resolved),
      avg_hours: toNumber(r.avg_hours),
    })),
    trend: trend.map((r) => ({ week: r.week, created: Number(r.created), resolved: Number(r.resolved) })),
  });
});

module.exports = router;
