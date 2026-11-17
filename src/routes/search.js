// Mounted at /api/search; every route requires a logged-in user.
// GET /suggestions?q= → { tickets, articles }: open tickets the user may see and published help articles similar to
// q, for the New ticket form's "Is this the same problem?" (src/search.js has the matching rules). A read: nothing is
// written to the audit log.
const express = require('express')
const { requireAuth } = require('../middleware/auth')
const validate = require('../middleware/validate')
const { suggestionsRateLimit } = require('../middleware/rateLimit')
const schemas = require('../schemas/search')
const { similarTickets, similarArticles } = require('../search')

const router = express.Router()
router.use(requireAuth)

// q is trimmed; under 3 characters → empty lists (200), over 200 → 422. 30 requests a minute per user, then 429.
router.get(
  '/suggestions',
  suggestionsRateLimit,
  validate({ query: schemas.suggestions.query }, { status: 422 }),
  async (req, res) => {
    const q = req.valid.query.q ?? ''
    if (q.length < schemas.SUGGEST_MIN) return res.json({ tickets: [], articles: [] })
    const [tickets, articles] = await Promise.all([similarTickets(q, req.user), similarArticles(q)])
    res.json({ tickets, articles })
  },
)

module.exports = router
