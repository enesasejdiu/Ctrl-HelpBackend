// Knowledge base routes, mounted at /api/kb (README "Knowledge base"; rules in src/kb.js, migration 020).
//   Reading: everyone signed in, published articles only; staff (agents and admins, isStaff) also see drafts.
//   Writing articles and categories: staff. Deleting: admins only (staff unpublish instead).
// A draft or unknown article answers 404 the same way to non-staff, so drafts can't be found by guessing slugs.
// Checks fail with 422 in the usual { message, errors: [{ field, message }] } form; permissions come first (403).
const express = require('express')
const pool = require('../db')
const { HttpError } = require('../middleware/errors')
const { requireAuth, requireRole, isStaff } = require('../middleware/auth')
const validate = require('../middleware/validate')
const schemas = require('../schemas/kb')
const { recordAudit } = require('../audit')
const { logger } = require('../logger')
const { orderBySql, KB_ARTICLE_SORTS, DEFAULT_PAGE_SIZE } = require('../pagination')
const {
  RESERVED_ARTICLE_SLUGS,
  ARTICLE_SLUG_MAX,
  CATEGORY_SLUG_MAX,
  freeSlug,
  ARTICLE_LIST_COLUMNS,
  ARTICLE_COLUMNS,
  ARTICLE_FROM,
  listItem,
  fullArticle,
} = require('../kb')

const router = express.Router()
router.use(requireAuth)

const check = (schema) => validate(schema, { status: 422 })
const staffOnly = requireRole('agent', 'admin')
const adminOnly = requireRole('admin')

// A 422 for one field, in the same form as validate()'s
const fieldError = (field, message) => new HttpError(422, message, undefined, { errors: [{ field, message }] })

// ---- Categories ----

const CATEGORY_SELECT = `
  SELECT c.id, c.name, c.slug, c.sort_order, COUNT(a.id) AS published_count
  FROM kb_categories c
  LEFT JOIN kb_articles a ON a.category_id = c.id AND a.status = 'published'`
const CATEGORY_GROUP = 'GROUP BY c.id, c.name, c.slug, c.sort_order'
const category = (row) => ({ ...row, published_count: Number(row.published_count) })

async function findCategory(id) {
  const [[row]] = await pool.query(`${CATEGORY_SELECT} WHERE c.id = ? ${CATEGORY_GROUP}`, [id])
  return row ? category(row) : null
}

async function loadCategory(req, res, next) {
  req.category = await findCategory(req.valid.params.id)
  if (!req.category) throw new HttpError(404, 'Category not found')
  next()
}

// Names are unique ignoring case (the column's collation); `exceptId` is the category being renamed
async function checkCategoryName(name, exceptId = 0) {
  const [[taken]] = await pool.query('SELECT id FROM kb_categories WHERE name = ? AND id <> ?', [name, exceptId])
  if (taken) throw new HttpError(409, `There is already a category called "${name}"`, 'CATEGORY_EXISTS')
}

const categorySlugTaken = (exceptId) => async (slug) =>
  (await pool.query('SELECT 1 FROM kb_categories WHERE slug = ? AND id <> ?', [slug, exceptId]))[0].length > 0

// GET /api/kb/categories → [{ id, name, slug, sort_order, published_count }], by sort_order, then name
router.get('/categories', async (req, res) => {
  const [rows] = await pool.query(`${CATEGORY_SELECT} ${CATEGORY_GROUP} ORDER BY c.sort_order, c.name, c.id`)
  res.json(rows.map(category))
})

// POST /api/kb/categories { name, sort_order? } (staff) → 201 the category; 409 CATEGORY_EXISTS for a name in use
router.post('/categories', staffOnly, check(schemas.createCategory), async (req, res) => {
  const { name, sort_order: sortOrder = 0 } = req.valid.body
  await checkCategoryName(name)
  const slug = await freeSlug(name, CATEGORY_SLUG_MAX, 'category', categorySlugTaken(0))
  let result
  try {
    ;[result] = await pool.query('INSERT INTO kb_categories (name, slug, sort_order) VALUES (?, ?, ?)', [
      name,
      slug,
      sortOrder,
    ])
  } catch (err) {
    // Two requests with the same name (or slug) at once: the UNIQUE indexes stop the second
    if (err.code === 'ER_DUP_ENTRY')
      throw new HttpError(409, `There is already a category called "${name}"`, 'CATEGORY_EXISTS')
    throw err
  }
  await recordAudit('kb.category_created', {
    actorId: req.user.id,
    details: { category_id: result.insertId, name },
    req,
  })
  res.status(201).json(await findCategory(result.insertId))
})

// PATCH /api/kb/categories/:id { name?, sort_order? } (staff) → the category. A new name gets a new slug.
router.patch('/categories/:id', staffOnly, check(schemas.updateCategory), loadCategory, async (req, res) => {
  const { name, sort_order: sortOrder } = req.valid.body
  const current = req.category
  const sets = []
  const params = []
  if (name !== undefined && name !== current.name) {
    await checkCategoryName(name, current.id)
    sets.push('name = ?', 'slug = ?')
    params.push(name, await freeSlug(name, CATEGORY_SLUG_MAX, 'category', categorySlugTaken(current.id)))
  }
  if (sortOrder !== undefined && sortOrder !== current.sort_order) {
    sets.push('sort_order = ?')
    params.push(sortOrder)
  }
  if (sets.length > 0) {
    try {
      await pool.query(`UPDATE kb_categories SET ${sets.join(', ')} WHERE id = ?`, [...params, current.id])
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY')
        throw new HttpError(409, `There is already a category called "${name}"`, 'CATEGORY_EXISTS')
      throw err
    }
    await recordAudit('kb.category_updated', {
      actorId: req.user.id,
      details: {
        category_id: current.id,
        name: name ?? current.name,
        fields: [
          name !== undefined && name !== current.name && 'name',
          sets.includes('sort_order = ?') && 'sort_order',
        ].filter(Boolean),
      },
      req,
    })
  }
  res.json(await findCategory(current.id))
})

// DELETE /api/kb/categories/:id (admin) → 204; 409 CATEGORY_IN_USE while any article (draft or published) is in it
router.delete('/categories/:id', adminOnly, check(schemas.categoryParams), loadCategory, async (req, res) => {
  const current = req.category
  const inUse = () =>
    new HttpError(409, 'Move or delete the articles in this category first', 'CATEGORY_IN_USE', {
      category_id: current.id,
    })
  const [[{ count }]] = await pool.query('SELECT COUNT(*) AS count FROM kb_articles WHERE category_id = ?', [
    current.id,
  ])
  if (Number(count) > 0) throw inUse()
  try {
    await pool.query('DELETE FROM kb_categories WHERE id = ?', [current.id])
  } catch (err) {
    // An article was added in between: the foreign key (ON DELETE RESTRICT) refuses the delete
    if (err.code === 'ER_ROW_IS_REFERENCED_2') throw inUse()
    throw err
  }
  await recordAudit('kb.category_deleted', {
    actorId: req.user.id,
    details: { category_id: current.id, name: current.name },
    req,
  })
  res.status(204).end()
})

// ---- Articles ----

const SEARCH = 'MATCH(a.title, a.summary, a.body) AGAINST (? IN NATURAL LANGUAGE MODE)'

// GET /api/kb/articles?category=<slug>&q=&status=&page=&pageSize=&sort=&order=
//   → { items, total, page, pageSize }; items without body (summary, or the start of the body, as the excerpt).
// Non-staff: published only, whatever status says. Staff: status=draft|published, or all when left out.
// q: FULLTEXT natural-language search over title, summary and body, by relevance unless a sort is asked for.
router.get('/articles', check(schemas.listArticles), async (req, res) => {
  const query = req.valid.query
  let status = 'published'
  if (isStaff(req.user)) {
    status = query.status === undefined || query.status === 'all' ? null : query.status
    if (status && !schemas.STATUSES.includes(status)) {
      throw fieldError('status', `status must be one of: all, ${schemas.STATUSES.join(', ')}`)
    }
  }

  const where = []
  const whereParams = []
  if (status) {
    where.push('a.status = ?')
    whereParams.push(status)
  }
  if (query.category) {
    where.push('c.slug = ?')
    whereParams.push(query.category)
  }
  if (query.q) {
    where.push(SEARCH)
    whereParams.push(query.q)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const fromSql = 'FROM kb_articles a JOIN kb_categories c ON c.id = a.category_id'

  const page = query.page ?? 1
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE
  const byRelevance = Boolean(query.q) && !query.sort
  const selectSql = `SELECT ${ARTICLE_LIST_COLUMNS}${byRelevance ? `, ${SEARCH} AS relevance` : ''}`
  const orderSql = byRelevance
    ? 'ORDER BY relevance DESC, a.published_at IS NULL, a.published_at DESC, a.id DESC'
    : orderBySql(KB_ARTICLE_SORTS, { ...query, page }, { pagedSort: 'published_at', idColumn: 'a.id' })

  const [[rows], [[{ total }]]] = await Promise.all([
    pool.query(`${selectSql} ${fromSql} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`, [
      ...(byRelevance ? [query.q] : []),
      ...whereParams,
      pageSize,
      (page - 1) * pageSize,
    ]),
    pool.query(`SELECT COUNT(*) AS total ${fromSql} ${whereSql}`, whereParams),
  ])
  res.json({ items: rows.map(listItem), total: Number(total), page, pageSize })
})

async function findArticle(column, value) {
  const [[row]] = await pool.query(`SELECT ${ARTICLE_COLUMNS} ${ARTICLE_FROM} WHERE a.${column} = ?`, [value])
  return row ? fullArticle(row) : null
}

// GET /api/kb/articles/:slug → the article with its body, category, author and last editor. 404 for an unknown slug,
// and (the same answer) for a draft when the reader isn't staff.
router.get('/articles/:slug', check(schemas.articleSlugParams), async (req, res) => {
  const article = await findArticle('slug', req.valid.params.slug)
  if (!article || (article.status !== 'published' && !isStaff(req.user))) {
    throw new HttpError(404, 'Article not found')
  }
  res.json(article)
})

// A reserved slug (one of the frontend's own /kb/ pages) counts as taken
const articleSlugTaken = (exceptId) => async (slug) =>
  RESERVED_ARTICLE_SLUGS.includes(slug) ||
  (await pool.query('SELECT 1 FROM kb_articles WHERE slug = ? AND id <> ?', [slug, exceptId]))[0].length > 0

async function checkCategoryExists(categoryId, db = pool) {
  const [[row]] = await db.query('SELECT id FROM kb_categories WHERE id = ?', [categoryId])
  if (!row) throw fieldError('category_id', 'Choose a category from the list')
}

const articleDetails = (article) => ({ article_id: article.id, slug: article.slug, title: article.title })

// POST /api/kb/articles { title, summary?, body, category_id, status? } (staff) → 201 the article (draft unless status
// says published). The slug is made from the title; a taken one gets -2, -3, …
router.post('/articles', staffOnly, check(schemas.createArticle), async (req, res) => {
  const { title, summary = null, body, category_id: categoryId, status = 'draft' } = req.valid.body
  await checkCategoryExists(categoryId)

  let id
  // A slug is checked free, then inserted; if another request took it in between, the UNIQUE index refuses and the
  // next free one is tried
  for (let attempt = 0; id === undefined; attempt += 1) {
    const slug = await freeSlug(title, ARTICLE_SLUG_MAX, 'article', articleSlugTaken(0))
    try {
      const [result] = await pool.query(
        `INSERT INTO kb_articles (title, slug, summary, body, category_id, status, author_id, updated_by, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${status === 'published' ? 'NOW()' : 'NULL'})`,
        [title, slug, summary, body, categoryId, status, req.user.id, req.user.id],
      )
      id = result.insertId
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY' || attempt >= 2) throw err
    }
  }

  const article = await findArticle('id', id)
  await recordAudit('kb.article_created', { actorId: req.user.id, details: articleDetails(article), req })
  if (status === 'published') {
    await recordAudit('kb.article_published', { actorId: req.user.id, details: articleDetails(article), req })
  }
  res.status(201).json(article)
})

// The fields PATCH can change, and their columns
const ARTICLE_FIELDS = ['title', 'slug', 'summary', 'body', 'category_id']
// The ones in the FULLTEXT index (ft_kb_articles)
const SEARCHED_FIELDS = ['title', 'summary', 'body']

// InnoDB's full-text index keeps a deleted article's words in its statistics until the table is rebuilt, and an edit
// to an indexed column counts as a delete plus an insert. So every save made the article's own words look more
// common, and relevance drifted down (5 saves took a perfect match from 1.95 to 0.04): search results lost their
// order, and suggestions (src/search.js, MIN_RELEVANCE) lost the article. OPTIMIZE TABLE rebuilds kb_articles and
// clears them; for InnoDB it's an online rebuild (reads and writes go on), quick for a table of help articles, and
// needs no server setting. A failure is logged and never fails the save.
async function refreshSearchIndex() {
  try {
    await pool.query('OPTIMIZE TABLE kb_articles')
  } catch (err) {
    logger.warn({ err }, 'kb: rebuilding the search index failed; relevance may drift until the next rebuild')
  }
}

// PATCH /api/kb/articles/:id { updated_at, title?, slug?, summary?, body?, category_id?, status? } (staff) → the
// article. updated_at is the one the client loaded: a different one in the database means someone else saved in
// between → 409 ARTICLE_CHANGED (nothing is saved). status: published publishes (published_at is set the first time
// and kept), draft unpublishes. The slug can only change before the first publish → 409 SLUG_FIXED; a slug in use →
// 409 SLUG_TAKEN.
router.patch('/articles/:id', staffOnly, check(schemas.updateArticle), async (req, res) => {
  const { updated_at: loadedAt, status, ...changes } = req.valid.body
  const id = req.valid.params.id
  const conn = await pool.getConnection()
  // Set inside the transaction, used for the audit log after the commit
  let changed
  let statusChanged
  try {
    await conn.beginTransaction()
    // Locked until the commit, so two saves can't both pass the updated_at check
    const [[current]] = await conn.query(
      'SELECT id, slug, title, summary, body, category_id, status, published_at, updated_at FROM kb_articles WHERE id = ? FOR UPDATE',
      [id],
    )
    if (!current) throw new HttpError(404, 'Article not found')
    if (current.updated_at.getTime() !== loadedAt.getTime()) {
      throw new HttpError(409, 'Someone else changed this article after you opened it', 'ARTICLE_CHANGED', {
        updated_at: current.updated_at,
      })
    }

    changed = ARTICLE_FIELDS.filter((field) => changes[field] !== undefined && changes[field] !== current[field])
    if (changed.includes('slug')) {
      if (current.published_at) {
        throw new HttpError(
          409,
          "A published article's address can't change, so links to it keep working",
          'SLUG_FIXED',
        )
      }
      if (await articleSlugTaken(id)(changes.slug)) {
        throw new HttpError(409, 'Another article already uses this address', 'SLUG_TAKEN', {
          errors: [{ field: 'slug', message: 'Another article already uses this address' }],
        })
      }
    }
    if (changed.includes('category_id')) await checkCategoryExists(changes.category_id, conn)
    statusChanged = status !== undefined && status !== current.status

    const sets = changed.map((field) => `${field} = ?`)
    const params = changed.map((field) => changes[field])
    if (statusChanged) {
      sets.push('status = ?')
      params.push(status)
      // The first publish sets published_at; publishing again later keeps the original date
      if (status === 'published') sets.push('published_at = COALESCE(published_at, NOW())')
    }
    // Always later than before, even for two saves within the same millisecond, so a stale updated_at never matches
    sets.push('updated_by = ?', 'updated_at = GREATEST(CURRENT_TIMESTAMP(3), updated_at + INTERVAL 1000 MICROSECOND)')
    params.push(req.user.id)
    try {
      await conn.query(`UPDATE kb_articles SET ${sets.join(', ')} WHERE id = ?`, [...params, id])
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new HttpError(409, 'Another article already uses this address', 'SLUG_TAKEN', {
          errors: [{ field: 'slug', message: 'Another article already uses this address' }],
        })
      }
      throw err
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }

  if (changed.some((field) => SEARCHED_FIELDS.includes(field))) await refreshSearchIndex()
  const article = await findArticle('id', id)
  if (changed.length > 0) {
    await recordAudit('kb.article_updated', {
      actorId: req.user.id,
      details: { ...articleDetails(article), fields: changed },
      req,
    })
  }
  if (statusChanged) {
    const action = status === 'published' ? 'kb.article_published' : 'kb.article_unpublished'
    await recordAudit(action, { actorId: req.user.id, details: articleDetails(article), req })
  }
  res.json(article)
})

// DELETE /api/kb/articles/:id (admin) → 204
router.delete('/articles/:id', adminOnly, check(schemas.articleParams), async (req, res) => {
  const article = await findArticle('id', req.valid.params.id)
  if (!article) throw new HttpError(404, 'Article not found')
  await pool.query('DELETE FROM kb_articles WHERE id = ?', [article.id])
  await refreshSearchIndex()
  await recordAudit('kb.article_deleted', { actorId: req.user.id, details: articleDetails(article), req })
  res.status(204).end()
})

module.exports = router
