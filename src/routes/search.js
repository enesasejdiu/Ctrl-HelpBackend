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
/**
 * @openapi
 * /api/search/suggestions:
 *   get:
 *     tags: [Search]
 *     summary: Similar tickets and articles ("Is this the same problem?")
 *     description: |
 *       **Roles:** any logged-in user. Full-text match of `q` (usually a new ticket's title) against unfinished
 *       tickets the user may see (staff: all; others: their own) and published knowledge-base articles. Up to 5 of
 *       each, best match first. Under 3 characters → empty lists. 30 requests per minute per user.
 *     parameters:
 *       - name: q
 *         in: query
 *         description: Trimmed; at most 200 characters
 *         schema: { type: string, maxLength: 200, example: printer jams }
 *     responses:
 *       '200':
 *         description: The suggestions
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/SearchSuggestions' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '422': { $ref: '#/components/responses/UnprocessableEntity' }
 *       '429':
 *         description: More than 30 searches in a minute
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { message: Too many searches. Wait a minute and try again., code: RATE_LIMITED }
 *       '500': { $ref: '#/components/responses/InternalError' }
 */
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
