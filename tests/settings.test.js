// Tests for the admin settings: /api/categories, /api/priorities and /api/settings (routes/settings.js, migration 015),
// and how tickets, /api/meta, emails and the cache follow them.
const pool = require('../src/db')
const reference = require('../scripts/reference-data')
const { api, resetData, restoreReferenceData, createUser, loginAs, auth, sentMail, useEmail } = require('./helpers')
const { MAX_TARGET_HOURS } = require('../src/schemas/settings')

let people

beforeAll(async () => {
  await resetData()
  people = {
    admin: await createUser({ role: 'admin', name: 'Ada Admin' }),
    hr: await createUser({ role: 'hr', name: 'Hana HR' }),
    agent: await createUser({ role: 'agent', name: 'Agon Agent' }),
    employee: await createUser({ role: 'employee', name: 'Era Employee' }),
  }
  for (const person of Object.values(people)) person.token = await loginAs(person)
})

beforeEach(restoreReferenceData)
// After every test too, so the next test file (same database) starts with the standard data and name
afterEach(restoreReferenceData)

const as = (who) => ({
  get: (path) => api.get(path).set(auth(people[who].token)),
  post: (path, body) => api.post(path).set(auth(people[who].token)).send(body),
  patch: (path, body) => api.patch(path).set(auth(people[who].token)).send(body),
  put: (path, body) => api.put(path).set(auth(people[who].token)).send(body),
  delete: (path) => api.delete(path).set(auth(people[who].token)),
})
const admin = as('admin')

const idOf = async (table, name) => (await pool.query(`SELECT id FROM ${table} WHERE name = ?`, [name]))[0][0].id
const category = (name) => idOf('categories', name)
const priority = (name) => idOf('priorities', name)

async function newTicket(who = 'employee', body = {}) {
  const res = await as(who).post('/api/tickets', {
    title: 'Printer offline',
    description: 'Floor 2',
    category_id: await category('Hardware'),
    ...body,
  })
  return res
}

describe('permissions', () => {
  // Every write, with a body that would be valid for an admin
  const writes = async () => [
    ['post', '/api/categories', { name: 'Facilities' }],
    ['patch', `/api/categories/${await category('Other')}`, { sort_order: 9 }],
    ['delete', `/api/categories/${await category('Other')}`],
    ['post', '/api/priorities', { name: 'Blocker', rank: 5, target_hours: 1 }],
    ['patch', `/api/priorities/${await priority('Low')}`, { target_hours: 100 }],
    ['put', '/api/priorities/order', { ids: [] }],
    ['delete', `/api/priorities/${await priority('Low')}`],
    ['patch', '/api/settings', { company_name: 'Acme' }],
    ['get', '/api/settings'],
  ]

  test.each(['hr', 'agent', 'employee'])('%s gets 403 on every write (and on GET /api/settings)', async (who) => {
    for (const [method, path, body] of await writes()) {
      const res = await as(who)[method](path, body)
      expect([method, path, res.status]).toEqual([method, path, 403])
    }
    // Nothing changed
    expect((await admin.get('/api/categories')).body.map((c) => c.name)).toEqual(reference.categories.map(([n]) => n))
  })

  test('no session → 401 everywhere except the public settings', async () => {
    for (const [method, path, body] of await writes()) {
      const res = await api[method](path).send(body)
      expect([method, path, res.status]).toEqual([method, path, 401])
    }
    for (const path of ['/api/categories', '/api/priorities']) expect((await api.get(path)).status).toBe(401)
    const res = await api.get('/api/settings/public')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ company_name: 'TicketFlow', email_enabled: false })
  })

  test.each(['hr', 'employee', 'agent'])('%s can read the lists', async (who) => {
    expect((await as(who).get('/api/categories')).status).toBe(200)
    expect((await as(who).get('/api/priorities')).status).toBe(200)
  })
})

describe('categories', () => {
  test('GET: the active ones by sort_order, then name; admins can ask for archived ones too and see ticket counts', async () => {
    await newTicket()
    await admin.patch(`/api/categories/${await category('Email')}`, { is_active: false })
    await admin.patch(`/api/categories/${await category('Other')}`, { sort_order: 0 })

    const employee = (await as('employee').get('/api/categories?include_inactive=1')).body
    expect(employee.map((c) => c.name)).toEqual(['Other', 'Hardware', 'Software', 'Network', 'Access'])
    expect(employee[0]).not.toHaveProperty('ticket_count')

    const all = (await admin.get('/api/categories?include_inactive=1')).body
    expect(all.map((c) => [c.name, c.is_active])).toEqual([
      ['Other', true],
      ['Hardware', true],
      ['Software', true],
      ['Network', true],
      ['Access', true],
      ['Email', false],
    ])
    expect(all.find((c) => c.name === 'Hardware').ticket_count).toBe(1)
    expect(all[0]).toEqual(
      expect.objectContaining({ id: expect.any(Number), description: expect.any(String), sort_order: 0 }),
    )
  })

  test('POST → 201, after the last one unless sort_order is given; the name is trimmed', async () => {
    const res = await admin.post('/api/categories', { name: '  Facilities ', description: 'Desks and rooms' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      name: 'Facilities',
      description: 'Desks and rooms',
      sort_order: 7,
      is_active: true,
    })
    const placed = await admin.post('/api/categories', { name: 'Security', sort_order: 3 })
    expect(placed.body.sort_order).toBe(3)
  })

  test.each([
    ['the same name', 'Hardware'],
    ['another letter case', 'hARDWARE'],
    ['spaces around it', ' Hardware '],
  ])('a taken name (%s) → 409 NAME_TAKEN', async (_, name) => {
    const res = await admin.post('/api/categories', { name })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'NAME_TAKEN', errors: [{ field: 'name' }] })
  })

  test.each([
    [{ name: '' }, 'name'],
    [{ name: 'x'.repeat(51) }, 'name'],
    [{}, 'name'],
    [{ name: 'Ok', colour: 'red' }, 'colour'],
    [{ name: 'Ok', sort_order: -1 }, 'sort_order'],
    [{ name: 'Ok', sort_order: 1.5 }, 'sort_order'],
  ])('bad body %j → 400 for %s', async (body, field) => {
    const res = await admin.post('/api/categories', body)
    expect(res.status).toBe(400)
    expect(res.body.errors.map((e) => e.field)).toContain(field)
  })

  test('PATCH changes only what is sent; a taken name → 409; unknown id → 404; empty body → 400', async () => {
    const id = await category('Other')
    const res = await admin.patch(`/api/categories/${id}`, { name: 'Misc', sort_order: 10 })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id, name: 'Misc', sort_order: 10, description: expect.any(String) })
    expect((await admin.patch(`/api/categories/${id}`, { name: 'network' })).body.code).toBe('NAME_TAKEN')
    // Renaming to its own name in another case is fine
    expect((await admin.patch(`/api/categories/${id}`, { name: 'MISC' })).status).toBe(200)
    expect((await admin.patch('/api/categories/9999', { name: 'X' })).status).toBe(404)
    expect((await admin.patch(`/api/categories/${id}`, {})).status).toBe(400)
  })

  test('DELETE: unused → 204; used → 409 CATEGORY_IN_USE with the count (and it stays)', async () => {
    expect((await admin.delete(`/api/categories/${await category('Other')}`)).status).toBe(204)
    await newTicket()
    await newTicket()
    const res = await admin.delete(`/api/categories/${await category('Hardware')}`)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'CATEGORY_IN_USE', ticket_count: 2 })
    expect(res.body.message).toMatch(/Archive it instead/)
    expect((await admin.get('/api/categories')).body.map((c) => c.name)).toContain('Hardware')
    expect((await admin.delete('/api/categories/9999')).status).toBe(404)
  })

  test('archived: refused for new tickets (422), but old tickets keep it and still show its name', async () => {
    const old = (await newTicket()).body
    await admin.patch(`/api/categories/${await category('Hardware')}`, { is_active: false })
    const res = await newTicket()
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ code: 'CATEGORY_INACTIVE', errors: [{ field: 'category_id' }] })
    const shown = await as('employee').get(`/api/tickets/${old.id}`)
    expect(shown.body).toMatchObject({ category_id: old.category_id, category_name: 'Hardware' })
    // Restoring it makes it usable again
    await admin.patch(`/api/categories/${await category('Hardware')}`, { is_active: true })
    expect((await newTicket()).status).toBe(201)
  })
})

describe('priorities', () => {
  const ranks = async () => (await admin.get('/api/priorities?include_inactive=1')).body.map((p) => [p.name, p.rank])

  test('GET: by rank, least urgent first, with target_hours and is_default', async () => {
    const res = await as('employee').get('/api/priorities')
    expect(
      res.body.map(({ name, rank, target_hours: hours, is_default: isDefault }) => [name, rank, hours, isDefault]),
    ).toEqual([
      ['Low', 1, 120, false],
      ['Medium', 2, 72, true],
      ['High', 3, 24, false],
      ['Critical', 4, 4, false],
    ])
  })

  test('POST → 201; taken name or rank → 409; is_default moves the default', async () => {
    const res = await admin.post('/api/priorities', { name: 'Blocker', rank: 5, target_hours: 1, is_default: true })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ name: 'Blocker', rank: 5, target_hours: 1, is_default: true, is_active: true })
    const defaults = (await admin.get('/api/priorities')).body.filter((p) => p.is_default)
    expect(defaults.map((p) => p.name)).toEqual(['Blocker'])

    expect((await admin.post('/api/priorities', { name: 'blocker', rank: 6, target_hours: 1 })).body.code).toBe(
      'NAME_TAKEN',
    )
    const rankTaken = await admin.post('/api/priorities', { name: 'Other', rank: 2, target_hours: 1 })
    expect(rankTaken.status).toBe(409)
    expect(rankTaken.body).toMatchObject({ code: 'RANK_TAKEN', errors: [{ field: 'rank' }] })
  })

  test.each([0, MAX_TARGET_HOURS + 1, 1.5, '24', null])('target_hours %j → 400', async (hours) => {
    const created = await admin.post('/api/priorities', { name: 'Odd', rank: 9, target_hours: hours })
    expect(created.status).toBe(400)
    expect(created.body.errors.map((e) => e.field)).toEqual(['target_hours'])
    const changed = await admin.patch(`/api/priorities/${await priority('Low')}`, { target_hours: hours })
    expect(changed.status).toBe(400)
  })

  test(`target_hours 1 and ${MAX_TARGET_HOURS} are fine`, async () => {
    const id = await priority('Low')
    expect((await admin.patch(`/api/priorities/${id}`, { target_hours: 1 })).body.target_hours).toBe(1)
    expect((await admin.patch(`/api/priorities/${id}`, { target_hours: MAX_TARGET_HOURS })).body.target_hours).toBe(
      MAX_TARGET_HOURS,
    )
  })

  test('PATCH is_default: exactly one default afterwards; unsetting the default directly → 409', async () => {
    const res = await admin.patch(`/api/priorities/${await priority('High')}`, { is_default: true })
    expect(res.body.is_default).toBe(true)
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM priorities WHERE is_default')
    expect(n).toBe(1)
    const unset = await admin.patch(`/api/priorities/${await priority('High')}`, { is_default: false })
    expect(unset.status).toBe(409)
    expect(unset.body.code).toBe('PRIORITY_IS_DEFAULT')
  })

  // The default is always active, so the last active priority is always the default: that rule answers (409)
  test("the default can't be archived, so the last active priority can't be either", async () => {
    const archiveDefault = await admin.patch(`/api/priorities/${await priority('Medium')}`, { is_active: false })
    expect(archiveDefault.status).toBe(409)
    expect(archiveDefault.body.code).toBe('PRIORITY_IS_DEFAULT')

    for (const name of ['Low', 'High', 'Critical']) {
      expect((await admin.patch(`/api/priorities/${await priority(name)}`, { is_active: false })).status).toBe(200)
    }
    const last = await admin.patch(`/api/priorities/${await priority('Medium')}`, { is_active: false })
    expect(last.status).toBe(409)
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM priorities WHERE is_active')
    expect(n).toBe(1)
    // Archived ones are left out of the list, unless an admin asks
    expect((await as('employee').get('/api/priorities')).body.map((p) => p.name)).toEqual(['Medium'])
    expect((await admin.get('/api/priorities?include_inactive=1')).body).toHaveLength(4)
  })

  test("making an archived priority the default isn't allowed unless it's made active too", async () => {
    await admin.patch(`/api/priorities/${await priority('Low')}`, { is_active: false })
    const res = await admin.patch(`/api/priorities/${await priority('Low')}`, { is_default: true })
    expect(res.status).toBe(409)
    const both = await admin.patch(`/api/priorities/${await priority('Low')}`, { is_default: true, is_active: true })
    expect(both.body).toMatchObject({ is_default: true, is_active: true })
  })

  test('DELETE: the default → 409; in use → 409 PRIORITY_IN_USE; unused → 204', async () => {
    const def = await admin.delete(`/api/priorities/${await priority('Medium')}`)
    expect(def.status).toBe(409)
    expect(def.body.code).toBe('PRIORITY_IS_DEFAULT')
    await newTicket('employee', { priority_id: await priority('High') })
    const used = await admin.delete(`/api/priorities/${await priority('High')}`)
    expect(used.body).toMatchObject({ code: 'PRIORITY_IN_USE', ticket_count: 1 })
    expect((await admin.delete(`/api/priorities/${await priority('Low')}`)).status).toBe(204)
    expect(await ranks()).toEqual([
      ['Medium', 2],
      ['High', 3],
      ['Critical', 4],
    ])
  })

  test('PUT /order: ranks become 1..n in the given order', async () => {
    const ids = await Promise.all(['Critical', 'Low', 'High', 'Medium'].map(priority))
    const res = await admin.put('/api/priorities/order', { ids })
    expect(res.status).toBe(200)
    expect(res.body.map((p) => [p.name, p.rank])).toEqual([
      ['Critical', 1],
      ['Low', 2],
      ['High', 3],
      ['Medium', 4],
    ])
  })

  test.each([
    ['one missing', (ids) => ids.slice(1)],
    ['one twice', (ids) => [...ids.slice(1), ids[1]]],
    ['an unknown id', (ids) => [...ids.slice(1), 9999]],
    ['an extra id', (ids) => [...ids, 9999]],
  ])('PUT /order with %s → 422, nothing changed', async (_, change) => {
    const ids = await Promise.all(['Low', 'Medium', 'High', 'Critical'].map(priority))
    const res = await admin.put('/api/priorities/order', { ids: change(ids) })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('INVALID_ORDER')
    expect(await ranks()).toEqual([
      ['Low', 1],
      ['Medium', 2],
      ['High', 3],
      ['Critical', 4],
    ])
  })

  test('the ticket list sorts by rank, also after a reorder', async () => {
    for (const name of ['Low', 'Critical', 'Medium']) {
      await newTicket('employee', { title: name, priority_id: await priority(name) })
    }
    const titles = async () => (await admin.get('/api/tickets')).body.map((t) => t.title)
    expect(await titles()).toEqual(['Critical', 'Medium', 'Low']) // most urgent first
    await admin.put('/api/priorities/order', {
      ids: await Promise.all(['Critical', 'High', 'Medium', 'Low'].map(priority)),
    })
    expect(await titles()).toEqual(['Low', 'Medium', 'Critical'])
  })

  test('archived: refused for new tickets and for changing a ticket to it (422); old tickets keep it', async () => {
    const old = (await newTicket('employee', { priority_id: await priority('High') })).body
    await admin.patch(`/api/priorities/${await priority('High')}`, { is_active: false })

    const res = await newTicket('employee', { priority_id: await priority('High') })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('PRIORITY_INACTIVE')
    const other = (await newTicket('employee', { priority_id: await priority('Low') })).body
    const change = await as('agent').patch(`/api/tickets/${other.id}/priority`, { priority_id: await priority('High') })
    expect(change.status).toBe(422)
    // The old ticket still shows it, and saving its own priority again is fine
    expect((await as('agent').get(`/api/tickets/${old.id}`)).body.priority_name).toBe('High')
    const same = await as('agent').patch(`/api/tickets/${old.id}/priority`, { priority_id: await priority('High') })
    expect(same.status).toBe(200)
  })

  test('a new ticket without a priority gets the default', async () => {
    const res = await newTicket()
    expect(res.status).toBe(201)
    expect(res.body.priority_name).toBe('Medium')
    await admin.patch(`/api/priorities/${await priority('Critical')}`, { is_default: true })
    expect((await newTicket()).body.priority_name).toBe('Critical')
  })
})

describe('company settings', () => {
  test('PATCH (trimmed) → shown in GET /api/settings and in the public settings', async () => {
    const res = await admin.patch('/api/settings', { company_name: '  Acme Corp  ' })
    expect(res.status).toBe(200)
    const expected = {
      company_name: 'Acme Corp',
      auto_close_days: 7,
      escalation_enabled: true,
      escalation_unassigned_minutes: 120,
    }
    expect(res.body).toEqual(expected)
    expect((await admin.get('/api/settings')).body).toEqual(expected)
    expect((await api.get('/api/settings/public')).body).toEqual({ company_name: 'Acme Corp', email_enabled: false })
  })

  test.each([
    [{ company_name: '' }],
    [{ company_name: '   ' }],
    [{ company_name: 'x'.repeat(101) }],
    [{}],
    [{ company_name: 'A', logo: 'x' }],
  ])('bad body %j → 400', async (body) => {
    expect((await admin.patch('/api/settings', body)).status).toBe(400)
  })

  test('100 characters are fine', async () => {
    expect((await admin.patch('/api/settings', { company_name: 'x'.repeat(100) })).status).toBe(200)
  })

  test('emails use the company name in the subject, header and footer', async () => {
    useEmail(true)
    try {
      await admin.patch('/api/settings', { company_name: 'Acme Corp' })
      await newTicket()
      const mail = (await sentMail()).find((m) => m.to === people.agent.email)
      expect(mail.subject).toMatch(/^\[Acme Corp #\d+\] New ticket: Printer offline$/)
      expect(mail.html).toContain('>Acme Corp</td>')
      expect(mail.text).toContain('This is an automatic message from Acme Corp.')
      expect(`${mail.subject}${mail.text}${mail.html}`).not.toContain('TicketFlow')
      // MAIL_FROM stays as configured
      expect(mail.from).toContain('no-reply@test.invalid')
    } finally {
      useEmail(false)
    }
  })

  test('email_enabled follows the email settings', async () => {
    useEmail(true)
    try {
      expect((await api.get('/api/settings/public')).body.email_enabled).toBe(true)
    } finally {
      useEmail(false)
    }
  })
})

describe('tickets and /api/meta', () => {
  test('ticket responses keep their fields (as on main), with category_id and priority_id', async () => {
    await newTicket()
    const [ticket] = (await as('employee').get('/api/tickets')).body
    expect(Object.keys(ticket).sort()).toEqual(
      [
        'assigned_to',
        'assignee_name',
        'category_id',
        'category_name',
        'closed_at',
        'created_at',
        'description',
        'id',
        'is_overdue',
        'priority_id',
        'priority_level',
        'priority_name',
        'requester_id',
        'requester_name',
        'resolution',
        'resolved_at',
        'status',
        'target_hours',
        'title',
        'updated_at',
      ].sort(),
    )
    expect(ticket).toMatchObject({ category_name: 'Hardware', priority_name: 'Medium', priority_level: 2 })
  })

  test('/api/meta lists archived ones too (is_active), priorities with rank, level and is_default; ticket_count for admins only', async () => {
    await newTicket()
    await admin.patch(`/api/categories/${await category('Email')}`, { is_active: false })
    const meta = (await as('employee').get('/api/meta')).body
    expect(meta.categories.find((c) => c.name === 'Email')).toMatchObject({ is_active: false })
    expect(meta.categories[0]).not.toHaveProperty('ticket_count')
    expect(meta.priorities.find((p) => p.name === 'Medium')).toMatchObject({ level: 2, rank: 2, is_default: true })
    const adminMeta = (await admin.get('/api/meta')).body
    expect(adminMeta.categories.find((c) => c.name === 'Hardware').ticket_count).toBe(1)
  })
})

describe('cache', () => {
  test('reads come from memory until a write clears it', async () => {
    const names = async () => (await admin.get('/api/categories')).body.map((c) => c.name)
    expect(await names()).toContain('Other')
    // Changed behind the API's back: still the cached list
    await pool.query("UPDATE categories SET name = 'Renamed directly' WHERE name = 'Other'")
    expect(await names()).toContain('Other')
    // Any write clears it: the next read sees the database as it is
    await admin.patch(`/api/categories/${await category('Email')}`, { sort_order: 5 })
    expect(await names()).toContain('Renamed directly')
  })

  test('the company name too', async () => {
    expect((await api.get('/api/settings/public')).body.company_name).toBe('TicketFlow')
    await pool.query("UPDATE settings SET setting_value = 'Behind the back' WHERE setting_key = 'company_name'")
    expect((await api.get('/api/settings/public')).body.company_name).toBe('TicketFlow')
    await admin.patch('/api/settings', { company_name: 'Through the API' })
    expect((await api.get('/api/settings/public')).body.company_name).toBe('Through the API')
  })
})
