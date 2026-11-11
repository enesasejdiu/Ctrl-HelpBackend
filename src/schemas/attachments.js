// Request schemas for /api/attachments. The upload (POST /api/tickets/:id/attachments) is multipart, so its files are
// checked by routes/attachments.js, not by a schema; its :id uses the tickets' getTicket schema.
const { z } = require('zod')
const { id } = require('./common')

const attachmentParams = { params: z.object({ id: id('Attachment id') }) }

module.exports = { attachmentParams }
