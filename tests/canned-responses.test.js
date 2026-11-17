// /api/canned-responses (routes/cannedResponses.js, migration 022): staff only; shared responses for all staff, changed
// by admins; personal ones seen and changed only by their owner (404 for anyone else); titles unique per scope; search;
// most used first; the usage counter; validation (422); audit entries for shared responses only.
const pool = require('../src/db')
const { api, resetData, createUser, loginAs, auth } = require('./helpers')

let users
let as

beforeEach(async () => {
  await resetData()
  users = {
    admin: await createUser({ role: 'admin', name: 'Ada Admin' }),
    agent: await createUser({ role: 'agent', name: 'Arben Agent' }),
    agent2: await createUser({ role: 'agent', name: 'Drita Agent' }),
    employee: await createUser({ role: 'employee', name: 'Liridon Employee' }),
    hr: await createUser({ role: 'hr', name: 'Teuta HR' }),
  }
  const sessions = {}
  for (const [key, user] of Object.entries(users)) sessions[key] = await loginAs(user)
  as = (who) => ({
    get: (url) => api.get(url).set(auth(sessions[who])),
    post: (url, body) => api.post(url).set(auth(sessions[who])).send(body),
    patch: (url, body) => api.patch(url).set(auth(sessions[who])).send(body),
    delete: (url) => api.delete(url).set(auth(sessions[who])),
  })
})

// Creates a response as `who` (shared: admin only); returns it
async function create(who, fields) {
  const res = await as(who).post('/api/canned-responses', { body: 'Some text.', ...fields })
  expect(res.status).toBe(201)
  return res.body
}

const titles = (res) => res.body.map((r) => r.title)
const auditRows = async () =>
  (await pool.query("SELECT action, actor_id, details FROM audit_log WHERE action LIKE 'canned.%' ORDER BY id"))[0].map(
    (row) => ({ ...row, details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details }),
  )

describe('staff only', () => {
  test.each(['employee', 'hr'])('%s gets 403 on every endpoint, and nothing changes', async (who) => {
    const shared = await create('admin', { title: 'Shared one', shared: true })
    for (const res of [
      await as(who).get('/api/canned-responses'),
      await as(who).post('/api/canned-responses', { title: 'Mine', body: 'x' }),
      await as(who).patch(`/api/canned-responses/${shared.id}`, { title: 'Changed' }),
      await as(who).delete(`/api/canned-responses/${shared.id}`),
      await as(who).post(`/api/canned-responses/${shared.id}/used`),
    ]) {
      expect(res.status).toBe(403)
    }
    const [[row]] = await pool.query('SELECT title, usage_count FROM canned_responses WHERE id = ?', [shared.id])
    expect(row).toEqual({ title: 'Shared one', usage_count: 0 })
  })

  test('not logged in → 401', async () => {
    expect((await api.get('/api/canned-responses')).status).toBe(401)
  })
})

describe('listing', () => {
  beforeEach(async () => {
    await create('admin', { title: 'Shared greeting', body: 'Hello from IT.', shared: true })
    await create('agent', { title: 'My printer reply', body: 'Restart the printer.' })
    await create('agent2', { title: "Drita's secret reply", body: 'Only Drita.' })
  })

  test("default (all): the shared ones and my own, never anyone else's personal ones", async () => {
    const res = await as('agent').get('/api/canned-responses')
    expect(res.status).toBe(200)
    expect(titles(res).sort()).toEqual(['My printer reply', 'Shared greeting'])
    expect(titles(await as('agent2').get('/api/canned-responses')).sort()).toEqual([
      "Drita's secret reply",
      'Shared greeting',
    ])
    // Not even admins see other people's personal responses
    expect(titles(await as('admin').get('/api/canned-responses'))).toEqual(['Shared greeting'])
  })

  test('scope=shared and scope=mine', async () => {
    expect(titles(await as('agent').get('/api/canned-responses?scope=shared'))).toEqual(['Shared greeting'])
    expect(titles(await as('agent').get('/api/canned-responses?scope=mine'))).toEqual(['My printer reply'])
  })

  test('fields, and can_edit: own personal yes; shared only for admins', async () => {
    const res = await as('agent').get('/api/canned-responses')
    const mine = res.body.find((r) => r.title === 'My printer reply')
    expect(mine).toEqual({
      id: expect.any(Number),
      title: 'My printer reply',
      body: 'Restart the printer.',
      shared: false,
      owner_id: users.agent.id,
      usage_count: 0,
      last_used_at: null,
      created_at: expect.any(String),
      updated_at: expect.any(String),
      updated_by: { id: users.agent.id, name: 'Arben Agent' },
      can_edit: true,
    })
    expect(res.body.find((r) => r.title === 'Shared greeting')).toMatchObject({
      shared: true,
      owner_id: null,
      can_edit: false,
    })
    expect((await as('admin').get('/api/canned-responses')).body[0]).toMatchObject({ shared: true, can_edit: true })
  })

  test('q searches the title and the text, ignoring case; % and _ are taken literally', async () => {
    expect(titles(await as('agent').get('/api/canned-responses?q=PRINTER'))).toEqual(['My printer reply'])
    expect(titles(await as('agent').get('/api/canned-responses?q=from%20it'))).toEqual(['Shared greeting'])
    expect(titles(await as('agent').get('/api/canned-responses?q=only%20drita'))).toEqual([])
    await create('agent', { title: '100% sure', body: 'Yes.' })
    expect(titles(await as('agent').get('/api/canned-responses?q=0%25'))).toEqual(['100% sure'])
  })

  test('most used first, then by title; at most 50', async () => {
    const often = await create('agent', { title: 'Zebra reply' })
    for (let i = 0; i < 3; i += 1) await as('agent').post(`/api/canned-responses/${often.id}/used`)
    expect(titles(await as('agent').get('/api/canned-responses'))).toEqual([
      'Zebra reply',
      'My printer reply',
      'Shared greeting',
    ])
    for (let i = 0; i < 52; i += 1) await create('agent', { title: `Bulk ${String(i).padStart(2, '0')}` })
    expect((await as('agent').get('/api/canned-responses')).body).toHaveLength(50)
  })

  test('a bad scope or a long q → 422', async () => {
    expect((await as('agent').get('/api/canned-responses?scope=everyone')).status).toBe(422)
    expect((await as('agent').get(`/api/canned-responses?q=${'x'.repeat(101)}`)).status).toBe(422)
  })
})

describe('creating', () => {
  test('a personal one belongs to the creator; nothing in the audit log', async () => {
    const res = await as('agent').post('/api/canned-responses', { title: '  Greeting  ', body: 'Hello,\n\nthanks.' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      title: 'Greeting',
      body: 'Hello,\n\nthanks.',
      shared: false,
      owner_id: users.agent.id,
    })
    expect(await auditRows()).toEqual([])
  })

  test("shared: admins only (an agent gets 403); an admin's is audited", async () => {
    const refused = await as('agent').post('/api/canned-responses', { title: 'For all', body: 'x', shared: true })
    expect(refused.status).toBe(403)
    expect((await pool.query('SELECT COUNT(*) AS n FROM canned_responses'))[0][0].n).toBe(0)

    const shared = await create('admin', { title: 'For all', shared: true })
    expect(shared).toMatchObject({ shared: true, owner_id: null })
    expect(await auditRows()).toEqual([
      {
        action: 'canned.shared_created',
        actor_id: users.admin.id,
        details: { canned_response_id: shared.id, title: 'For all' },
      },
    ])
  })

  test.each([
    ['no title', { body: 'x' }, 'title'],
    ['a blank title', { title: '   ', body: 'x' }, 'title'],
    ['a title over 100 characters', { title: 'x'.repeat(101), body: 'x' }, 'title'],
    ['no text', { title: 'T' }, 'body'],
    ['only spaces as text', { title: 'T', body: '  \n ' }, 'body'],
    ['text over 5,000 characters', { title: 'T', body: 'x'.repeat(5001) }, 'body'],
    ['shared not a boolean', { title: 'T', body: 'x', shared: 'yes' }, 'shared'],
    ['an unknown field', { title: 'T', body: 'x', owner_id: 3 }, 'owner_id'],
  ])('%s → 422 naming the field', async (_, body, field) => {
    const res = await as('admin').post('/api/canned-responses', body)
    expect(res.status).toBe(422)
    expect(res.body.errors.map((e) => e.field)).toContain(field)
  })

  test('100 characters of title and 5,000 of text are fine', async () => {
    await create('agent', { title: 'x'.repeat(100), body: 'y'.repeat(5000) })
  })
})

describe('titles are unique within their scope, ignoring case', () => {
  test("two shared ones can't share a title → 409 TITLE_TAKEN", async () => {
    await create('admin', { title: 'Password reset', shared: true })
    const res = await as('admin').post('/api/canned-responses', { title: 'PASSWORD RESET', body: 'x', shared: true })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      code: 'TITLE_TAKEN',
      errors: [{ field: 'title', message: 'There is already a shared response with this title' }],
    })
  })

  test("nor two of the same person's", async () => {
    await create('agent', { title: 'Greeting' })
    const res = await as('agent').post('/api/canned-responses', { title: 'greeting', body: 'x' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TITLE_TAKEN')
  })

  test("but a personal one may have a shared one's title, and two people may use the same title", async () => {
    await create('admin', { title: 'Greeting', shared: true })
    await create('admin', { title: 'Greeting' })
    await create('agent', { title: 'Greeting' })
    await create('agent2', { title: 'Greeting' })
  })

  test('renaming into a taken title → 409 as well', async () => {
    await create('agent', { title: 'One' })
    const two = await create('agent', { title: 'Two' })
    const res = await as('agent').patch(`/api/canned-responses/${two.id}`, { title: 'one' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TITLE_TAKEN')
  })
})

describe('editing and deleting', () => {
  test('the owner edits a personal one (only changed fields; no audit)', async () => {
    const mine = await create('agent', { title: 'Mine', body: 'Old' })
    const res = await as('agent').patch(`/api/canned-responses/${mine.id}`, { body: 'New text' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ title: 'Mine', body: 'New text', updated_by: { id: users.agent.id } })
    expect(await auditRows()).toEqual([])
  })

  test("someone else's personal one → 404 on PATCH, DELETE and used, even for an admin; it stays as it was", async () => {
    const drita = await create('agent2', { title: 'Drita only', body: 'Private' })
    for (const who of ['agent', 'admin']) {
      expect((await as(who).patch(`/api/canned-responses/${drita.id}`, { title: 'Hacked' })).status).toBe(404)
      expect((await as(who).delete(`/api/canned-responses/${drita.id}`)).status).toBe(404)
      expect((await as(who).post(`/api/canned-responses/${drita.id}/used`)).status).toBe(404)
    }
    // The same answer as for an id that doesn't exist
    expect((await as('agent').patch('/api/canned-responses/999999', { title: 'x' })).body).toEqual(
      (await as('agent').patch(`/api/canned-responses/${drita.id}`, { title: 'x' })).body,
    )
    const [[row]] = await pool.query('SELECT title, usage_count FROM canned_responses WHERE id = ?', [drita.id])
    expect(row).toEqual({ title: 'Drita only', usage_count: 0 })
  })

  test('a shared one: an agent gets 403 on PATCH and DELETE; an admin edits it (audited with the fields)', async () => {
    const shared = await create('admin', { title: 'Shared', body: 'Old', shared: true })
    expect((await as('agent').patch(`/api/canned-responses/${shared.id}`, { body: 'Changed' })).status).toBe(403)
    expect((await as('agent').delete(`/api/canned-responses/${shared.id}`)).status).toBe(403)

    const res = await as('admin').patch(`/api/canned-responses/${shared.id}`, { title: 'Shared reply', body: 'New' })
    expect(res.status).toBe(200)
    expect((await auditRows()).at(-1)).toEqual({
      action: 'canned.shared_updated',
      actor_id: users.admin.id,
      details: { canned_response_id: shared.id, title: 'Shared reply', fields: ['title', 'body'] },
    })
  })

  test('PATCH: nothing to change, an unknown field, or trying to change "shared" → 422', async () => {
    const mine = await create('agent', { title: 'Mine' })
    for (const body of [{}, { color: 'red' }, { shared: true }]) {
      expect((await as('agent').patch(`/api/canned-responses/${mine.id}`, body)).status).toBe(422)
    }
  })

  test('DELETE: the owner deletes their own; an admin deletes a shared one (audited); 204', async () => {
    const mine = await create('agent', { title: 'Mine' })
    expect((await as('agent').delete(`/api/canned-responses/${mine.id}`)).status).toBe(204)
    const shared = await create('admin', { title: 'Shared', shared: true })
    expect((await as('admin').delete(`/api/canned-responses/${shared.id}`)).status).toBe(204)
    expect((await pool.query('SELECT COUNT(*) AS n FROM canned_responses'))[0][0].n).toBe(0)
    expect((await auditRows()).map((row) => row.action)).toEqual(['canned.shared_created', 'canned.shared_deleted'])
  })
})

describe('the usage counter', () => {
  test('POST /:id/used counts one use and sets last_used_at, for a shared one or my own; updated_at stays', async () => {
    const shared = await create('admin', { title: 'Shared', shared: true })
    await pool.query("UPDATE canned_responses SET updated_at = '2026-01-01 10:00:00' WHERE id = ?", [shared.id])
    expect((await as('agent').post(`/api/canned-responses/${shared.id}/used`)).status).toBe(204)
    expect((await as('agent2').post(`/api/canned-responses/${shared.id}/used`)).status).toBe(204)
    const [[row]] = await pool.query(
      'SELECT usage_count, last_used_at, updated_at FROM canned_responses WHERE id = ?',
      [shared.id],
    )
    expect(row.usage_count).toBe(2)
    expect(row.last_used_at).toBeInstanceOf(Date)
    expect(row.updated_at.toISOString()).toBe(new Date('2026-01-01T10:00:00').toISOString())
    // Using one is not a change: no audit entry
    expect((await auditRows()).map((r) => r.action)).toEqual(['canned.shared_created'])
  })

  test('an unknown id → 404; a bad id → 422', async () => {
    expect((await as('agent').post('/api/canned-responses/424242/used')).status).toBe(404)
    expect((await as('agent').post('/api/canned-responses/abc/used')).status).toBe(422)
  })
})
