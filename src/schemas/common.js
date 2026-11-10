// Building blocks shared by the schemas in this folder.
const { z } = require('zod')

const STATUSES = ['open', 'assigned', 'in_progress', 'waiting_for_user', 'resolved', 'closed', 'reopened']
// HR manages employee accounts but otherwise works like an employee (see isStaff in middleware/auth.js)
const ROLES = ['employee', 'agent', 'hr', 'admin']

function tooLong(label, max) {
  return `${label} must be ${max.toLocaleString('en-US')} characters or less`
}

// A trimmed string that can't be empty. tooLongMessage replaces the default text.
function requiredText(label, max, tooLongMessage = tooLong(label, max)) {
  return z
    .string({ error: (issue) => (issue.input == null ? `${label} is required` : `${label} must be text`) })
    .trim()
    .min(1, `${label} is required`)
    .max(max, tooLongMessage)
}

// A trimmed string that can be left out or null
function optionalText(label, max) {
  return z
    .string({ error: `${label} must be text` })
    .trim()
    .max(max, tooLong(label, max))
    .nullable()
    .optional()
}

// A positive integer, as a number or a numeric string (URLs and dropdowns give strings); always parsed to a number.
// Pass `invalid` or `required` to keep a route's own wording.
function id(label, { invalid, required = `${label} is required` } = {}) {
  const notNumber = invalid || `${label} must be a number`
  const notPositive = invalid || `${label} must be a positive number`
  return z
    .union([z.number(), z.string().regex(/^\d+$/, notNumber)], {
      error: (issue) => (issue.input === undefined ? required : notNumber),
    })
    .transform(Number)
    .pipe(z.number({ error: notNumber }).int(notNumber).positive(notPositive))
}

const email = z
  .string({ error: (issue) => (issue.input == null ? 'Email is required' : 'Enter a valid email') })
  .trim()
  .toLowerCase() // stored lowercase, so "Ann@x.com" and "ann@x.com" are the same account
  .min(1, 'Email is required')
  .pipe(z.email('Enter a valid email').max(150, tooLong('Email', 150)))

const name = requiredText('Name', 100)

// Not trimmed, because spaces are allowed in a password
const passwordText = z.string({
  error: (issue) => (issue.input == null ? 'Password is required' : 'Password must be text'),
})
const existingPassword = passwordText.min(1, 'Password is required') // no length rule: login only compares it

// A password the user chooses: 10+ characters with at least one letter and one number. Not trimmed.
// At most 72 characters because bcrypt ignores everything after 72 bytes, so a longer one would only look stronger.
const newPassword = z
  .string({ error: (issue) => (issue.input == null ? 'New password is required' : 'New password must be text') })
  .min(10, 'New password must be at least 10 characters')
  .max(72, 'New password must be 72 characters or less')
  .regex(/[A-Za-z]/, 'New password must contain at least one letter')
  .regex(/\d/, 'New password must contain at least one number')

const status = z.enum(STATUSES, { error: `Status must be one of: ${STATUSES.join(', ')}` })
const role = z.enum(ROLES, { error: (issue) => (issue.input === undefined ? 'Role is required' : 'Invalid role') })

const ticketParams = z.object({ id: id('Ticket id') })

module.exports = {
  id,
  email,
  name,
  newPassword,
  existingPassword,
  status,
  role,
  requiredText,
  optionalText,
  tooLong,
  ticketParams,
}
