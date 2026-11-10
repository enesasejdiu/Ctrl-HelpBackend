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

// new_password only has to be text here (400 otherwise). The password rule (common.newPassword) is checked by the
// route after the token, and answers 422, so a link sent with a weak password stays unused.
const setPassword = {
  body: z.strictObject({
    token,
    new_password: z.string({
      error: (issue) => (issue.input == null ? 'New password is required' : 'New password must be text'),
    }),
  }),
}

// POST /api/auth/forgot-password { email }
const forgotPassword = {
  body: z.strictObject({ email }),
}

module.exports = { login, changePassword, validateSetPasswordToken, setPassword, forgotPassword }
