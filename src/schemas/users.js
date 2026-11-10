// Request schemas for /api/users.
const { z } = require('zod')
const { id, role, name, email, optionalText } = require('./common')

// Strict, so a password or must_change_password in the body is refused: the server always makes the password.
// role is optional here because HR may leave it out (it then means employee); the route requires it from admins.
// department_id must also exist in departments, which the route checks. (The old free-text department field is
// gone: sending it is refused like any other unknown field.)
const createUser = {
  body: z.strictObject({
    name,
    email,
    role: role.optional(),
    department_id: id('Department id').nullable().optional(),
    job_title: optionalText('Job title', 255),
  }),
}

const resetPassword = {
  params: z.object({ id: id('User id') }),
}

// The reset takes no body: the server always makes the password, so any field (e.g. a chosen password) is refused
const resetPasswordBody = {
  body: z.strictObject({}),
}

// POST /api/users/:id/resend-invite: no body
const resendInvite = {
  params: z.object({ id: id('User id') }),
  body: z.strictObject({}),
}

// PATCH /api/users/:id is checked in two steps: the id first, then (once the user is known to exist and the caller
// may change them) the body. Every body field is optional, but at least one must be sent. Unknown fields (password,
// must_change_password, created_at, ...) are refused by name. null clears department_id and job_title.
const updateUserParams = {
  params: z.object({ id: id('User id') }),
}

const updateUser = {
  body: z
    .strictObject({
      name: name.optional(),
      email: email.optional(),
      department_id: id('Department id').nullable().optional(),
      job_title: optionalText('Job title', 255),
      role: role.optional(),
      is_active: z.boolean({ error: 'is_active must be true or false' }).optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), {
      error: 'Send at least one of name, email, department_id, job_title, role or is_active to change',
    }),
}

module.exports = { createUser, resetPassword, resetPasswordBody, resendInvite, updateUserParams, updateUser }
