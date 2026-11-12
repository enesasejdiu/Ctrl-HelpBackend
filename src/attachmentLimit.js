// The attachment size limit, on its own so src/config.js can check ATTACHMENT_MAX_BYTES without loading the rest of
// src/attachments.js (and with it the database pool).
// The largest file allowed: always 10 MB, except in the test environment (NODE_ENV=test), where ATTACHMENT_MAX_BYTES
// may lower it so the tests can work with small files. Anywhere else ATTACHMENT_MAX_BYTES is ignored here, and
// src/config.js refuses to start the server with any other value. Read on every call, so tests can change it.
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB per file

// A valid ATTACHMENT_MAX_BYTES as a number, or null: a whole number of bytes from 1 to 10 MB
function parseMaxFileBytes(value) {
  if (value === undefined || value === '') return null
  const bytes = Number(value)
  return Number.isInteger(bytes) && bytes >= 1 && bytes <= DEFAULT_MAX_FILE_BYTES ? bytes : null
}

function maxFileBytes(env = process.env) {
  if (env.NODE_ENV !== 'test') return DEFAULT_MAX_FILE_BYTES
  return parseMaxFileBytes(env.ATTACHMENT_MAX_BYTES) ?? DEFAULT_MAX_FILE_BYTES
}

// 10485760 → "10 MB", 204800 → "200 KB", 900 → "900 bytes" (whole units only when exact, else one decimal)
function formatBytes(bytes) {
  const format = (value, unit) => `${Number.isInteger(value) ? value : value.toFixed(1)} ${unit}`
  if (bytes >= 1024 * 1024) return format(bytes / (1024 * 1024), 'MB')
  if (bytes >= 1024) return format(bytes / 1024, 'KB')
  return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`
}

module.exports = { DEFAULT_MAX_FILE_BYTES, maxFileBytes, parseMaxFileBytes, formatBytes }
