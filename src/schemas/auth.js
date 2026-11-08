// Request schemas for /api/auth.
const { z } = require('zod');
const { email, existingPassword, newPassword } = require('./common');

const login = {
  body: z.strictObject({ email, password: existingPassword }),
};

const changePassword = {
  body: z.strictObject({
    currentPassword: z
      .string({ error: (issue) => (issue.input == null ? 'Current password is required' : 'Current password must be text') })
      .min(1, 'Current password is required'),
    newPassword,
  }),
};

module.exports = { login, changePassword };
