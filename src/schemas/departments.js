// Request schemas for /api/departments.
const { z } = require('zod')
const { id } = require('./common')

// Trimmed, with runs of spaces inside collapsed to one ("  Human   Resources " → "Human Resources"), then 1–100
// characters. Uniqueness is checked by the route; the table's collation (utf8mb4_unicode_ci) makes it case-insensitive.
const departmentName = z
  .string({ error: (issue) => (issue.input == null ? 'Name is required' : 'Name must be text') })
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'))

const departmentParams = {
  params: z.object({ id: id('Department id') }),
}

// Strict, so unknown fields are refused by name. Rename takes the same body: name is the only thing to change.
const departmentBody = {
  body: z.strictObject({ name: departmentName }),
}

module.exports = { departmentParams, departmentBody }
