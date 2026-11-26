// Admin settings: ticket categories, priorities and the company name (migration 015; see "Admin settings" in the
// README). Three routers, mounted at /api/categories, /api/priorities and /api/settings (routes/index.js).
//
// Reading: any logged-in user (tickets need the lists), and GET /api/settings/public without a login. Writing: admins
// only (403 for everyone else, 401 without a session). Every write clears the cache in src/settings.js, so the next
// read sees it.
//
// Rules the database can't check by itself are checked in a transaction that locks the rows involved, so two admins
// saving at once can't break them: exactly one default priority, at least one active priority, ranks unique and
// reassigned together, nothing deleted while tickets use it.
const express = require('express')
const pool = require('../db')
const { HttpError } = require('../middleware/errors')
const { requireAuth, requireRole } = require('../middleware/auth')
const validate = require('../middleware/validate')
const { isEmailConfigured } = require('../mail/mailer')
const settings = require('../settings')
const schemas = require('../schemas/settings')

const adminOnly = requireRole('admin')
const isAdmin = (user) => user.role === 'admin'

// A unique name or rank already taken (ER_DUP_ENTRY) as a 409; anything else is rethrown
function duplicateError(err, label) {
  if (err.code !== 'ER_DUP_ENTRY') return err
  if (/uq_priorities_level/.test(err.message)) {
    return new HttpError(409, 'Another priority already has this rank', 'RANK_TAKEN', {
      errors: [{ field: 'rank', message: 'Another priority already has this rank' }],
    })
  }
  const message = `A ${label} with this name already exists`
  return new HttpError(409, message, 'NAME_TAKEN', { errors: [{ field: 'name', message }] })
}

// Runs `work(conn)` in a transaction; commits, or rolls back on any error. Clears the cache once it's committed.
async function inTransaction(work) {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const result = await work(conn)
    await conn.commit()
    settings.clearCache()
    return result
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

// How many tickets use each category / priority: { [id]: count }. Only for admins (the settings page), and never
// cached, because tickets change all the time.
async function ticketCounts(column) {
  const [rows] = await pool.query(`SELECT ${column} AS id, COUNT(*) AS n FROM tickets GROUP BY ${column}`)
  return Object.fromEntries(rows.map((row) => [row.id, Number(row.n)]))
}

// ---------------------------------------------------------------------------------------------------------------------
// Categories
const categories = express.Router()
categories.use(requireAuth)

async function findCategory(id) {
  const category = (await settings.allCategories()).find((c) => c.id === id)
  if (!category) throw new HttpError(404, 'Category not found')
  return category
}

// GET /api/categories → the active categories, by sort_order then name. Admins: ?include_inactive=1 adds the
// archived ones, and every category has its ticket_count. (Others asking for archived ones just get the active list.)
/**
 * @openapi
 * components:
 *   parameters:
 *     IncludeInactive:
 *       name: include_inactive
 *       in: query
 *       description: '`1` = also archived ones (admins only; ignored for everyone else)'
 *       schema: { type: string, enum: ['1'] }
 *     CategoryId:
 *       name: id
 *       in: path
 *       required: true
 *       schema: { type: integer, minimum: 1, example: 3 }
 *     PriorityId:
 *       name: id
 *       in: path
 *       required: true
 *       schema: { type: integer, minimum: 1, example: 3 }
 *   responses:
 *     CategoryNotFound:
 *       description: No such category
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Error' }
 *           example: { message: Category not found }
 *     PriorityNotFound:
 *       description: No such priority
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Error' }
 *           example: { message: Priority not found }
 *
 * /api/categories:
 *   get:
 *     tags: [Categories]
 *     summary: List ticket categories
 *     description: |
 *       **Roles:** any logged-in user. The active categories, by sort_order then name. Admins also get each
 *       category's `ticket_count`, and archived ones with `include_inactive=1`.
 *     parameters:
 *       - $ref: '#/components/parameters/IncludeInactive'
 *     responses:
 *       '200':
 *         description: The categories
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Category' }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '500': { $ref: '#/components/responses/InternalError' }
 *   post:
 *     tags: [Categories]
 *     summary: Create a ticket category
 *     description: '**Roles:** `admin`. Without sort_order it goes after the last one.'
 *     security: [{ cookieAuth: [], csrfToken: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateCategoryRequest' }
 *     responses:
 *       '201':
 *         description: The new category
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Category' }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '409':
 *         description: The name is taken
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ValidationError' }
 *             example:
 *               message: A category with this name already exists
 *               code: NAME_TAKEN
 *               errors: [{ field: name, message: A category with this name already exists }]
 *       '500': { $ref: '#/components/responses/InternalError' }
 */
categories.get('/', validate(schemas.listQuery), async (req, res) => {
  const all = await settings.allCategories()
  const withInactive = isAdmin(req.user) && req.valid.query.include_inactive === '1'
  const list = withInactive ? all : all.filter((c) => c.is_active)
  if (!isAdmin(req.user)) return res.json(list)
  const counts = await ticketCounts('category_id')
  res.json(list.map((c) => ({ ...c, ticket_count: counts[c.id] ?? 0 })))
})

// POST /api/categories { name, description?, sort_order? } (admin) → 201 the category. sort_order defaults to after
// the last one.
categories.post('/', adminOnly, validate(schemas.createCategory), async (req, res) => {
  const { name, description = null, sort_order: sortOrder } = req.valid.body
  let insertId
  try {
    ;[{ insertId }] = await pool.query(
      `INSERT INTO categories (name, description, sort_order)
       SELECT ?, ?, COALESCE(?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories c))`,
      [name, description, sortOrder ?? null],
    )
  } catch (err) {
    throw duplicateError(err, 'category')
  }
  settings.clearCache()
  res.status(201).json(await findCategory(insertId))
})

// PATCH /api/categories/:id { name?, description?, sort_order?, is_active? } (admin) → the category.
// is_active: false archives it: it can't be chosen for new tickets, and tickets that have it keep it.
/**
 * @openapi
 * /api/categories/{id}:
 *   patch:
 *     tags: [Categories]
 *     summary: Update or archive a ticket category
 *     description: |
 *       **Roles:** `admin`. Send at least one field. `is_active: false` archives it: it can't be chosen for new
 *       tickets, and tickets that have it keep it.
 *     security: [{ cookieAuth: [], csrfToken: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/CategoryId'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateCategoryRequest' }
 *     responses:
 *       '200':
 *         description: The category
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Category' }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '404': { $ref: '#/components/responses/CategoryNotFound' }
 *       '409':
 *         description: The name is taken (`NAME_TAKEN`)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ValidationError' }
 *       '500': { $ref: '#/components/responses/InternalError' }
 *   delete:
 *     tags: [Categories]
 *     summary: Delete an unused ticket category
 *     description: '**Roles:** `admin`. Only when no ticket uses it; otherwise archive it with `is_active: false`.'
 *     security: [{ cookieAuth: [], csrfToken: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/CategoryId'
 *     responses:
 *       '204': { description: Deleted }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '404': { $ref: '#/components/responses/CategoryNotFound' }
 *       '409':
 *         description: Tickets use it
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { message: 'This category is used by 18 tickets. Archive it instead (is_active: false).', code: CATEGORY_IN_USE, ticket_count: 18 }
 *       '500': { $ref: '#/components/responses/InternalError' }
 */
categories.patch('/:id', adminOnly, validate(schemas.updateCategory), async (req, res) => {
  const { id } = req.valid.params
  await findCategory(id)
  const changes = Object.entries(req.valid.body).filter(([, value]) => value !== undefined)
  try {
    await pool.query(`UPDATE categories SET ${changes.map(([field]) => `${field} = ?`).join(', ')} WHERE id = ?`, [
      ...changes.map(([, value]) => value),
      id,
    ])
  } catch (err) {
    throw duplicateError(err, 'category')
  }
  settings.clearCache()
  res.json(await findCategory(id))
})

// DELETE /api/categories/:id (admin) → 204, only when no ticket uses it; otherwise 409 CATEGORY_IN_USE with the count
categories.delete('/:id', adminOnly, validate(schemas.categoryParams), async (req, res) => {
  const { id } = req.valid.params
  await findCategory(id)
  await inTransaction(async (conn) => {
    await conn.query('SELECT id FROM categories WHERE id = ? FOR UPDATE', [id])
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM tickets WHERE category_id = ?', [id])
    if (n > 0) {
      throw new HttpError(
        409,
        `This category is used by ${n} ${n === 1 ? 'ticket' : 'tickets'}. Archive it instead (is_active: false).`,
        'CATEGORY_IN_USE',
        { ticket_count: Number(n) },
      )
    }
    await conn.query('DELETE FROM categories WHERE id = ?', [id])
  })
  res.status(204).end()
})

// ---------------------------------------------------------------------------------------------------------------------
// Priorities
const priorities = express.Router()
priorities.use(requireAuth)

async function findPriority(id) {
  const priority = (await settings.allPriorities()).find((p) => p.id === id)
  if (!priority) throw new HttpError(404, 'Priority not found')
  return priority
}

// Every priority row, locked until the transaction ends: the rules below look at all of them together
async function lockPriorities(conn) {
  const [rows] = await conn.query('SELECT id, level, is_default, is_active FROM priorities ORDER BY level FOR UPDATE')
  return rows.map((row) => ({ ...row, is_default: Boolean(row.is_default), is_active: Boolean(row.is_active) }))
}

// Makes `id` the only default (two statements: the unique default index is checked row by row)
async function makeDefault(conn, id) {
  await conn.query('UPDATE priorities SET is_default = FALSE WHERE is_default AND id <> ?', [id])
  await conn.query('UPDATE priorities SET is_default = TRUE WHERE id = ?', [id])
}

// GET /api/priorities → the active priorities, least urgent first (by rank), with target_hours and is_default.
// Admins: ?include_inactive=1 adds archived ones, and each has its ticket_count.
/**
 * @openapi
 * /api/priorities:
 *   get:
 *     tags: [Priorities]
 *     summary: List ticket priorities
 *     description: |
 *       **Roles:** any logged-in user. The active priorities, least urgent first, with their target resolution time
 *       and which is the default. Admins also get `ticket_count`, and archived ones with `include_inactive=1`.
 *     parameters:
 *       - $ref: '#/components/parameters/IncludeInactive'
 *     responses:
 *       '200':
 *         description: The priorities
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Priority' }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '500': { $ref: '#/components/responses/InternalError' }
 *   post:
 *     tags: [Priorities]
 *     summary: Create a ticket priority
 *     description: '**Roles:** `admin`. `is_default: true` makes it the default instead of the current one.'
 *     security: [{ cookieAuth: [], csrfToken: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreatePriorityRequest' }
 *     responses:
 *       '201':
 *         description: The new priority
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Priority' }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '409':
 *         description: The name (`NAME_TAKEN`) or rank (`RANK_TAKEN`) is taken
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ValidationError' }
 *             example:
 *               message: Another priority already has this rank
 *               code: RANK_TAKEN
 *               errors: [{ field: rank, message: Another priority already has this rank }]
 *       '500': { $ref: '#/components/responses/InternalError' }
 */
priorities.get('/', validate(schemas.listQuery), async (req, res) => {
  const all = await settings.allPriorities()
  const withInactive = isAdmin(req.user) && req.valid.query.include_inactive === '1'
  const list = withInactive ? all : all.filter((p) => p.is_active)
  if (!isAdmin(req.user)) return res.json(list)
  const counts = await ticketCounts('priority_id')
  res.json(list.map((p) => ({ ...p, ticket_count: counts[p.id] ?? 0 })))
})

// PUT /api/priorities/order { ids } (admin) → the priorities in their new order. ids lists every priority exactly once,
// least urgent first; ranks become 1, 2, 3, ... in that order, all in one transaction. Otherwise 422 INVALID_ORDER.
/**
 * @openapi
 * /api/priorities/order:
 *   put:
 *     tags: [Priorities]
 *     summary: Reorder the priorities
 *     description: |
 *       **Roles:** `admin`. `ids` lists every priority (archived ones too) exactly once, least urgent first; their
 *       ranks become 1, 2, 3, … in that order.
 *     security: [{ cookieAuth: [], csrfToken: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ReorderPrioritiesRequest' }
 *     responses:
 *       '200':
 *         description: Every priority in its new order
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Priority' }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '422':
 *         description: ids doesn't list every priority exactly once
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ValidationError' }
 *             example:
 *               message: ids must list every priority exactly once
 *               code: INVALID_ORDER
 *               errors: [{ field: ids, message: 'Send all 4 priority ids, each once' }]
 *       '500': { $ref: '#/components/responses/InternalError' }
 */
priorities.put('/order', adminOnly, validate(schemas.reorderPriorities), async (req, res) => {
  const { ids } = req.valid.body
  await inTransaction(async (conn) => {
    const rows = await lockPriorities(conn)
    const known = new Set(rows.map((row) => row.id))
    const complete = ids.length === rows.length && new Set(ids).size === ids.length && ids.every((id) => known.has(id))
    if (!complete) {
      throw new HttpError(422, 'ids must list every priority exactly once', 'INVALID_ORDER', {
        errors: [{ field: 'ids', message: `Send all ${rows.length} priority ids, each once` }],
      })
    }
    // Out of the way first (ranks are unique), then 1..n
    await conn.query('UPDATE priorities SET level = -level')
    for (const [index, id] of ids.entries()) {
      await conn.query('UPDATE priorities SET level = ? WHERE id = ?', [index + 1, id])
    }
  })
  res.json(await settings.allPriorities())
})

// POST /api/priorities { name, rank, target_hours, is_default? } (admin) → 201 the priority. 409 NAME_TAKEN /
// RANK_TAKEN. is_default: true makes it the default instead of the current one.
priorities.post('/', adminOnly, validate(schemas.createPriority), async (req, res) => {
  const { name, rank, target_hours: targetHours, is_default: isDefault = false } = req.valid.body
  const id = await inTransaction(async (conn) => {
    await lockPriorities(conn)
    let insertId
    try {
      ;[{ insertId }] = await conn.query('INSERT INTO priorities (name, level, target_hours) VALUES (?, ?, ?)', [
        name,
        rank,
        targetHours,
      ])
    } catch (err) {
      throw duplicateError(err, 'priority')
    }
    if (isDefault) await makeDefault(conn, insertId)
    return insertId
  })
  res.status(201).json(await findPriority(id))
})

// PATCH /api/priorities/:id { name?, rank?, target_hours?, is_default?, is_active? } (admin) → the priority.
// The default can't be unset directly (make another one the default) or archived, and the last active priority
// can't be archived: 409 PRIORITY_IS_DEFAULT / LAST_ACTIVE_PRIORITY.
/**
 * @openapi
 * /api/priorities/{id}:
 *   patch:
 *     tags: [Priorities]
 *     summary: Update or archive a ticket priority
 *     description: |
 *       **Roles:** `admin`. Send at least one field. The default priority can't be unset directly (make another one
 *       the default) or archived, and the last active priority can't be archived.
 *     security: [{ cookieAuth: [], csrfToken: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/PriorityId'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdatePriorityRequest' }
 *     responses:
 *       '200':
 *         description: The priority
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Priority' }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '404': { $ref: '#/components/responses/PriorityNotFound' }
 *       '409':
 *         description: '`NAME_TAKEN`, `RANK_TAKEN`, `PRIORITY_IS_DEFAULT` or `LAST_ACTIVE_PRIORITY`'
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { message: "The default priority can't be archived. Make another one the default first.", code: PRIORITY_IS_DEFAULT }
 *       '500': { $ref: '#/components/responses/InternalError' }
 *   delete:
 *     tags: [Priorities]
 *     summary: Delete an unused ticket priority
 *     description: '**Roles:** `admin`. Not the default, and only when no ticket uses it (otherwise archive it).'
 *     security: [{ cookieAuth: [], csrfToken: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/PriorityId'
 *     responses:
 *       '204': { description: Deleted }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '404': { $ref: '#/components/responses/PriorityNotFound' }
 *       '409':
 *         description: It is the default (`PRIORITY_IS_DEFAULT`) or tickets use it (`PRIORITY_IN_USE`)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { message: 'This priority is used by 9 tickets. Archive it instead (is_active: false).', code: PRIORITY_IN_USE, ticket_count: 9 }
 *       '500': { $ref: '#/components/responses/InternalError' }
 */
priorities.patch('/:id', adminOnly, validate(schemas.updatePriority), async (req, res) => {
  const { id } = req.valid.params
  const { name, rank, target_hours: targetHours, is_default: isDefault, is_active: isActive } = req.valid.body
  await findPriority(id)
  await inTransaction(async (conn) => {
    const rows = await lockPriorities(conn)
    const current = rows.find((row) => row.id === id)
    if (!current) throw new HttpError(404, 'Priority not found')
    const willBeDefault = isDefault ?? current.is_default
    const willBeActive = isActive ?? current.is_active

    if (current.is_default && isDefault === false) {
      throw new HttpError(
        409,
        'A priority must be the default. Make another priority the default instead.',
        'PRIORITY_IS_DEFAULT',
      )
    }
    if (willBeDefault && !willBeActive) {
      throw new HttpError(
        409,
        "The default priority can't be archived. Make another one the default first.",
        'PRIORITY_IS_DEFAULT',
      )
    }
    if (current.is_active && !willBeActive && rows.filter((row) => row.is_active).length === 1) {
      throw new HttpError(409, "The last active priority can't be archived", 'LAST_ACTIVE_PRIORITY')
    }

    const changes = Object.entries({ name, level: rank, target_hours: targetHours, is_active: isActive }).filter(
      ([, value]) => value !== undefined,
    )
    if (changes.length) {
      try {
        await conn.query(`UPDATE priorities SET ${changes.map(([field]) => `${field} = ?`).join(', ')} WHERE id = ?`, [
          ...changes.map(([, value]) => value),
          id,
        ])
      } catch (err) {
        throw duplicateError(err, 'priority')
      }
    }
    if (isDefault === true && !current.is_default) await makeDefault(conn, id)
  })
  res.json(await findPriority(id))
})

// DELETE /api/priorities/:id (admin) → 204, only when it isn't the default and no ticket uses it
// (409 PRIORITY_IS_DEFAULT / PRIORITY_IN_USE with the count)
priorities.delete('/:id', adminOnly, validate(schemas.priorityParams), async (req, res) => {
  const { id } = req.valid.params
  await findPriority(id)
  await inTransaction(async (conn) => {
    const rows = await lockPriorities(conn)
    const current = rows.find((row) => row.id === id)
    if (!current) throw new HttpError(404, 'Priority not found')
    if (current.is_default) {
      throw new HttpError(
        409,
        "The default priority can't be deleted. Make another one the default first.",
        'PRIORITY_IS_DEFAULT',
      )
    }
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM tickets WHERE priority_id = ?', [id])
    if (n > 0) {
      throw new HttpError(
        409,
        `This priority is used by ${n} ${n === 1 ? 'ticket' : 'tickets'}. Archive it instead (is_active: false).`,
        'PRIORITY_IN_USE',
        { ticket_count: Number(n) },
      )
    }
    await conn.query('DELETE FROM priorities WHERE id = ?', [id])
  })
  res.status(204).end()
})

// ---------------------------------------------------------------------------------------------------------------------
// Company settings
const company = express.Router()

// GET /api/settings/public → { company_name, email_enabled } without a login (sign-in page and app header)
/**
 * @openapi
 * /api/settings/public:
 *   get:
 *     tags: [Settings]
 *     summary: Public company settings
 *     description: Public (no login). The company name and whether email is set up, for the sign-in page and header.
 *     security: []
 *     responses:
 *       '200':
 *         description: The public settings
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PublicSettings' }
 *       '500': { $ref: '#/components/responses/InternalError' }
 */
company.get('/public', async (req, res) => {
  const { company_name: companyName } = await settings.companySettings()
  res.json({ company_name: companyName, email_enabled: isEmailConfigured() })
})

company.use(requireAuth)

// GET /api/settings (admin) → { company_name, auto_close_days, escalation_enabled, escalation_unassigned_minutes }
/**
 * @openapi
 * /api/settings:
 *   get:
 *     tags: [Settings]
 *     summary: Get the company settings
 *     description: '**Roles:** `admin`.'
 *     responses:
 *       '200':
 *         description: The settings
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AdminSettings' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '500': { $ref: '#/components/responses/InternalError' }
 *   patch:
 *     tags: [Settings]
 *     summary: Change the company settings
 *     description: |
 *       **Roles:** `admin`. Send at least one field. `auto_close_days: 0` switches the daily auto-close of resolved
 *       tickets off.
 *     security: [{ cookieAuth: [], csrfToken: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateSettingsRequest' }
 *     responses:
 *       '200':
 *         description: The settings after the change
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AdminSettings' }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '500': { $ref: '#/components/responses/InternalError' }
 */
company.get('/', adminOnly, async (req, res) => {
  res.json(await settings.adminSettings())
})

// PATCH /api/settings { company_name?, auto_close_days?, escalation_enabled?, escalation_unassigned_minutes? } (admin,
// at least one) → the settings.
// company_name: trimmed, 1–100 characters. auto_close_days: a whole number of days, 0–365; 0 switches the daily
// auto-close job off (src/jobs/autoClose.js). escalation_enabled: true/false, the escalation emails
// (src/jobs/escalation.js). escalation_unassigned_minutes: 15–1440, how long an urgent ticket may stay unassigned.
company.patch('/', adminOnly, validate(schemas.updateSettings), async (req, res) => {
  const {
    company_name: companyName,
    auto_close_days: autoCloseDays,
    escalation_enabled: escalationEnabled,
    escalation_unassigned_minutes: unassignedMinutes,
  } = req.valid.body
  const upsert = (key, value) =>
    pool.query(
      `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [key, String(value)],
    )
  if (companyName !== undefined) await upsert('company_name', companyName)
  if (autoCloseDays !== undefined) await upsert('auto_close_days', autoCloseDays)
  if (escalationEnabled !== undefined) await upsert('escalation_enabled', escalationEnabled ? 'true' : 'false')
  if (unassignedMinutes !== undefined) await upsert('escalation_unassigned_minutes', unassignedMinutes)
  settings.clearCache()
  res.json(await settings.adminSettings())
})

module.exports = { categories, priorities, company }
