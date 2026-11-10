// Lookup data the frontend needs for forms and filters (category and priority dropdowns).
// Mounted at /api/meta.
const express = require('express')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()

router.use(requireAuth)

// GET /api/meta → { categories, priorities }
router.get('/', async (req, res) => {
  const [categories] = await pool.query('SELECT id, name, description FROM categories ORDER BY name')
  const [priorities] = await pool.query('SELECT id, name, level, target_hours FROM priorities ORDER BY level')
  res.json({ categories, priorities })
})

module.exports = router
