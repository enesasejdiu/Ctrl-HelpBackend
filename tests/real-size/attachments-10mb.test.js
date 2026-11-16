// The ONE test with a real-size file: just over 10 MB, against the real limit (no ATTACHMENT_MAX_BYTES).
// It runs in its own Jest run after the main suite (npm test / npm run test:coverage, jest.real-size.config.js), so
// building and sending 10 MB never slows down another test file. Every other attachment test uses a 200 KB limit.
const fs = require('fs')
const pool = require('../../src/db')
const { api, resetData, createUser, loginAs, auth } = require('../helpers')
const { maxFileBytes, uploadDir } = require('../../src/attachments')

// The real limit for this file: tests/setupEnv.js sets the small test limit, which is read on every request
delete process.env.ATTACHMENT_MAX_BYTES

beforeAll(async () => {
  await require('../support/guard').assertThrowawayDb()
  await resetData()
})

test('a PNG just over 10 MB gets 413 FILE_TOO_LARGE with the 10 MB limit, and nothing is saved', async () => {
  expect(maxFileBytes()).toBe(10 * 1024 * 1024)
  const user = await createUser()
  const session = await loginAs(user)
  const [[category]] = await pool.query('SELECT id FROM categories LIMIT 1')
  const [[priority]] = await pool.query('SELECT id FROM priorities LIMIT 1')
  const ticket = await api.post('/api/tickets').set(auth(session)).send({
    title: 'Big file',
    description: 'A screenshot that is too big',
    category_id: category.id,
    priority_id: priority.id,
  })

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const justOver = Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024 - png.length + 1, 1)])
  const res = await api
    .post(`/api/tickets/${ticket.body.id}/attachments`)
    .set(auth(session))
    .attach('files', justOver, 'screenshot.png')

  expect(res.status).toBe(413)
  expect(res.body).toEqual({ message: 'Each file can be at most 10 MB', code: 'FILE_TOO_LARGE', max_bytes: 10485760 })
  const [rows] = await pool.query('SELECT id FROM attachments')
  expect(rows).toHaveLength(0)
  expect(fs.existsSync(uploadDir()) ? fs.readdirSync(uploadDir()) : []).toEqual([])
})

test('a PNG of exactly 10 MB is accepted (201), and stored byte for byte', async () => {
  const user = await createUser()
  const session = await loginAs(user)
  const [[category]] = await pool.query('SELECT id FROM categories LIMIT 1')
  const ticket = await api
    .post('/api/tickets')
    .set(auth(session))
    .send({ title: 'Exact', description: 'A screenshot of exactly 10 MB', category_id: category.id })

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const exact = Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024 - png.length, 2)])
  const res = await api
    .post(`/api/tickets/${ticket.body.id}/attachments`)
    .set(auth(session))
    .attach('files', exact, 'exact.png')

  expect(res.status).toBe(201)
  expect(res.body[0]).toMatchObject({ mime_type: 'image/png', size_bytes: 10485760 })
  const [[row]] = await pool.query('SELECT stored_name, size_bytes FROM attachments WHERE id = ?', [res.body[0].id])
  expect(row.size_bytes).toBe(10485760)
  expect(fs.readFileSync(require('path').join(uploadDir(), row.stored_name)).equals(exact)).toBe(true)
})
