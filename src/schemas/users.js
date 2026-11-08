// Request schemas for /api/users.
const { z } = require('zod');
const { id, role, name, email, optionalText } = require('./common');

// Strict, so a password or must_change_password in the body is refused: the server always makes the password.
// role is optional here because HR may leave it out (it then means employee); the route requires it from admins.
// department_id must also exist in departments, which the route checks.
const createUser = {
  body: z.strictObject({
    name,
    email,
    role: role.optional(),
    department: optionalText('Department', 100),
    department_id: id('Department id').nullable().optional(),
    job_title: optionalText('Job title', 255),
  }),
};

const resetPassword = {
  params: z.object({ id: id('User id') }),
};

// Every field is optional, but at least one must be sent. Unknown fields (e.g. password) are refused.
const updateUser = {
  params: z.object({ id: id('User id') }),
  body: z
    .strictObject({
      name: name.optional(),
      email: email.optional(),
      department: optionalText('Department', 100),
      role: role.optional(),
      is_active: z.boolean({ error: 'is_active must be true or false' }).optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), {
      error: 'Send at least one of name, email, department, role or is_active to change',
    }),
};

module.exports = { createUser, resetPassword, updateUser };
