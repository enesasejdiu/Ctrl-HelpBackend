// Request schema for POST /api/tickets/:id/comments.
const { z } = require('zod');
const { ticketParams, tooLong } = require('./common');

const addComment = {
  params: ticketParams,
  body: z.strictObject({
    content: z
      .string({ error: 'Comment cannot be empty' })
      .trim()
      .min(1, 'Comment cannot be empty')
      .max(10000, tooLong('Comment', 10000)),
    is_internal: z.boolean({ error: 'is_internal must be true or false' }).optional(),
  }),
};

module.exports = { addComment };
