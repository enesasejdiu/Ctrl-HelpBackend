// Request schemas for GET /api/search/suggestions (routes/search.js). A failed check answers 422 in the usual
// { message, errors: [{ field, message }] } form.
const { z } = require('zod')

// Below SUGGEST_MIN characters (after trimming) the answer is simply empty; above SUGGEST_MAX it's a 422
const SUGGEST_MIN = 3
const SUGGEST_MAX = 200

const suggestions = {
  query: z.object({
    q: z.string().trim().max(SUGGEST_MAX, `Search for at most ${SUGGEST_MAX} characters`).optional(),
  }),
}

module.exports = { suggestions, SUGGEST_MIN, SUGGEST_MAX }
