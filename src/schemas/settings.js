// Request schemas for the admin settings: /api/categories, /api/priorities and /api/settings (routes/settings.js).
// Bodies are strict, so an unknown field is refused (400, like every other endpoint). Whether a name is already taken
// needs the database, so the routes check that (409 NAME_TAKEN).
const { z } = require('zod')
const { id, requiredText, optionalText } = require('./common')

const MAX_TARGET_HOURS = 8760 // one year
const MAX_SORT_ORDER = 100000
const MAX_RANK = 1000

const settingName = requiredText('Name', 50)

// A whole number from a JSON body (not a string), between min and max
function wholeNumber(label, min, max) {
  const message = `${label} must be a whole number from ${min} to ${max.toLocaleString('en-US')}`
  return z
    .number({ error: (issue) => (issue.input === undefined ? `${label} is required` : message) })
    .int(message)
    .min(min, message)
    .max(max, message)
}

const bool = (label) => z.boolean({ error: `${label} must be true or false` })

const idParams = (label) => ({ params: z.object({ id: id(label) }) })

// "Send at least one field": an empty PATCH changes nothing and is probably a mistake
const atLeastOne = (body) => Object.values(body).some((value) => value !== undefined)

const listQuery = {
  query: z.object({
    include_inactive: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.literal('1', { error: 'include_inactive must be 1 or left out' }).optional(),
    ),
  }),
}

const createCategory = {
  body: z.strictObject({
    name: settingName,
    description: optionalText('Description', 255),
    sort_order: wholeNumber('sort_order', 0, MAX_SORT_ORDER).optional(),
  }),
}

const updateCategory = {
  ...idParams('Category id'),
  body: z
    .strictObject({
      name: settingName.optional(),
      description: optionalText('Description', 255),
      sort_order: wholeNumber('sort_order', 0, MAX_SORT_ORDER).optional(),
      is_active: bool('is_active').optional(),
    })
    .refine(atLeastOne, { error: 'Send at least one of name, description, sort_order or is_active to change' }),
}

const createPriority = {
  body: z.strictObject({
    name: settingName,
    rank: wholeNumber('rank', 1, MAX_RANK),
    target_hours: wholeNumber('target_hours', 1, MAX_TARGET_HOURS),
    is_default: bool('is_default').optional(),
  }),
}

const updatePriority = {
  ...idParams('Priority id'),
  body: z
    .strictObject({
      name: settingName.optional(),
      rank: wholeNumber('rank', 1, MAX_RANK).optional(),
      target_hours: wholeNumber('target_hours', 1, MAX_TARGET_HOURS).optional(),
      is_default: bool('is_default').optional(),
      is_active: bool('is_active').optional(),
    })
    .refine(atLeastOne, {
      error: 'Send at least one of name, rank, target_hours, is_default or is_active to change',
    }),
}

const reorderPriorities = {
  body: z.strictObject({
    ids: z.array(id('Priority id'), { error: 'ids must be a list of priority ids' }),
  }),
}

// PATCH /api/settings: either or both; at least one
const updateSettings = {
  body: z
    .strictObject({
      company_name: requiredText('Company name', 100).optional(),
      auto_close_days: z
        .number({ error: 'auto_close_days must be a whole number from 0 to 365' })
        .int('auto_close_days must be a whole number from 0 to 365')
        .min(0, 'auto_close_days must be a whole number from 0 to 365')
        .max(365, 'auto_close_days must be a whole number from 0 to 365')
        .optional(),
    })
    .refine((body) => body.company_name !== undefined || body.auto_close_days !== undefined, {
      error: 'Send company_name or auto_close_days',
    }),
}

module.exports = {
  MAX_TARGET_HOURS,
  listQuery,
  createCategory,
  updateCategory,
  categoryParams: idParams('Category id'),
  createPriority,
  updatePriority,
  priorityParams: idParams('Priority id'),
  reorderPriorities,
  updateSettings,
}
