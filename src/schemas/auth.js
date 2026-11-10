// Request schemas for /api/auth.
const { z } = require('zod')
const { email, existingPassword, newPassword } = require('./common')

const login = {
  body: z.strictObject({ email, password: existingPassword }),
}

const changePassword = {
  body: z.strictObject({
    currentPassword: z
      .string({
        error: (issue) => (issue.input == null ? 'Current password is required' : 'Current password must be text'),
      })
      .min(1, 'Current password is required'),
    newPassword,
  }),
}

// The token from a set-password link (base64url, 43 characters today; the limit leaves room without accepting junk)
const token = z
  .string({ error: (issue) => (issue.input == null ? 'Token is required' : 'Token must be text') })
  .trim()
  .min(1, 'Token is required')
  .max(200, 'Token is not valid')

const validateSetPasswordToken = {
  query: z.object({ token }),
}

// Same password rule as everywhere else (common.newPassword: 10–72 characters, a letter and a number)
const setPassword = {
  body: z.strictObject({ token, new_password: newPassword }),
}

module.exports = { login, changePassword, validateSetPasswordToken, setPassword }
