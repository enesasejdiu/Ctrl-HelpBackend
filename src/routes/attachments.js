// Attachment routes. Mounted at /api/attachments: GET /:id/download and DELETE /:id. The upload and the list belong to
// a ticket, so routes/tickets.js mounts them at /api/tickets/:id/attachments with the handlers exported here.
// Everyone needs a session; cookie-authenticated uploads and deletes need the CSRF header like any other change
// (middleware/auth.js). Rules and storage are in src/attachments.js.
const express = require('express')
const fs = require('fs')
const { pipeline } = require('stream/promises')
const multer = require('multer')
const pool = require('../db')
const { HttpError } = require('../middleware/errors')
const { requireAuth } = require('../middleware/auth')
const validate = require('../middleware/validate')
const schemas = require('../schemas/attachments')
const { recordAudit } = require('../audit')
const { isStaff } = require('../middleware/auth')
const {
  maxFileBytes,
  formatBytes,
  MAX_FILES_PER_UPLOAD,
  MAX_FILES_PER_TICKET,
  ALLOWED_EXTENSIONS,
  ATTACHMENT_SELECT,
  detectType,
  safeName,
  decodeUploadName,
  storedPath,
  sha256,
  storeFile,
  removeFile,
  canSeeAttachment,
  canDeleteAttachment,
  publicAttachment,
  listAttachments,
} = require('../attachments')

// Parses the multipart body into memory (req.files), so every file is checked before anything is written to disk.
// At most MAX_FILES_PER_UPLOAD files of maxFileBytes() each, all in the "files" field, plus at most one text field
// (comment_id; any other is refused in uploadAttachments). Built per request, because the size limit is read on every
// call (see maxFileBytes in src/attachments.js).
function fileParser(maxBytes) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: MAX_FILES_PER_UPLOAD, fields: 1, parts: MAX_FILES_PER_UPLOAD + 1 },
  }).array('files', MAX_FILES_PER_UPLOAD)
}

// Images and PDFs can be previewed (?inline=1); text never is, so a .txt can't be shown as a page
const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'])

// A downloaded file can't run anything, even if a browser opens it as a page: no scripts, no requests, sandboxed
const DOWNLOAD_CSP = "default-src 'none'; sandbox"

// The comment the files are added with, or null. It must be a comment on this ticket that the user can see (internal
// notes are staff-only); anything else gets the same 422, so it says nothing about comments on other tickets.
async function commentFor(req) {
  const fields = schemas.uploadFields.safeParse(req.body ?? {})
  if (!fields.success) {
    const unknown = fields.error.issues.some((issue) => issue.code === 'unrecognized_keys')
    throw unknown
      ? new HttpError(400, 'Send only files, in the "files" field, and optionally comment_id', 'INVALID_UPLOAD')
      : new HttpError(400, fields.error.issues[0].message, 'INVALID_UPLOAD')
  }
  const commentId = fields.data.comment_id
  if (commentId === undefined) return null
  const [[comment]] = await pool.query('SELECT id, is_internal FROM comments WHERE id = ? AND ticket_id = ?', [
    commentId,
    req.ticket.id,
  ])
  if (!comment || (comment.is_internal && !isStaff(req.user))) {
    throw new HttpError(422, 'That comment is not on this ticket', 'COMMENT_NOT_ON_TICKET')
  }
  return comment.id
}

const tooManyFiles = () =>
  new HttpError(400, `Upload at most ${MAX_FILES_PER_UPLOAD} files at a time`, 'TOO_MANY_FILES', {
    max_files: MAX_FILES_PER_UPLOAD,
  })

// multer's errors as our API errors (otherwise they would be a plain 500)
function uploadError(err, maxBytes) {
  if (err instanceof multer.MulterError) {
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        return new HttpError(413, `Each file can be at most ${formatBytes(maxBytes)}`, 'FILE_TOO_LARGE', {
          max_bytes: maxBytes,
        })
      case 'LIMIT_FILE_COUNT':
      case 'LIMIT_PART_COUNT':
        return tooManyFiles()
      case 'LIMIT_UNEXPECTED_FILE':
        // array('files', max) also reports a file over the maximum this way
        return err.field === 'files'
          ? tooManyFiles()
          : new HttpError(400, 'Send the files in the "files" field', 'INVALID_UPLOAD')
      default:
        return new HttpError(400, 'Send only files, in the "files" field, and optionally comment_id', 'INVALID_UPLOAD')
    }
  }
  // A broken multipart body (e.g. cut off halfway)
  return new HttpError(400, 'The upload could not be read. Try again.', 'INVALID_UPLOAD')
}

// Step 2 of an upload, after the ticket check: reads the files, turning multer's errors into ours
function receiveFiles(req, res, next) {
  const maxBytes = maxFileBytes()
  fileParser(maxBytes)(req, res, (err) => next(err ? uploadError(err, maxBytes) : undefined))
}

// Step 3: checks every file, then saves them all, or none
async function uploadAttachments(req, res) {
  const files = req.files ?? []
  if (files.length === 0) {
    throw new HttpError(400, 'Choose at least one file to upload', 'NO_FILES')
  }

  // Every file must be allowed before any is saved, so a refused file never leaves the others half uploaded.
  // Empty: 422 (a well-formed request that can't be accepted). Not an allowed type: 415 (Unsupported Media Type).
  const checked = files.map((file) => {
    const name = safeName(decodeUploadName(file.originalname))
    if (file.size === 0) {
      throw new HttpError(422, `${name} is empty`, 'EMPTY_FILE', { file: name })
    }
    const mimeType = detectType(file.buffer, name)
    if (!mimeType) {
      throw new HttpError(415, `${name}: this file type isn't allowed`, 'UNSUPPORTED_FILE_TYPE', {
        file: name,
        allowed: ALLOWED_EXTENSIONS,
      })
    }
    return { name, mimeType, buffer: file.buffer, size: file.size, sha256: sha256(file.buffer) }
  })
  const commentId = await commentFor(req)

  const ticketId = req.ticket.id
  const stored = []
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // Locks the ticket row, so two uploads at the same time can't both squeeze in under the limit
    await conn.query('SELECT id FROM tickets WHERE id = ? FOR UPDATE', [ticketId])
    const [[{ count }]] = await conn.query('SELECT COUNT(*) AS count FROM attachments WHERE ticket_id = ?', [ticketId])
    if (Number(count) + checked.length > MAX_FILES_PER_TICKET) {
      const left = Math.max(0, MAX_FILES_PER_TICKET - Number(count))
      throw new HttpError(
        400,
        `A ticket can have at most ${MAX_FILES_PER_TICKET} attachments. This one has ${count}, so you can add ${left} more.`,
        'TOO_MANY_ATTACHMENTS',
        { max_per_ticket: MAX_FILES_PER_TICKET, current: Number(count) },
      )
    }

    const ids = []
    for (const file of checked) {
      const storedName = await storeFile(file.buffer)
      stored.push(storedName)
      const [result] = await conn.query(
        `INSERT INTO attachments
           (ticket_id, comment_id, uploaded_by, original_name, stored_name, mime_type, size_bytes, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ticketId, commentId, req.user.id, file.name, storedName, file.mimeType, file.size, file.sha256],
      )
      ids.push(result.insertId)
      // The file's name, type and size; never its content
      await recordAudit('attachment_uploaded', {
        actorId: req.user.id,
        details: {
          ticket_id: ticketId,
          ...(commentId ? { comment_id: commentId } : {}),
          file_name: file.name,
          mime_type: file.mimeType,
          size_bytes: file.size,
        },
        req,
        db: conn,
      })
    }
    await conn.commit()

    const [rows] = await pool.query(`${ATTACHMENT_SELECT} WHERE a.id IN (?) ORDER BY a.id`, [ids])
    res.status(201).json(rows.map(publicAttachment))
  } catch (err) {
    await conn.rollback()
    // Nothing was saved in the database, so the files written so far would be orphans
    await Promise.all(stored.map((name) => removeFile(name).catch(() => {})))
    throw err
  } finally {
    conn.release()
  }
}

// GET /api/tickets/:id/attachments (after the ticket check) → the ticket's attachments, oldest first
async function listTicketAttachments(req, res) {
  res.json(await listAttachments(pool, req.ticket.id, req.user))
}

const router = express.Router()
router.use(requireAuth)

// Loads the attachment and checks the user may see it (its ticket, and not a staff-only one). One answer, 404, for
// "doesn't exist" and "not yours to see", so nobody can find out which attachment ids exist.
async function loadAttachment(req, res, next) {
  const [rows] = await pool.query(`${ATTACHMENT_SELECT} WHERE a.id = ?`, [req.valid.params.id])
  const attachment = rows[0]
  const [[ticket]] = attachment
    ? await pool.query('SELECT requester_id FROM tickets WHERE id = ?', [attachment.ticket_id])
    : [[null]]
  if (!attachment || !canSeeAttachment(req.user, attachment, ticket.requester_id)) {
    throw new HttpError(404, 'Attachment not found')
  }
  req.attachment = attachment
  next()
}

// GET /api/attachments/:id/download → the file with its original name, as a download. With ?inline=1 an image or PDF
// is sent for showing in the browser instead (a preview); text files are always downloads.
/**
 * @openapi
 * /api/attachments/{id}/download:
 *   get:
 *     tags: [Attachments]
 *     summary: Download an attachment
 *     description: |
 *       **Roles:** anyone who can see the ticket (staff: any; `employee`/`hr`: their own), except files added with
 *       an internal note, which only staff can get. Sent with its original file name as a download; with `inline=1`
 *       an image or PDF is sent for preview instead (text files are always downloads). An attachment you can't see
 *       answers 404, like a missing one.
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: integer, minimum: 1, example: 15 }
 *       - name: inline
 *         in: query
 *         description: '`1` = preview in the browser (images and PDFs only); anything else is a download'
 *         schema: { type: string, enum: ['1'] }
 *     responses:
 *       '200':
 *         description: The file
 *         headers:
 *           Content-Disposition:
 *             schema: { type: string }
 *             example: attachment; filename="wifi-error.png"
 *         content:
 *           image/png: { schema: { type: string, format: binary } }
 *           image/jpeg: { schema: { type: string, format: binary } }
 *           image/gif: { schema: { type: string, format: binary } }
 *           image/webp: { schema: { type: string, format: binary } }
 *           application/pdf: { schema: { type: string, format: binary } }
 *           text/plain: { schema: { type: string, format: binary } }
 *           text/csv: { schema: { type: string, format: binary } }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '404':
 *         description: No such attachment, not yours to see, or its file is missing on the server (`FILE_MISSING`)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { message: Attachment not found }
 *       '500': { $ref: '#/components/responses/InternalError' }
 */
router.get('/:id/download', validate(schemas.attachmentDownload), loadAttachment, async (req, res) => {
  const attachment = req.attachment
  const file = storedPath(attachment.stored_name)
  let size
  try {
    ;({ size } = await fs.promises.stat(file))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    req.log.error(`Attachment ${attachment.id}: its file ${attachment.stored_name} is missing in UPLOAD_DIR`)
    throw new HttpError(404, 'The file is missing on the server', 'FILE_MISSING')
  }

  // attachment() writes Content-Disposition: attachment, with a safe ASCII filename plus filename* for any other
  // characters. It also guesses a Content-Type from the name, which the next line replaces with the checked type.
  res.attachment(attachment.original_name)
  // A preview: the same header with "inline" (same filename and filename*)
  if (req.valid.query.inline === '1' && PREVIEWABLE.has(attachment.mime_type)) {
    res.set('Content-Disposition', res.get('Content-Disposition').replace(/^attachment/, 'inline'))
  }
  res.set({
    'Content-Type': attachment.mime_type,
    'Content-Length': String(size),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': DOWNLOAD_CSP,
    'Cache-Control': 'private, no-store',
  })
  await pipeline(fs.createReadStream(file), res)
})

// DELETE /api/attachments/:id → 204. The uploader or an admin; the file is removed from disk too.
/**
 * @openapi
 * /api/attachments/{id}:
 *   delete:
 *     tags: [Attachments]
 *     summary: Delete an attachment
 *     description: '**Roles:** the person who uploaded it, or an `admin`. The file is removed from disk too.'
 *     security: [{ cookieAuth: [], csrfToken: [] }]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: integer, minimum: 1, example: 15 }
 *     responses:
 *       '204': { description: Deleted }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403':
 *         description: Not the uploader or an admin
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { message: 'Only the person who uploaded a file, or an admin, can delete it' }
 *       '404':
 *         description: No such attachment, or not yours to see
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { message: Attachment not found }
 *       '500': { $ref: '#/components/responses/InternalError' }
 */
router.delete('/:id', validate(schemas.attachmentParams), loadAttachment, async (req, res) => {
  const attachment = req.attachment
  if (!canDeleteAttachment(req.user, attachment)) {
    throw new HttpError(403, 'Only the person who uploaded a file, or an admin, can delete it')
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query('DELETE FROM attachments WHERE id = ?', [attachment.id])
    await recordAudit('attachment_deleted', {
      actorId: req.user.id,
      details: {
        ticket_id: attachment.ticket_id,
        file_name: attachment.original_name,
        size_bytes: attachment.size_bytes,
      },
      req,
      db: conn,
    })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }

  // After the commit: if this fails, the file is an orphan on disk, but the attachment is gone for everyone
  try {
    await removeFile(attachment.stored_name)
  } catch (err) {
    req.log.error({ err }, `Attachment ${attachment.id} deleted, but its file could not be removed: ${err.message}`)
  }
  res.status(204).end()
})

module.exports = { router, receiveFiles, uploadAttachments, listTicketAttachments }
