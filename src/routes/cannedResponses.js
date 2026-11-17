// Mounted at /api/canned-responses: prepared replies staff insert into ticket comments (migration 022, README "Canned
// responses"). Staff only (agents and admins); everyone else gets 403 on every route.
//   shared   (owner_id NULL): every staff member lists and uses them; only admins create, edit and delete them
//   personal (owner_id set):  only the owner lists, uses, edits and deletes them. To anyone else they don't exist:
//                             404, never 403, so their existence isn't revealed
// Changes to shared responses go to the audit log; personal ones don't.
const express = require('express')
const pool = require('../db')
const { HttpError } = require('../middleware/errors')
const { requireAuth, requireRole } = require('../middleware/auth')
const validate = require('../middleware/validate')
const schemas = require('../schemas/cannedResponses')
const { recordAudit } = require('../audit')
const { likeContains, LIKE_ESCAPE } = require('../sqlLike')

const router = express.Router()
router.use(requireAuth, requireRole('agent', 'admin'))

const check = (schema) => validate(schema, { status: 422 })
const LIST_LIMIT = 50
const COLUMNS = `c.id, c.title, c.body, c.owner_id, c.usage_count, c.last_used_at, c.created_at, c.updated_at,
  c.updated_by AS updated_by_id, u.name AS updated_by_name`
const FROM = 'FROM canned_responses c LEFT JOIN users u ON u.id = c.updated_by'

const isAdmin = (user) => user.role === 'admin'
// May `user` change this response? Shared: admins. Personal: its owner.
const canEdit = (user, row) => (row.owner_id === null ? isAdmin(user) : row.owner_id === user.id)

function format(row, user) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    shared: row.owner_id === null,
    owner_id: row.owner_id,
    usage_count: row.usage_count,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    updated_by: row.updated_by_id ? { id: row.updated_by_id, name: row.updated_by_name } : null,
    can_edit: canEdit(user, row),
  }
}

// 409 TITLE_TAKEN, with the message under the title field too
function titleTaken(shared) {
  const message = shared
    ? 'There is already a shared response with this title'
    : 'You already have a response with this title'
  return new HttpError(409, message, 'TITLE_TAKEN', { errors: [{ field: 'title', message }] })
}

// The response if `user` may see it (shared, or their own); otherwise 404, whether it exists or not
async function findVisible(id, user) {
  const [[row]] = await pool.query(
    `SELECT ${COLUMNS} ${FROM} WHERE c.id = ? AND (c.owner_id IS NULL OR c.owner_id = ?)`,
    [id, user.id],
  )
  if (!row) throw new HttpError(404, 'Canned response not found')
  return row
}

// For PATCH and DELETE: visible, and changeable by this user (a shared one by a non-admin → 403)
async function findEditable(id, user) {
  const row = await findVisible(id, user)
  if (!canEdit(user, row)) throw new HttpError(403, 'Only admins can change shared responses')
  return row
}

const audit = (action, row, req, extra = {}) =>
  recordAudit(action, {
    actorId: req.user.id,
    details: { canned_response_id: row.id, title: row.title, ...extra },
    req,
  })

// GET /api/canned-responses?q=&scope=all|shared|mine → at most 50, most used first, then by title. all (default):
// the shared ones and the user's own. Never anyone else's personal ones. q: in the title or the text.
router.get('/', check(schemas.list), async (req, res) => {
  const { q, scope = 'all' } = req.valid.query
  const where = []
  const params = []
  if (scope === 'shared') where.push('c.owner_id IS NULL')
  else if (scope === 'mine') {
    where.push('c.owner_id = ?')
    params.push(req.user.id)
  } else {
    where.push('(c.owner_id IS NULL OR c.owner_id = ?)')
    params.push(req.user.id)
  }
  if (q) {
    where.push(`(c.title LIKE ? ${LIKE_ESCAPE} OR c.body LIKE ? ${LIKE_ESCAPE})`)
    params.push(likeContains(q), likeContains(q))
  }
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} ${FROM} WHERE ${where.join(' AND ')} ORDER BY c.usage_count DESC, c.title, c.id LIMIT ?`,
    [...params, LIST_LIMIT],
  )
  res.json(rows.map((row) => format(row, req.user)))
})

// POST /api/canned-responses { title, body, shared? } → 201. shared: true is admins only (403); otherwise it's the
// user's own. A title in use in that scope → 409 TITLE_TAKEN.
router.post('/', check(schemas.create), async (req, res) => {
  const { title, body, shared = false } = req.valid.body
  if (shared && !isAdmin(req.user)) throw new HttpError(403, 'Only admins can create shared responses')
  let insertId
  try {
    ;[{ insertId }] = await pool.query(
      'INSERT INTO canned_responses (title, body, owner_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?)',
      [title, body, shared ? null : req.user.id, req.user.id, req.user.id],
    )
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw titleTaken(shared)
    throw err
  }
  const row = await findVisible(insertId, req.user)
  if (shared) await audit('canned.shared_created', row, req)
  res.status(201).json(format(row, req.user))
})

// PATCH /api/canned-responses/:id { title?, body? } → the response. Personal: the owner only; shared: admins only
// (403). Someone else's personal one → 404.
router.patch('/:id', check(schemas.update), async (req, res) => {
  const current = await findEditable(req.valid.params.id, req.user)
  const changes = req.valid.body
  const fields = ['title', 'body'].filter((field) => changes[field] !== undefined && changes[field] !== current[field])
  if (fields.length > 0) {
    try {
      await pool.query(
        `UPDATE canned_responses SET ${fields.map((field) => `${field} = ?`).join(', ')}, updated_by = ? WHERE id = ?`,
        [...fields.map((field) => changes[field]), req.user.id, current.id],
      )
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw titleTaken(current.owner_id === null)
      throw err
    }
  }
  const row = await findVisible(current.id, req.user)
  if (row.owner_id === null && fields.length > 0) await audit('canned.shared_updated', row, req, { fields })
  res.json(format(row, req.user))
})

// DELETE /api/canned-responses/:id → 204. Same rules as PATCH.
router.delete('/:id', check(schemas.params), async (req, res) => {
  const row = await findEditable(req.valid.params.id, req.user)
  await pool.query('DELETE FROM canned_responses WHERE id = ?', [row.id])
  if (row.owner_id === null) await audit('canned.shared_deleted', row, req)
  res.status(204).end()
})

// POST /api/canned-responses/:id/used → 204: counts one use (the frontend calls it after inserting the text, without
// waiting). Any response the user may see. updated_at stays: using a response doesn't change it.
router.post('/:id/used', check(schemas.params), async (req, res) => {
  const row = await findVisible(req.valid.params.id, req.user)
  await pool.query(
    'UPDATE canned_responses SET usage_count = usage_count + 1, last_used_at = NOW(), updated_at = updated_at WHERE id = ?',
    [row.id],
  )
  res.status(204).end()
})

module.exports = router
