// Ticket attachments (the attachments table, migration 012): what may be uploaded, where it's kept, and who may see it.
// Used by routes/attachments.js.
//
// Files are kept in UPLOAD_DIR (default ./uploads next to package.json), under a random id with no extension. The name
// the user gave a file is only stored in the database and sent back as the download name, never used as a path. The
// API serves nothing statically, and downloads always go through GET /api/attachments/:id/download, which checks who
// is asking and never shows a file inline.
//
// The type is decided by the file's CONTENT, not its name or what the browser says: images and PDFs by their first
// bytes ("magic bytes"); .txt, .log and .csv, which have no signature, by being valid UTF-8 text without NUL bytes.
// The file's extension must also match what the content is, so a "photo.png" that is really text is refused.
const crypto = require('crypto')
const fsSync = require('fs')
const fs = require('fs/promises')
const path = require('path')
const { isStaff } = require('./middleware/auth')

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB per file
const MAX_FILES_PER_UPLOAD = 5
const MAX_FILES_PER_TICKET = 20
const DEFAULT_UPLOAD_DIR = 'uploads'

// What can be uploaded: for each kind, the file name extensions it may have and the type it's stored and served as
const KINDS = {
  png: { extensions: ['png'], mime: 'image/png' },
  jpeg: { extensions: ['jpg', 'jpeg'], mime: 'image/jpeg' },
  gif: { extensions: ['gif'], mime: 'image/gif' },
  webp: { extensions: ['webp'], mime: 'image/webp' },
  pdf: { extensions: ['pdf'], mime: 'application/pdf' },
  text: { extensions: ['txt', 'log'], mime: 'text/plain' },
  csv: { extensions: ['csv'], mime: 'text/csv' },
}
const ALLOWED_EXTENSIONS = Object.values(KINDS).flatMap((kind) => kind.extensions)

const startsWith = (buffer, bytes, offset = 0) =>
  buffer.length >= offset + bytes.length && bytes.every((byte, i) => buffer[offset + i] === byte)
const ascii = (text) => [...text].map((char) => char.charCodeAt(0))

// The binary kind a file's first bytes say it is, or null
function binaryKind(buffer) {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(buffer, ascii('GIF87a')) || startsWith(buffer, ascii('GIF89a'))) return 'gif'
  if (startsWith(buffer, ascii('RIFF')) && startsWith(buffer, ascii('WEBP'), 8)) return 'webp'
  if (startsWith(buffer, ascii('%PDF-'))) return 'pdf'
  return null
}

// Plain text: decodes as UTF-8 (fatal: any invalid byte sequence fails) and has no NUL bytes, which real text never has
function isText(buffer) {
  if (buffer.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

const extensionOf = (name) => {
  const match = /\.([^.]+)$/.exec(name)
  return match ? match[1].toLowerCase() : ''
}

// The type to store for an allowed file, or null if it isn't allowed. A file is allowed only when its content is one of
// the kinds above AND its extension belongs to that kind.
function detectType(buffer, name) {
  const extension = extensionOf(name)
  const kind = binaryKind(buffer) ?? (isText(buffer) ? (extension === 'csv' ? 'csv' : 'text') : null)
  if (!kind || !KINDS[kind].extensions.includes(extension)) return null
  return KINDS[kind].mime
}

// The name to keep and show for an uploaded file: only the last part of any path, whitespace (tabs, line breaks)
// turned into single spaces, no other control characters, at most 255 characters (the extension is kept when it has to
// be shortened). Never used to build a path on disk.
function safeName(name) {
  const base = String(name ?? '')
    .split(/[/\\]/)
    .pop()
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/^\.+/, '') // no hidden files and no ".." left over
  const clean = base || 'file'
  if (clean.length <= 255) return clean
  const extension = extensionOf(clean)
  const keep = extension ? `.${extension}` : ''
  return clean.slice(0, 255 - keep.length) + keep
}

// Browsers send file names in multipart bodies as UTF-8, but the parser reads them as latin1; undo that, so
// "Préavis.pdf" stays "Préavis.pdf" (names that are already plain ASCII come out the same)
function decodeUploadName(name) {
  const decoded = Buffer.from(name, 'latin1').toString('utf8')
  return decoded.includes('�') ? name : decoded
}

// UPLOAD_DIR, made absolute. A relative path counts from the backend folder (where package.json is), not from wherever
// the server was started. Read on every call, so tests can point it somewhere else.
function uploadDir() {
  return path.resolve(__dirname, '..', process.env.UPLOAD_DIR?.trim() || DEFAULT_UPLOAD_DIR)
}

const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// The file's path on disk. stored_name always comes from our own database (a random UUID); checking its shape anyway
// means nothing else can ever turn into a path.
function storedPath(storedName) {
  if (!STORED_NAME.test(storedName)) throw new Error(`Invalid stored attachment name: ${storedName}`)
  return path.join(uploadDir(), storedName)
}

// Creates UPLOAD_DIR if needed and checks the server can write to it (at startup, from server.js). Throws if not.
function ensureUploadDir() {
  const dir = uploadDir()
  fsSync.mkdirSync(dir, { recursive: true })
  fsSync.accessSync(dir, fsSync.constants.W_OK)
  return dir
}

// Writes the file under a new random name and returns that name. 'wx': fail rather than overwrite (a UUID never
// repeats, but this makes it certain).
async function storeFile(buffer) {
  await fs.mkdir(uploadDir(), { recursive: true })
  const storedName = crypto.randomUUID()
  await fs.writeFile(storedPath(storedName), buffer, { flag: 'wx' })
  return storedName
}

// Deletes a stored file; one that is already gone is fine
async function removeFile(storedName) {
  try {
    await fs.unlink(storedPath(storedName))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

// Who may see a ticket (and so its attachments): staff (agents and admins) see every ticket, everyone else only the
// ones they raised. The same rule as GET /api/tickets/:id.
function canSeeTicket(user, requesterId) {
  return isStaff(user) || requesterId === user.id
}

// Who may delete an attachment: whoever uploaded it, or an admin
function canDeleteAttachment(user, attachment) {
  return user.role === 'admin' || attachment.uploaded_by_id === user.id
}

// The columns every attachment response is built from (uploaded_by as { id, name })
const ATTACHMENT_SELECT = `
  SELECT a.id, a.ticket_id, a.original_name, a.stored_name, a.mime_type, a.size_bytes, a.created_at,
         a.uploaded_by AS uploaded_by_id, u.name AS uploaded_by_name
  FROM attachments a
  JOIN users u ON u.id = a.uploaded_by`

// The shape sent to clients; stored_name stays on the server
function publicAttachment(row) {
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    uploaded_by: { id: row.uploaded_by_id, name: row.uploaded_by_name },
    created_at: row.created_at,
  }
}

async function listAttachments(db, ticketId) {
  const [rows] = await db.query(`${ATTACHMENT_SELECT} WHERE a.ticket_id = ? ORDER BY a.created_at, a.id`, [ticketId])
  return rows.map(publicAttachment)
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_FILES_PER_UPLOAD,
  MAX_FILES_PER_TICKET,
  DEFAULT_UPLOAD_DIR,
  ALLOWED_EXTENSIONS,
  KINDS,
  detectType,
  safeName,
  decodeUploadName,
  uploadDir,
  ensureUploadDir,
  storedPath,
  storeFile,
  removeFile,
  canSeeTicket,
  canDeleteAttachment,
  ATTACHMENT_SELECT,
  publicAttachment,
  listAttachments,
}
