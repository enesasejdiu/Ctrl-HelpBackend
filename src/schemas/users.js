// Request schemas for /api/users.
const { z } = require('zod');
const { id, role, name, email, optionalText } = require('./common');

// Strict, so a password or must_change_password in the body is refused: the server always makes the password
const createUser = {
  body: z.strictObject({ name, email, role, department: optionalText('Department', 100) }),
};

const resetPassword = {
  params: z.object({ id: id('User id') }),
};

const updateUser = {
  params: z.object({ id: id('User id') }),
  body: z
    .strictObject({
      role: role.optional(),
      is_active: z.boolean({ error: 'is_active must be true or false' }).optional(),
    })
    .refine((body) => body.role !== undefined || body.is_active !== undefined, {
      error: 'Send a role and/or is_active to change',
    }),
};

module.exports = { createUser, resetPassword, updateUser };
