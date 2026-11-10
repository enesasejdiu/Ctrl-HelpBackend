// Lookup data the frontend needs for forms and filters (category and priority dropdowns), and how passwords are
// delivered (password_delivery: 'email' when email is set up, else 'temporary_password'), so the Users page knows
// whether to offer "Resend link". Decided by the server's settings; the client never chooses.
// Mounted at /api/meta.
const express = require('express')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { isEmailConfigured } = require('../mail/mailer')

const router = express.Router()

router.use(requireAuth)

// GET /api/meta → { categories, priorities, password_delivery }
router.get('/', async (req, res) => {
  const [categories] = await pool.query('SELECT id, name, description FROM categories ORDER BY name')
  const [priorities] = await pool.query('SELECT id, name, level, target_hours FROM priorities ORDER BY level')
  res.json({ categories, priorities, password_delivery: isEmailConfigured() ? 'email' : 'temporary_password' })
})

module.exports = router
