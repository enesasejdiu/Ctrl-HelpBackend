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
const {
  MAX_FILE_BYTES,
  MAX_FILES_PER_UPLOAD,
  MAX_FILES_PER_TICKET,
  ALLOWED_EXTENSIONS,
  ATTACHMENT_SELECT,
  detectType,
  safeName,
  decodeUploadName,
  storedPath,
  storeFile,
  removeFile,
  canSeeTicket,
  canDeleteAttachment,
  publicAttachment,
  listAttachments,
} = require('../attachments')

const MB = MAX_FILE_BYTES / (1024 * 1024)

// Parses the multipart body into memory (req.files), so every file is checked before anything is written to disk.
// At most MAX_FILES_PER_UPLOAD files of MAX_FILE_BYTES each, all in the "files" field, and nothing else in the body.
const parseFiles = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_UPLOAD, fields: 0, parts: MAX_FILES_PER_UPLOAD },
}).array('files', MAX_FILES_PER_UPLOAD)

const tooManyFiles = () =>
  new HttpError(400, `Upload at most ${MAX_FILES_PER_UPLOAD} files at a time`, 'TOO_MANY_FILES', {
    max_files: MAX_FILES_PER_UPLOAD,
  })

// multer's errors as our API errors (otherwise they would be a plain 500)
function uploadError(err) {
  if (err instanceof multer.MulterError) {
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        return new HttpError(413, `Each file can be at most ${MB} MB`, 'FILE_TOO_LARGE', { max_bytes: MAX_FILE_BYTES })
      case 'LIMIT_FILE_COUNT':
      case 'LIMIT_PART_COUNT':
        return tooManyFiles()
      case 'LIMIT_UNEXPECTED_FILE':
        // array('files', max) also reports a file over the maximum this way
        return err.field === 'files'
          ? tooManyFiles()
          : new HttpError(400, 'Send the files in the "files" field', 'INVALID_UPLOAD')
      default:
        return new HttpError(400, 'Send only files, in the "files" field', 'INVALID_UPLOAD')
    }
  }
  // A broken multipart body (e.g. cut off halfway)
  return new HttpError(400, 'The upload could not be read. Try again.', 'INVALID_UPLOAD')
}

// Step 2 of an upload, after the ticket check: reads the files, turning multer's errors into ours
function receiveFiles(req, res, next) {
  parseFiles(req, res, (err) => next(err ? uploadError(err) : undefined))
}

// Step 3: checks every file, then saves them all, or none
async function uploadAttachments(req, res) {
  const files = req.files ?? []
  if (files.length === 0) {
    throw new HttpError(400, 'Choose at least one file to upload', 'NO_FILES')
  }

  // Every file must be allowed before any is saved, so a refused file never leaves the others half uploaded
  const checked = files.map((file) => {
    const name = safeName(decodeUploadName(file.originalname))
    if (file.size === 0) {
      throw new HttpError(400, `${name} is empty`, 'EMPTY_FILE', { file: name })
    }
    const mimeType = detectType(file.buffer, name)
    if (!mimeType) {
      throw new HttpError(400, `${name}: this file type isn't allowed`, 'UNSUPPORTED_FILE_TYPE', {
        file: name,
        allowed: ALLOWED_EXTENSIONS,
      })
    }
    return { name, mimeType, buffer: file.buffer, size: file.size }
  })

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
        `INSERT INTO attachments (ticket_id, uploaded_by, original_name, stored_name, mime_type, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [ticketId, req.user.id, file.name, storedName, file.mimeType, file.size],
      )
      ids.push(result.insertId)
      // The file's name, type and size; never its content
      await recordAudit('attachment_uploaded', {
        actorId: req.user.id,
        details: { ticket_id: ticketId, file_name: file.name, mime_type: file.mimeType, size_bytes: file.size },
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
  res.json(await listAttachments(pool, req.ticket.id))
}

const router = express.Router()
router.use(requireAuth)

// Loads the attachment with its ticket's requester, and checks the user may see that ticket (404 before 403)
async function loadAttachment(req, res, next) {
  const [rows] = await pool.query(`${ATTACHMENT_SELECT} WHERE a.id = ?`, [req.valid.params.id])
  const attachment = rows[0]
  if (!attachment) {
    throw new HttpError(404, 'Attachment not found')
  }
  const [[ticket]] = await pool.query('SELECT requester_id FROM tickets WHERE id = ?', [attachment.ticket_id])
  if (!canSeeTicket(req.user, ticket.requester_id)) {
    throw new HttpError(403, 'You can only see attachments on your own tickets')
  }
  req.attachment = attachment
  next()
}

// GET /api/attachments/:id/download → the file, always as a download (never shown inline), with its original name
router.get('/:id/download', validate(schemas.attachmentParams), loadAttachment, async (req, res) => {
  const attachment = req.attachment
  const file = storedPath(attachment.stored_name)
  let size
  try {
    ;({ size } = await fs.promises.stat(file))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    console.error(`Attachment ${attachment.id}: its file ${attachment.stored_name} is missing in UPLOAD_DIR`)
    throw new HttpError(404, 'The file is missing on the server', 'FILE_MISSING')
  }

  // attachment() writes Content-Disposition: attachment, with a safe ASCII filename plus filename* for any other
  // characters. It also guesses a Content-Type from the name, which the next line replaces with the checked type.
  res.attachment(attachment.original_name)
  res.set({
    'Content-Type': attachment.mime_type,
    'Content-Length': String(size),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  })
  await pipeline(fs.createReadStream(file), res)
})

// DELETE /api/attachments/:id → 204. The uploader or an admin; the file is removed from disk too.
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
    console.error(`Attachment ${attachment.id} deleted, but its file could not be removed: ${err.message}`)
  }
  res.status(204).end()
})

module.exports = { router, receiveFiles, uploadAttachments, listTicketAttachments }
