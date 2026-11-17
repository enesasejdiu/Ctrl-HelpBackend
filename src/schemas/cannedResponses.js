// Request schemas for /api/canned-responses (routes/cannedResponses.js). Every body is strict: an unknown field is
// refused by name. A failed check answers 422 in the usual { message, errors: [{ field, message }] } form.
const { z } = require('zod')
const { id, tooLong } = require('./common')

const TITLE_MAX = 100
const BODY_MAX = 5000
const Q_MAX = 100
const SCOPES = ['all', 'shared', 'mine']

const title = z
  .string({ error: 'Title is required' })
  .trim()
  .min(1, 'Title is required')
  .max(TITLE_MAX, tooLong('Title', TITLE_MAX))
// Plain text, kept as written (line breaks and all); it must have something besides spaces
const body = z
  .string({ error: 'The text is required' })
  .max(BODY_MAX, tooLong('The text', BODY_MAX))
  .refine((value) => value.trim().length > 0, 'The text is required')

const params = { params: z.object({ id: id('Canned response id') }) }

// GET /api/canned-responses?q=&scope=
const list = {
  query: z.object({
    q: z.string().trim().max(Q_MAX, `Search for at most ${Q_MAX} characters`).optional(),
    scope: z.enum(SCOPES, { error: `scope must be one of: ${SCOPES.join(', ')}` }).optional(),
  }),
}

// POST /api/canned-responses { title, body, shared? }
const create = {
  body: z.strictObject({
    title,
    body,
    shared: z.boolean({ error: 'shared must be true or false' }).optional(),
  }),
}

// PATCH /api/canned-responses/:id { title?, body? } — whether it is shared can't change
const update = {
  ...params,
  body: z
    .strictObject({ title: title.optional(), body: body.optional() })
    .refine((value) => value.title !== undefined || value.body !== undefined, {
      message: 'Send title or body to change',
    }),
}

module.exports = { list, create, update, params, TITLE_MAX, BODY_MAX, Q_MAX, SCOPES }
