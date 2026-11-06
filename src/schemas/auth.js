// Request schemas for /api/auth.
const { z } = require('zod');
const { email, name, newPassword, existingPassword, optionalText } = require('./common');

// Strict, so a "role" sent while registering is refused rather than ignored
const register = {
  body: z.strictObject({ name, email, password: newPassword, department: optionalText('Department', 100) }),
};

const login = {
  body: z.strictObject({ email, password: existingPassword }),
};

module.exports = { register, login };
