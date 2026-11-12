// Lookup data the frontend needs for forms and filters (category and priority dropdowns), and how passwords are
// delivered (password_delivery: 'email' when email is set up, else 'temporary_password'), so the Users page knows
// whether to offer "Resend link". Decided by the server's settings; the client never chooses.
// Mounted at /api/meta.
const express = require('express')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { isEmailConfigured } = require('../mail/mailer')
const settings = require('../settings')

const router = express.Router()

router.use(requireAuth)

// GET /api/meta → { categories, priorities, password_delivery }
// Every category and priority, archived ones too (is_active: false), because the ticket list filters by them and old
// tickets still have them; a form for a new ticket offers only the active ones. Categories come in sort_order, then
// name; priorities least urgent first, with their rank (and level, its old name, for older clients) and is_default.
// Admins also get each category's ticket_count (the settings page uses it to say whether it can be deleted).
router.get('/', async (req, res) => {
  const [categories, priorities] = await Promise.all([settings.allCategories(), settings.allPriorities()])
  let categoryList = categories.map(({ id, name, description, sort_order: sortOrder, is_active: isActive }) => ({
    id,
    name,
    description,
    sort_order: sortOrder,
    is_active: isActive,
  }))
  if (req.user.role === 'admin') {
    const [rows] = await pool.query('SELECT category_id AS id, COUNT(*) AS n FROM tickets GROUP BY category_id')
    const counts = Object.fromEntries(rows.map((row) => [row.id, Number(row.n)]))
    categoryList = categoryList.map((c) => ({ ...c, ticket_count: counts[c.id] ?? 0 }))
  }
  res.json({
    categories: categoryList,
    priorities: priorities.map(
      ({ id, name, rank, target_hours: targetHours, is_default: isDefault, is_active: isActive }) => ({
        id,
        name,
        level: rank,
        rank,
        target_hours: targetHours,
        is_default: isDefault,
        is_active: isActive,
      }),
    ),
    password_delivery: isEmailConfigured() ? 'email' : 'temporary_password',
  })
})

module.exports = router
