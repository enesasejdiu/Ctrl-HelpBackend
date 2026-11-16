// Paging edge cases that need their own data, on top of tests/pagination.test.js (which pages a fixed set of 35
// tickets and 7 users through every sort): 60 rows that tie on everything but the id, priority order after an admin
// reorders the priorities, injection-style values on both lists, total under filters and permissions for every role,
// and rows that are deactivated or deleted between two pages.
const pool = require('../src/db')
const { api, resetData, createUser, auth } = require('./helpers')
const { assertThrowawayDb } = require('./support/guard')
const { oneOfEachRole, createTicket } = require('./support/factories')
const { TICKET_SORTS, USER_SORTS, DEFAULT_PAGE_SIZE } = require('../src/pagination')

let people
const get = (path, who = people.admin) => api.get(path).set(auth(who.token))

beforeAll(assertThrowawayDb)
beforeEach(async () => {
  await resetData()
  people = await oneOfEachRole()
})

// Every page of `path` at `pageSize`, as ids, and the totals each page reported
async function pageThrough(path, pageSize, who) {
  const ids = []
  const totals = new Set()
  for (let page = 1; page < 100; page += 1) {
    const res = await get(`${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=${pageSize}`, who)
    expect(res.status).toBe(200)
    expect(res.body.page).toBe(page)
    expect(res.body.pageSize).toBe(pageSize)
    totals.add(res.body.total)
    ids.push(...res.body.items.map((row) => row.id))
    if (res.body.items.length < pageSize) break
  }
  return { ids, totals: [...totals] }
}

const tableCounts = async () => {
  const counts = {}
  for (const table of ['tickets', 'users', 'priorities', 'categories', 'comments']) {
    ;[[{ n: counts[table] }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`)
  }
  return counts
}

describe('defaults', () => {
  test(`?page=1 alone: page 1, pageSize ${DEFAULT_PAGE_SIZE}, newest first; users by name`, async () => {
    for (let i = 0; i < 30; i += 1) {
      await createTicket({ requester: people.employee, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) })
    }
    const tickets = await get('/api/tickets?page=1')
    expect(tickets.body).toMatchObject({ page: 1, pageSize: DEFAULT_PAGE_SIZE, total: 30 })
    expect(tickets.body.items).toHaveLength(DEFAULT_PAGE_SIZE)
    const created = tickets.body.items.map((t) => new Date(t.created_at).getTime())
    expect(created).toEqual([...created].sort((a, b) => b - a))

    const users = await get('/api/users?page=1')
    expect(users.body).toMatchObject({ page: 1, pageSize: DEFAULT_PAGE_SIZE, total: 4 })
    const names = users.body.items.map((u) => u.name.toLowerCase())
    expect(names).toEqual([...names].sort())
  })
})

describe('60 rows that tie on the sort value: the id breaks the tie', () => {
  test.each(Object.keys(TICKET_SORTS).flatMap((sort) => ['asc', 'desc'].map((order) => [sort, order])))(
    'tickets sort=%s&order=%s: pages of 25 (25 + 25 + 10) show every row once, in id order',
    async (sort, order) => {
      const at = new Date(Date.UTC(2026, 2, 1, 9))
      for (let i = 0; i < 60; i += 1) {
        await createTicket({ requester: people.employee, title: 'Same title', status: 'open', createdAt: at })
      }
      await pool.query('UPDATE tickets SET updated_at = ?', [at])
      const [rows] = await pool.query('SELECT id FROM tickets ORDER BY id')
      const expected = rows.map((r) => r.id)
      if (order === 'desc') expected.reverse()

      const { ids, totals } = await pageThrough(`/api/tickets?sort=${sort}&order=${order}`, 25)
      expect(totals).toEqual([60])
      expect(ids).toEqual(expected)
    },
  )

  test.each(Object.keys(USER_SORTS).flatMap((sort) => ['asc', 'desc'].map((order) => [sort, order])))(
    'users sort=%s&order=%s: 60 people with the same name, role, department and dates',
    async (sort, order) => {
      await pool.query('DELETE FROM sessions')
      await pool.query('DELETE FROM users')
      const admin = await createUser({ role: 'admin', name: 'Same Person', email: 'same.0@test.local' })
      admin.token = await require('./helpers').loginAs(admin)
      for (let i = 1; i < 60; i += 1) {
        await createUser({ role: 'admin', name: 'Same Person', email: `same.${String(i).padStart(2, '0')}@test.local` })
      }
      const at = new Date(Date.UTC(2026, 2, 1, 9))
      await pool.query('UPDATE users SET created_at = ?, last_login_at = ?', [at, at])
      const [rows] = await pool.query('SELECT id, email FROM users ORDER BY id')
      let expected
      if (sort === 'email') {
        expected = [...rows].sort((a, b) => a.email.localeCompare(b.email)).map((r) => r.id)
      } else {
        expected = rows.map((r) => r.id)
      }
      if (order === 'desc') expected.reverse()

      const { ids, totals } = await pageThrough(`/api/users?sort=${sort}&order=${order}`, 25, admin)
      expect(totals).toEqual([60])
      expect(ids).toEqual(expected)
    },
  )
})

describe('priority sorts by rank, and follows a reorder', () => {
  test('after PUT /api/priorities/order reverses the ranks, sort=priority reverses too', async () => {
    const [priorities] = await pool.query('SELECT id, name, level FROM priorities ORDER BY level')
    for (const priority of priorities) {
      await createTicket({ requester: people.employee, priorityLevel: priority.level, title: priority.name })
    }
    const before = await get('/api/tickets?sort=priority&order=desc&page=1')
    expect(before.body.items.map((t) => t.priority_name)).toEqual(priorities.map((p) => p.name).reverse())

    // The ids in rank order, lowest first (rank 1, 2, ...): the old order reversed
    const reorder = await api
      .put('/api/priorities/order')
      .set(auth(people.admin.token))
      .send({ ids: priorities.map((p) => p.id).reverse() })
    expect(reorder.status).toBe(200)
    const [after] = await pool.query('SELECT id, name, level FROM priorities ORDER BY level')
    const desc = await get('/api/tickets?sort=priority&order=desc&page=1')
    expect(desc.body.items.map((t) => t.priority_name)).toEqual(after.map((p) => p.name).reverse())
    const asc = await get('/api/tickets?sort=priority&order=asc&page=1')
    expect(asc.body.items.map((t) => t.priority_name)).toEqual(after.map((p) => p.name))
    // The reorder really changed the ranks (so this test can't pass by accident)
    expect(after.map((p) => p.id)).not.toEqual(priorities.map((p) => p.id))
  })
})

describe('injection-style values → 400, and every table is intact', () => {
  const TICKET_VALUES = [
    'sort=created_at%20DESC%3B%20DROP%20TABLE%20tickets',
    'sort=(SELECT%20SLEEP(5))',
    'sort=created_at)--',
    "sort=title'",
    'sort=__proto__',
    'sort=constructor',
    'sort=toString',
    'sort=title&sort=priority',
    'order=desc%3B%20DELETE%20FROM%20users',
    "order=asc'%20OR%20'1'='1",
    'page=1%3B%20DROP%20TABLE%20users',
    'page=1%20OR%201%3D1',
    'page=0x10',
    'page=1e3',
    'page=%2B1',
    'page=%20',
    'pageSize=10%20UNION%20SELECT%20password_hash%20FROM%20users',
    'page=1&pageSize=-1',
    'page=1&pageSize=9999999999999999999999',
    'page=99999999999999999999',
  ]

  test.each(TICKET_VALUES)('GET /api/tickets?%s', async (query) => {
    const before = await tableCounts()
    const res = await get(`/api/tickets?${query}`)
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).not.toMatch(/sql|mysql|syntax|ER_/i)
    expect(await tableCounts()).toEqual(before)
  })

  test.each(TICKET_VALUES.map((q) => q.replace(/title|created_at|priority/g, 'name')))(
    'GET /api/users?%s',
    async (query) => {
      const before = await tableCounts()
      const res = await get(`/api/users?${query}`)
      expect(res.status).toBe(400)
      expect(JSON.stringify(res.body)).not.toMatch(/password_hash|\$2[aby]\$/)
      expect(await tableCounts()).toEqual(before)
    },
  )

  // Express 5's simple query parser keeps "sort[]" as its own (unknown) name, which the schema drops: the list
  // answers as if no sort was sent, and nothing reaches SQL
  test.each(['/api/tickets?sort[]=title&page=1', '/api/users?sort[]=name&page=1'])('%s is ignored', async (path) => {
    const before = await tableCounts()
    const res = await get(path)
    expect(res.status).toBe(200)
    expect(res.body.page).toBe(1)
    expect(await tableCounts()).toEqual(before)
  })

  test('sort=password_hash on users is refused, never used to order (or leak) anything', async () => {
    const res = await get('/api/users?sort=password_hash&page=1')
    expect(res.status).toBe(400)
  })
})

describe('total, filters and permissions', () => {
  // The same total and rows as the plain array with the same filters, for every role that may see the list
  test.each([
    ['', 'admin'],
    ['status=open', 'admin'],
    ['assigned=me', 'agent'],
    ['assigned=unassigned', 'agent'],
    ['q=printer', 'employee'],
    ['status=resolved&q=printer', 'employee'],
    ['', 'hr'],
  ])('?%s as %s', async (filter, role) => {
    const other = await createUser()
    for (let i = 0; i < 40; i += 1) {
      await createTicket({
        requester: i % 3 === 0 ? people.employee : i % 3 === 1 ? people.hr : other,
        assignee: i % 4 === 0 ? people.agent : null,
        title: i % 2 ? `Printer ${i}` : `Laptop ${i}`,
        status: ['open', 'resolved', 'assigned'][i % 3],
      })
    }
    const plain = await get(`/api/tickets?${filter}`, people[role])
    expect(plain.status).toBe(200)
    const sep = filter ? `${filter}&` : ''
    const paged = await pageThrough(`/api/tickets?${sep}sort=title`, 7, people[role])
    expect(paged.totals).toEqual([plain.body.length])
    expect([...paged.ids].sort((a, b) => a - b)).toEqual(plain.body.map((t) => t.id).sort((a, b) => a - b))
    if (role === 'employee' || role === 'hr') {
      const [mine] = await pool.query('SELECT id FROM tickets WHERE requester_id = ?', [people[role].id])
      const allowed = new Set(mine.map((t) => t.id))
      expect(paged.ids.every((id) => allowed.has(id))).toBe(true)
    }
  })

  test('a page past the end of a filtered list: no items, the real total', async () => {
    for (let i = 0; i < 5; i += 1) await createTicket({ requester: people.employee, status: 'open' })
    const last = await get('/api/tickets?status=open&page=3&pageSize=2')
    expect(last.body.items).toHaveLength(1)
    const res = await get('/api/tickets?status=open&page=4&pageSize=2')
    expect(res.body).toEqual({ items: [], total: 5, page: 4, pageSize: 2 })
    const far = await get('/api/tickets?status=open&page=1000000&pageSize=100')
    expect(far.body).toEqual({ items: [], total: 5, page: 1000000, pageSize: 100 })
  })
})

describe('backward compatibility', () => {
  test('without page both lists are plain arrays of every row, even past 100 rows', async () => {
    for (let i = 0; i < 110; i += 1) await createTicket({ requester: people.employee })
    const tickets = await get('/api/tickets?pageSize=5')
    expect(Array.isArray(tickets.body)).toBe(true)
    expect(tickets.body).toHaveLength(110)
    const users = await get('/api/users?pageSize=1&sort=email')
    expect(Array.isArray(users.body)).toBe(true)
    expect(users.body).toHaveLength(4)
  })
})

describe('deactivated and deleted rows', () => {
  test('a deactivated user stays in the user list (is_active false) and in its total', async () => {
    for (let i = 0; i < 6; i += 1) await createUser({ name: `Extra ${i}` })
    const before = await get('/api/users?page=1&pageSize=5')
    const res = await api
      .patch(`/api/users/${people.employee.id}`)
      .set(auth(people.admin.token))
      .send({ is_active: false })
    expect(res.status).toBe(200)
    const { ids, totals } = await pageThrough('/api/users?sort=name', 5)
    expect(totals).toEqual([before.body.total])
    expect(new Set(ids).size).toBe(before.body.total)
    const plain = await get('/api/users')
    expect(plain.body.find((u) => u.id === people.employee.id).is_active).toBe(false)
  })

  test('tickets of a deactivated requester are still listed and counted', async () => {
    for (let i = 0; i < 3; i += 1) await createTicket({ requester: people.employee })
    await pool.query('UPDATE users SET is_active = FALSE WHERE id = ?', [people.employee.id])
    const res = await get('/api/tickets?page=1')
    expect(res.body.total).toBe(3)
  })

  test('a ticket deleted between two pages lowers the total; the next page has no duplicate', async () => {
    for (let i = 0; i < 12; i += 1)
      await createTicket({ requester: people.employee, title: `T${String(i).padStart(2, '0')}` })
    const first = await get('/api/tickets?sort=title&order=asc&page=1&pageSize=5')
    await pool.query('DELETE FROM tickets WHERE id = ?', [first.body.items[0].id])
    const second = await get('/api/tickets?sort=title&order=asc&page=2&pageSize=5')
    expect(first.body.total).toBe(12)
    expect(second.body.total).toBe(11)
    const firstIds = new Set(first.body.items.map((t) => t.id))
    expect(second.body.items.some((t) => firstIds.has(t.id))).toBe(false)
    const deleted = await get(`/api/tickets/${first.body.items[0].id}`)
    expect(deleted.status).toBe(404)
  })
})
