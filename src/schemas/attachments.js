// Request schemas for /api/attachments. The upload (POST /api/tickets/:id/attachments) is multipart, so its files are
// checked by routes/attachments.js, not by a schema; its :id uses the tickets' getTicket schema.
const { z } = require('zod')
const { id } = require('./common')

const attachmentParams = { params: z.object({ id: id('Attachment id') }) }

// GET /api/attachments/:id/download[?inline=1]: inline=1 asks for a preview (images and PDFs only; anything else, and
// any other value, is a normal download)
const attachmentDownload = {
  ...attachmentParams,
  query: z.object({ inline: z.string().optional() }),
}

// The upload's one optional text field (checked by routes/attachments.js with safeParse): the comment, on the same
// ticket, that the files belong to. Any other text field is refused.
const uploadFields = z.object({ comment_id: id('Comment id').optional() }).strict()

module.exports = { attachmentParams, attachmentDownload, uploadFields }
