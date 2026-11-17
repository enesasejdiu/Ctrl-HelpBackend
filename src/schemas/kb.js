// Request schemas for the knowledge base (routes/kb.js). Every body is strict: an unknown field is refused by name.
// The KB routes answer a failed check with 422 (validate(..., { status: 422 })), in the usual
// { message, errors: [{ field, message }] } form.
const { z } = require('zod')
const { id, tooLong } = require('./common')
const { pagingSchema, KB_ARTICLE_SORTS } = require('../pagination')
const { ARTICLE_SLUG_MAX, RESERVED_ARTICLE_SLUGS } = require('../kb')

const TITLE_MIN = 5
const TITLE_MAX = 200
const SUMMARY_MAX = 300
const BODY_MAX = 100_000
const CATEGORY_NAME_MAX = 60
const SORT_ORDER_LIMIT = 100_000
const Q_MIN = 2
const Q_MAX = 200
const STATUSES = ['draft', 'published']

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const title = z
  .string({ error: (issue) => (issue.input == null ? 'Title is required' : 'Title must be text') })
  .trim()
  .min(TITLE_MIN, `Title must be at least ${TITLE_MIN} characters`)
  .max(TITLE_MAX, tooLong('Title', TITLE_MAX))

// Optional; an empty or blank summary is stored as none (NULL)
const summary = z
  .string({ error: 'Summary must be text' })
  .trim()
  .max(SUMMARY_MAX, tooLong('Summary', SUMMARY_MAX))
  .nullable()
  .optional()
  .transform((value) => (value ? value : value === undefined ? undefined : null))

// Markdown exactly as written (not trimmed: leading spaces can matter), but not only whitespace
const body = z
  .string({ error: (issue) => (issue.input == null ? 'Body is required' : 'Body must be text') })
  .max(BODY_MAX, tooLong('Body', BODY_MAX))
  .refine((value) => value.trim().length > 0, 'Body is required')

const status = z.enum(STATUSES, { error: `Status must be one of: ${STATUSES.join(', ')}` })

const slug = z
  .string({ error: 'Slug must be text' })
  .trim()
  .min(1, 'Slug is required')
  .max(ARTICLE_SLUG_MAX, tooLong('Slug', ARTICLE_SLUG_MAX))
  .regex(SLUG, 'Slug may only use a-z, 0-9 and single dashes, and not start or end with a dash')
  .refine((value) => !RESERVED_ARTICLE_SLUGS.includes(value), {
    message: `Slug can't be ${RESERVED_ARTICLE_SLUGS.join(', ')}: those are pages of the knowledge base`,
  })

// When the client loaded the article it is editing (ISO 8601, as the API sent it): a save must send it back, and a
// different value in the database means someone else saved in between
const updatedAt = z.iso
  .datetime({
    offset: true,
    error: (issue) => (issue.input == null ? 'updated_at is required' : 'updated_at must be a date and time'),
  })
  .transform((value) => new Date(value))

const categoryName = z
  .string({ error: (issue) => (issue.input == null ? 'Name is required' : 'Name must be text') })
  .trim()
  .min(1, 'Name is required')
  .max(CATEGORY_NAME_MAX, tooLong('Name', CATEGORY_NAME_MAX))

const sortOrder = z
  .number({ error: 'sort_order must be a whole number' })
  .int('sort_order must be a whole number')
  .min(-SORT_ORDER_LIMIT, `sort_order must be at least -${SORT_ORDER_LIMIT.toLocaleString('en-US')}`)
  .max(SORT_ORDER_LIMIT, `sort_order must be at most ${SORT_ORDER_LIMIT.toLocaleString('en-US')}`)

// An empty query value (?q=) counts as not sent, like the other lists' filters
const optional = (schema) => z.preprocess((value) => (value === '' ? undefined : value), schema.optional())

const categoryParams = { params: z.object({ id: id('Category id') }) }

const createCategory = { body: z.strictObject({ name: categoryName, sort_order: sortOrder.optional() }) }

const updateCategory = {
  ...categoryParams,
  body: z
    .strictObject({ name: categoryName.optional(), sort_order: sortOrder.optional() })
    .refine((value) => Object.values(value).some((field) => field !== undefined), 'Send name or sort_order to change'),
}

// GET /api/kb/articles. status is checked by the route, and only for staff: for everyone else it's ignored (always
// published), whatever was sent.
const listArticles = {
  query: z.object({
    category: optional(
      z.string().trim().max(80, 'category is too long').regex(SLUG, 'category must be a category slug'),
    ),
    q: optional(
      z
        .string()
        .trim()
        .min(Q_MIN, `Search for at least ${Q_MIN} characters`)
        .max(Q_MAX, `Search for at most ${Q_MAX} characters`),
    ),
    status: optional(z.string()),
    ...pagingSchema(KB_ARTICLE_SORTS),
  }),
}

const articleSlugParams = { params: z.object({ slug: z.string().max(ARTICLE_SLUG_MAX) }) }
const articleParams = { params: z.object({ id: id('Article id') }) }

const createArticle = {
  body: z.strictObject({ title, summary, body, category_id: id('Category'), status: status.optional() }),
}

const updateArticle = {
  ...articleParams,
  body: z
    .strictObject({
      updated_at: updatedAt,
      title: title.optional(),
      slug: slug.optional(),
      summary,
      body: body.optional(),
      category_id: id('Category').optional(),
      status: status.optional(),
    })
    .refine(
      (value) => Object.entries(value).some(([key, field]) => key !== 'updated_at' && field !== undefined),
      'Send at least one field to change, with updated_at',
    ),
}

module.exports = {
  STATUSES,
  TITLE_MIN,
  TITLE_MAX,
  SUMMARY_MAX,
  BODY_MAX,
  CATEGORY_NAME_MAX,
  Q_MIN,
  Q_MAX,
  categoryParams,
  createCategory,
  updateCategory,
  listArticles,
  articleSlugParams,
  articleParams,
  createArticle,
  updateArticle,
}
