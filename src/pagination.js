// Paging and sorting for list endpoints (GET /api/tickets, GET /api/users). See "Pagination and sorting" in the README.
//
// - Without ?page= a list answers exactly as before: a plain JSON array of every row (old clients keep working).
//   ?sort=&order= still apply to it; ?pageSize= alone changes nothing.
// - With ?page= it answers { items, total, page, pageSize }, sorted by ?sort= or else by the list's paged default
//   (tickets newest first, users by name): one page of rows, and `total` = how many rows match the
//   filters (the count query uses the same FROM and WHERE as the list). A page past the end has items: [] and the
//   real total, so the client can go back to the last page.
// - The sort columns are an explicit allow-list per list (TICKET_SORTS, USER_SORTS below): ?sort= picks an entry by name,
//   and only that entry's own SQL is ever used. The request's text never goes into the query; LIMIT and OFFSET are
//   ? placeholders. Bad values are refused by the schema (400) before the route runs.
// - Every order ends with the row id, so rows that tie (same priority, same name) keep one fixed order and paging
//   never shows a row twice or skips one.
const { z } = require('zod')

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
// Far beyond any real list; keeps OFFSET a safe integer
const MAX_PAGE = 1_000_000

// The allow-lists: ?sort=<name> → its SQL (given ASC or DESC) and its direction when ?order= is left out.
// Columns come from the list's query (t = tickets, p = priorities; u = users, d = departments).
const TICKET_SORTS = {
  created_at: { order: 'desc', sql: (dir) => `t.created_at ${dir}` },
  updated_at: { order: 'desc', sql: (dir) => `t.updated_at ${dir}` },
  // By urgency (priorities.level), not by name; most urgent first by default
  priority: { order: 'desc', sql: (dir) => `p.level ${dir}` },
  // tickets.status is an ENUM, which sorts in its declared order: the workflow (open, assigned, in_progress,
  // waiting_for_user, resolved, closed, reopened)
  status: { order: 'asc', sql: (dir) => `t.status ${dir}` },
  title: { order: 'asc', sql: (dir) => `t.title ${dir}` },
}
const USER_SORTS = {
  name: { order: 'asc', sql: (dir) => `u.name ${dir}` },
  email: { order: 'asc', sql: (dir) => `u.email ${dir}` },
  // Alphabetical (admin, agent, employee, hr), not the ENUM's declared order
  role: { order: 'asc', sql: (dir) => `CAST(u.role AS CHAR) ${dir}` },
  // Users without a department come last in both directions
  department: { order: 'asc', sql: (dir) => `d.name IS NULL, d.name ${dir}` },
  created_at: { order: 'desc', sql: (dir) => `u.created_at ${dir}` },
  // Users who never logged in come last in both directions
  last_login_at: { order: 'desc', sql: (dir) => `u.last_login_at IS NULL, u.last_login_at ${dir}` },
}

// The sort a paged request (?page=) gets when it sends no ?sort=. A request without ?page= keeps the list's old order
// instead, so the plain array stays exactly as it was.
const TICKET_PAGED_DEFAULT = 'created_at'
const USER_PAGED_DEFAULT = 'name'

// An empty value (?page=) counts as not sent, like the list filters
const optional = (schema) => z.preprocess((value) => (value === '' ? undefined : value), schema.optional())

// A whole number from the query string, between min and max
function wholeNumber(label, min, max) {
  return z
    .string({ error: `${label} must be a whole number` })
    .regex(/^\d+$/, `${label} must be a whole number`)
    .transform(Number)
    .pipe(
      z
        .number()
        .min(min, `${label} must be at least ${min}`)
        .max(max, `${label} must be at most ${max.toLocaleString('en-US')}`),
    )
}

// The paging and sorting part of a list's query schema, for a list whose allow-list is `sorts`
function pagingSchema(sorts) {
  const names = Object.keys(sorts)
  return {
    page: optional(wholeNumber('page', 1, MAX_PAGE)),
    pageSize: optional(wholeNumber('pageSize', 1, MAX_PAGE_SIZE)),
    sort: optional(z.enum(names, { error: `sort must be one of: ${names.join(', ')}` })),
    order: optional(z.enum(['asc', 'desc'], { error: 'order must be asc or desc' })),
  }
}

// The ORDER BY clause: the chosen sort (its default direction when ?order= is left out). Without ?sort=: a paged
// request uses `pagedSort` (?order= applies to it), a plain-array request the list's old order `defaultSql`.
// `idColumn` breaks ties, in the same direction.
function orderBySql(sorts, { sort, order, page }, { defaultSql, pagedSort, idColumn }) {
  const chosen = sort ?? (page !== undefined ? pagedSort : undefined)
  if (!chosen) return `ORDER BY ${defaultSql}`
  const entry = sorts[chosen]
  const direction = (order ?? entry.order) === 'asc' ? 'ASC' : 'DESC'
  return `ORDER BY ${entry.sql(direction)}, ${idColumn} ${direction}`
}

// Runs the list. selectSql/fromSql/whereSql/params: the list's query parts (whereSql may be ''); orderSql from
// orderBySql. Returns the plain array without a page, or { items, total, page, pageSize } with one.
async function listRows(db, { selectSql, fromSql, whereSql, params, orderSql, query, format }) {
  const listSql = `${selectSql} ${fromSql} ${whereSql} ${orderSql}`
  if (query.page === undefined) {
    const [rows] = await db.query(listSql, params)
    return rows.map(format)
  }
  const page = query.page
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE
  const [[rows], [[{ total }]]] = await Promise.all([
    db.query(`${listSql} LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]),
    db.query(`SELECT COUNT(*) AS total ${fromSql} ${whereSql}`, params),
  ])
  return { items: rows.map(format), total: Number(total), page, pageSize }
}

module.exports = {
  TICKET_SORTS,
  USER_SORTS,
  TICKET_PAGED_DEFAULT,
  USER_PAGED_DEFAULT,
  pagingSchema,
  orderBySql,
  listRows,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_PAGE,
}
