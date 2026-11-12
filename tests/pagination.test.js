// Tests for paging and sorting GET /api/tickets and GET /api/users (src/pagination.js): page/pageSize and their
// limits, total with every filter, every sort column in both directions (paged through, so ties and page edges are
// checked too), bad values → 400, and the old plain-array answer when no page is sent.
const pool = require('../src/db')
const { api, resetData, createUser, createDepartment, loginAs, auth } = require('./helpers')
const { TICKET_SORTS, USER_SORTS, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } = require('../src/pagination')

// The ENUM's declared order (migrations/001_initial.sql), which is how status sorts
const STATUSES = ['open', 'assigned', 'in_progress', 'waiting_for_user', 'resolved', 'closed', 'reopened']
const BASE = Date.UTC(2026, 0, 1, 8)
const hours = (n) => new Date(BASE + n * 3_600_000)

let callers
let tickets // every ticket row as stored, with its priority's level
let users // every user row, with its department's name

const get = (path, caller = callers.admin) => api.get(path).set(auth(caller.token))

// Every ticket of the requester (30) and of a second employee (5). Titles, times, priorities and statuses are
// shuffled against the id (multiples modulo 30), so no sort can pass by following the insert order by accident.
// Priorities and statuses repeat, so their sorts have ties that only the id can order.
async function createTickets({ requester, other, agent }) {
  const [priorities] = await pool.query('SELECT id, level FROM priorities ORDER BY level')
  const [[category]] = await pool.query('SELECT id FROM categories ORDER BY id LIMIT 1')
  for (let i = 0; i < 35; i += 1) {
    const mine = i < 30
    await pool.query(
      `INSERT INTO tickets (title, description, requester_id, assigned_to, category_id, priority_id, status,
         created_at, updated_at)
       VALUES (?, 'Paging test', ?, ?, ?, ?, ?, ?, ?)`,
      [
        `Ticket ${String((i * 13) % 35).padStart(2, '0')}${i % 5 === 0 ? ' printer' : ''}`,
        mine ? requester.id : other.id,
        i % 4 === 0 ? agent.id : null,
        category.id,
        priorities[(i * 3) % 4].id,
        STATUSES[i % 7],
        hours((i * 11) % 35),
        hours(100 + ((i * 17) % 35)),
      ],
    )
  }
  const [rows] = await pool.query(
    'SELECT t.*, p.level AS priority_level FROM tickets t JOIN priorities p ON p.id = t.priority_id',
  )
  return rows
}

beforeAll(async () => {
  await resetData()
  const itDept = await createDepartment('IT')
  const sales = await createDepartment('Sales')
  callers = {
    admin: await createUser({ role: 'admin', name: 'Ardit Admin', email: 'ardit@test.local', departmentId: itDept }),
    hr: await createUser({ role: 'hr', name: 'Hana HR', email: 'hana@test.local', departmentId: sales }),
    agent: await createUser({ role: 'agent', name: 'Besa Agent', email: 'besa@test.local', departmentId: itDept }),
    requester: await createUser({ role: 'employee', name: 'Drita Employee', email: 'drita@test.local' }),
    other: await createUser({ role: 'employee', name: 'Era Employee', email: 'era@test.local', departmentId: sales }),
  }
  // Two people with the same name (a tie only the id orders), and joining dates out of id order
  await createUser({ role: 'employee', name: 'Same Name', email: 'same.b@test.local' })
  await createUser({ role: 'employee', name: 'Same Name', email: 'same.a@test.local', departmentId: itDept })
  await pool.query('UPDATE users SET created_at = ? + INTERVAL ((id * 5) % 7) DAY', [hours(0)])
  for (const caller of Object.values(callers)) caller.token = await loginAs(caller)

  tickets = await createTickets(callers)
  ;[users] = await pool.query(
    'SELECT u.*, d.name AS department_name FROM users u LEFT JOIN departments d ON d.id = u.department_id',
  )
})

// Every page of `path` (pageSize 7, so 35 rows make exactly 5 pages and 30 rows end on a short one), joined
function allPages(path, caller) {
  return (async () => {
    const ids = []
    for (let page = 1; ; page += 1) {
      const res = await get(`${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=7`, caller)
      expect(res.status).toBe(200)
      ids.push(...res.body.items.map((row) => row.id))
      if (res.body.items.length < 7) return { ids, total: res.body.total }
    }
  })()
}

// The order a sort must give: by its value, ties by id, both in the sort's direction
function expectedOrder(rows, valueOf, direction, { nullsLast = false } = {}) {
  const sign = direction === 'asc' ? 1 : -1
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  return [...rows]
    .sort((a, b) => {
      const [va, vb] = [valueOf(a), valueOf(b)]
      if (nullsLast && (va === null) !== (vb === null)) return va === null ? 1 : -1
      return sign * compare(va, vb) || sign * compare(a.id, b.id)
    })
    .map((row) => row.id)
}

describe('GET /api/tickets without page: the old answer', () => {
  test('a plain array of every ticket, most urgent first, then newest', async () => {
    const res = await get('/api/tickets')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(35)
    const [rows] = await pool.query(
      'SELECT t.id FROM tickets t JOIN priorities p ON p.id = t.priority_id ORDER BY p.level DESC, t.created_at DESC, t.id DESC',
    )
    expect(res.body.map((t) => t.id)).toEqual(rows.map((r) => r.id))
    // The same fields as always (display names, a real boolean for is_overdue)
    expect(res.body[0]).toEqual(
      expect.objectContaining({ requester_name: expect.any(String), priority_name: expect.any(String) }),
    )
    expect(typeof res.body[0].is_overdue).toBe('boolean')
  })

  test('pageSize alone changes nothing; sort and order still apply', async () => {
    const plain = await get('/api/tickets')
    expect((await get('/api/tickets?pageSize=5')).body).toEqual(plain.body)
    const sorted = await get('/api/tickets?sort=title&order=asc')
    expect(Array.isArray(sorted.body)).toBe(true)
    expect(sorted.body.map((t) => t.id)).toEqual(expectedOrder(tickets, (t) => t.title, 'asc'))
  })

  test('an empty page (?page=) counts as not sent', async () => {
    const res = await get('/api/tickets?page=')
    expect(Array.isArray(res.body)).toBe(true)
  })
})

describe('GET /api/tickets with page', () => {
  test(`page 1 with the default pageSize (${DEFAULT_PAGE_SIZE}): { items, total, page, pageSize }`, async () => {
    const res = await get('/api/tickets?page=1')
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['items', 'page', 'pageSize', 'total'])
    expect(res.body).toMatchObject({ total: 35, page: 1, pageSize: DEFAULT_PAGE_SIZE })
    expect(res.body.items).toHaveLength(DEFAULT_PAGE_SIZE)
    // The rows are the same as in the plain array, in the same order
    const plain = await get('/api/tickets')
    expect(res.body.items).toEqual(plain.body.slice(0, DEFAULT_PAGE_SIZE))
  })

  test('later pages, the short last page, and a page past the end (empty, with the real total)', async () => {
    const plain = (await get('/api/tickets')).body
    const page2 = await get('/api/tickets?page=2&pageSize=10')
    expect(page2.body).toMatchObject({ total: 35, page: 2, pageSize: 10 })
    expect(page2.body.items).toEqual(plain.slice(10, 20))
    const last = await get('/api/tickets?page=4&pageSize=10')
    expect(last.body.items).toEqual(plain.slice(30))
    const past = await get('/api/tickets?page=9&pageSize=10')
    expect(past.status).toBe(200)
    expect(past.body).toEqual({ items: [], total: 35, page: 9, pageSize: 10 })
  })

  test(`pageSize from 1 to ${MAX_PAGE_SIZE}`, async () => {
    expect((await get('/api/tickets?page=1&pageSize=1')).body.items).toHaveLength(1)
    const max = await get(`/api/tickets?page=1&pageSize=${MAX_PAGE_SIZE}`)
    expect(max.body).toMatchObject({ total: 35, pageSize: MAX_PAGE_SIZE })
    expect(max.body.items).toHaveLength(35)
  })

  test('an employee pages through their own tickets only', async () => {
    const { ids, total } = await allPages('/api/tickets', callers.requester)
    expect(total).toBe(30)
    const own = tickets.filter((t) => t.requester_id === callers.requester.id).map((t) => t.id)
    expect([...ids].sort((a, b) => a - b)).toEqual([...own].sort((a, b) => a - b))
  })

  // total counts with the same filters as the list: it always equals the plain array's length for the same filters
  test.each([
    ['status', 'status=open'],
    ['priority', 'priority=PRIORITY'],
    ['search', 'q=printer'],
    ['assigned to me', 'assigned=me'],
    ['unassigned', 'assigned=unassigned'],
    ['overdue', 'overdue=1'],
    ['several at once', 'status=closed&q=Ticket&assigned=unassigned'],
    ['nothing matching', 'q=no-such-ticket'],
  ])('total with a filter: %s', async (_, filters) => {
    const [[high]] = await pool.query("SELECT id FROM priorities WHERE name = 'High'")
    const query = filters.replace('PRIORITY', high.id)
    const caller = callers.agent // staff: sees every ticket; "me" = the agent
    const plain = await get(`/api/tickets?${query}`, caller)
    const paged = await get(`/api/tickets?${query}&page=1&pageSize=5`, caller)
    expect(paged.body.total).toBe(plain.body.length)
    expect(paged.body.items).toEqual(plain.body.slice(0, 5))
    if (query !== 'q=no-such-ticket') expect(plain.body.length).toBeGreaterThan(0)
  })

  test('total for an employee with a filter counts only their own tickets', async () => {
    const plain = await get('/api/tickets?q=printer', callers.requester)
    const paged = await get('/api/tickets?q=printer&page=1', callers.requester)
    expect(paged.body.total).toBe(plain.body.length)
    expect(paged.body.total).toBe(
      tickets.filter((t) => t.requester_id === callers.requester.id && t.title.includes('printer')).length,
    )
  })
})

describe('sorting tickets', () => {
  const VALUE = {
    created_at: (t) => new Date(t.created_at).getTime(),
    updated_at: (t) => new Date(t.updated_at).getTime(),
    priority: (t) => t.priority_level,
    status: (t) => STATUSES.indexOf(t.status),
    title: (t) => t.title,
  }

  test('the allow-list is exactly these columns', () => {
    expect(Object.keys(TICKET_SORTS)).toEqual(Object.keys(VALUE))
  })

  test.each(
    Object.keys(VALUE).flatMap((sort) => [
      [sort, 'asc'],
      [sort, 'desc'],
    ]),
  )('sort=%s&order=%s, paged through', async (sort, order) => {
    const { ids, total } = await allPages(`/api/tickets?sort=${sort}&order=${order}`)
    expect(total).toBe(35)
    expect(ids).toEqual(expectedOrder(tickets, VALUE[sort], order))
  })

  test.each([
    ['created_at', 'desc'],
    ['updated_at', 'desc'],
    ['priority', 'desc'],
    ['status', 'asc'],
    ['title', 'asc'],
  ])('sort=%s without order goes %s', async (sort, order) => {
    const res = await get(`/api/tickets?sort=${sort}&page=1&pageSize=100`)
    expect(res.body.items.map((t) => t.id)).toEqual(expectedOrder(tickets, VALUE[sort], order))
  })

  test('sorting works together with a filter', async () => {
    const res = await get('/api/tickets?q=printer&sort=title&order=desc&page=1&pageSize=100')
    const printers = tickets.filter((t) => t.title.includes('printer'))
    expect(res.body.total).toBe(printers.length)
    expect(res.body.items.map((t) => t.id)).toEqual(expectedOrder(printers, VALUE.title, 'desc'))
  })
})

describe('bad paging and sorting values → 400', () => {
  test.each([
    ['page=0', 'page', 'page must be at least 1'],
    ['page=-1', 'page', 'page must be a whole number'],
    ['page=1.5', 'page', 'page must be a whole number'],
    ['page=abc', 'page', 'page must be a whole number'],
    ['page=1000001', 'page', 'page must be at most 1,000,000'],
    ['page=1&page=2', 'page', 'page must be a whole number'],
    ['page=1&pageSize=0', 'pageSize', 'pageSize must be at least 1'],
    [`page=1&pageSize=${MAX_PAGE_SIZE + 1}`, 'pageSize', `pageSize must be at most ${MAX_PAGE_SIZE}`],
    ['page=1&pageSize=ten', 'pageSize', 'pageSize must be a whole number'],
    ['sort=requester_id', 'sort', 'sort must be one of: created_at, updated_at, priority, status, title'],
    ['sort=title%3B%20DROP%20TABLE%20tickets', 'sort', expect.stringContaining('sort must be one of')],
    ['sort=p.level', 'sort', expect.stringContaining('sort must be one of')],
    ['sort=title&order=sideways', 'order', 'order must be asc or desc'],
    ['sort=title&order=ASC', 'order', 'order must be asc or desc'],
  ])('%s', async (query, field, message) => {
    const res = await get(`/api/tickets?${query}`)
    expect(res.status).toBe(400)
    expect(res.body.errors).toEqual(expect.arrayContaining([{ field, message }]))
    expect(res.body.message).toEqual(expect.any(String))
  })

  test('every bad value is listed', async () => {
    const res = await get('/api/tickets?page=0&pageSize=500&sort=nope&order=up')
    expect(res.status).toBe(400)
    expect(res.body.errors.map((e) => e.field).sort()).toEqual(['order', 'page', 'pageSize', 'sort'])
  })

  test('nothing is run with a bad sort: the tickets are all still there', async () => {
    await get('/api/tickets?sort=title;DELETE%20FROM%20tickets')
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM tickets')
    expect(n).toBe(35)
  })
})

describe('GET /api/users', () => {
  const VALUE = {
    name: (u) => u.name.toLowerCase(),
    email: (u) => u.email,
    role: (u) => u.role,
    department: (u) => u.department_name?.toLowerCase() ?? null,
    created_at: (u) => new Date(u.created_at).getTime(),
  }

  test('without page: the plain array, newest first, as before', async () => {
    const res = await get('/api/users')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.map((u) => u.id)).toEqual(expectedOrder(users, VALUE.created_at, 'desc'))
    expect(res.body[0]).not.toHaveProperty('password_hash')
    expect(typeof res.body[0].is_active).toBe('boolean')
  })

  test('with page: { items, total, page, pageSize }, the same rows as the plain array', async () => {
    const plain = (await get('/api/users')).body
    const res = await get('/api/users?page=2&pageSize=3')
    expect(res.body).toEqual({ items: plain.slice(3, 6), total: users.length, page: 2, pageSize: 3 })
    expect(res.body.items[0]).not.toHaveProperty('password_hash')
  })

  test('the allow-list is exactly these columns', () => {
    expect(Object.keys(USER_SORTS)).toEqual(Object.keys(VALUE))
  })

  test.each(
    Object.keys(VALUE).flatMap((sort) => [
      [sort, 'asc'],
      [sort, 'desc'],
    ]),
  )('sort=%s&order=%s, paged through', async (sort, order) => {
    const { ids, total } = await allPages(`/api/users?sort=${sort}&order=${order}`)
    expect(total).toBe(users.length)
    // Users without a department come last both ways
    expect(ids).toEqual(expectedOrder(users, VALUE[sort], order, { nullsLast: sort === 'department' }))
  })

  test('role sorts alphabetically, not in the ENUM order', async () => {
    const res = await get('/api/users?sort=role&order=asc')
    const roles = res.body.map((u) => u.role)
    expect([...new Set(roles)]).toEqual(['admin', 'agent', 'employee', 'hr'])
  })

  test('HR may page the list too', async () => {
    const res = await get('/api/users?page=1&sort=name', callers.hr)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(users.length)
  })

  test('an employee is refused (403) before the query is even checked', async () => {
    const res = await get('/api/users?page=0&sort=nope', callers.requester)
    expect(res.status).toBe(403)
  })

  test.each([
    ['page=0', 'page'],
    ['page=1&pageSize=101', 'pageSize'],
    ['sort=password_hash', 'sort'],
    ['sort=name&order=random', 'order'],
  ])('%s → 400', async (query, field) => {
    const res = await get(`/api/users?${query}`)
    expect(res.status).toBe(400)
    expect(res.body.errors.map((e) => e.field)).toContain(field)
  })
})
