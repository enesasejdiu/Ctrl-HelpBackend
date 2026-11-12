// Tests for resetData() (tests/helpers.js): every test file shares one database, so whatever a test changes through
// the API must be gone after resetData(), including the categories, priorities and company name an admin can change.
// Without that, DELETE /api/categories/1 in one file (tests/auth-enforcement.test.js calls every route as an admin)
// broke ticket creation with category_id: 1 in a later file.
const pool = require('../src/db')
const reference = require('../scripts/reference-data')
const { api, resetData, createUser, loginAs, auth } = require('./helpers')

const rows = async (sql) => (await pool.query(sql))[0]

test('resetData() undoes an admin deleting, archiving and renaming reference data, with the same ids', async () => {
  await resetData()
  const session = await loginAs(await createUser({ role: 'admin' }))
  const as = (req) => req.set(auth(session))

  expect((await as(api.delete('/api/categories/1'))).status).toBe(204)
  expect((await as(api.delete('/api/priorities/1'))).status).toBe(204)
  expect((await as(api.patch('/api/categories/2')).send({ is_active: false })).status).toBe(200)
  expect((await as(api.patch('/api/priorities/3')).send({ target_hours: 1 })).status).toBe(200)
  expect((await as(api.patch('/api/settings')).send({ company_name: 'Changed Corp' })).status).toBe(200)

  await resetData()

  expect(await rows('SELECT id, name, is_active FROM categories ORDER BY id')).toEqual(
    reference.categories.map(([name], i) => ({ id: i + 1, name, is_active: 1 })),
  )
  expect(await rows('SELECT id, name, target_hours, is_default, is_active FROM priorities ORDER BY id')).toEqual(
    reference.priorities.map(([name, , hours], i) => ({
      id: i + 1,
      name,
      target_hours: hours,
      is_default: name === reference.defaultPriority ? 1 : 0,
      is_active: 1,
    })),
  )
  // The API answers with the restored values too (the settings cache was cleared)
  expect((await api.get('/api/settings/public')).body.company_name).toBe('TicketFlow')

  // And a ticket with category 1 and priority 1 can be created again
  const employee = await loginAs(await createUser())
  const ticket = await api
    .post('/api/tickets')
    .set(auth(employee))
    .send({ title: 'Printer broken', description: 'It prints blank pages', category_id: 1, priority_id: 1 })
  expect(ticket.status).toBe(201)
})
