// Request schema for /api/users.
const { z } = require('zod');
const { id, role } = require('./common');

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

module.exports = { updateUser };
