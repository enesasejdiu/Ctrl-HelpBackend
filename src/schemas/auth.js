// Request schemas for /api/auth.
const { z } = require('zod');
const { email, existingPassword } = require('./common');

const login = {
  body: z.strictObject({ email, password: existingPassword }),
};

module.exports = { login };
