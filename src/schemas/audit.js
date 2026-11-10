// Request schemas for /api/audit (admin only). All filters are optional; an empty one (?action=) means "no filter".
const { z } = require('zod')
const { id } = require('./common')
const { AUDIT_ACTIONS } = require('../audit')

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

function filter(schema) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional())
}

// Missing or empty (?page=) means the default
function withDefault(schema, fallback) {
  return z.preprocess((value) => (value === '' || value === undefined ? fallback : value), schema)
}

// A calendar date, YYYY-MM-DD, that really exists (no 2026-02-30). Turned into midnight at the start of that day in
// the server's time zone, the same clock the database uses for created_at.
const date = (label) =>
  z
    .string({ error: `${label} must be a date like 2026-11-10` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a date like 2026-11-10`)
    .transform((value, ctx) => {
      const [y, m, d] = value.split('-').map(Number)
      const start = new Date(y, m - 1, d)
      if (start.getFullYear() !== y || start.getMonth() !== m - 1 || start.getDate() !== d) {
        ctx.addIssue({ code: 'custom', message: `${label} is not a real date` })
        return z.NEVER
      }
      return start
    })

const positiveInt = (label, { max } = {}) => {
  let schema = z.coerce.number({ error: `${label} must be a number` }).int(`${label} must be a whole number`)
  schema = schema.min(1, `${label} must be at least 1`)
  if (max) schema = schema.max(max, `${label} must be at most ${max}`)
  return schema
}

const listAudit = {
  query: z
    .object({
      // Entries where this user did something OR something was done to them
      user: filter(id('User')),
      action: filter(z.enum(AUDIT_ACTIONS, { error: 'Unknown action; GET /api/audit/actions lists them' })),
      // Both inclusive: from the start of `from` to the end of `to`
      from: filter(date('From')),
      to: filter(date('To')),
      page: withDefault(positiveInt('Page'), 1),
      pageSize: withDefault(positiveInt('Page size', { max: MAX_PAGE_SIZE }), DEFAULT_PAGE_SIZE),
    })
    .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'From must be on or before To', path: ['from'] })
    // `to` is inclusive: the query runs up to (not including) midnight after it
    .transform((q) => ({ ...q, to: q.to && new Date(q.to.getFullYear(), q.to.getMonth(), q.to.getDate() + 1) })),
}

module.exports = { listAudit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE }
