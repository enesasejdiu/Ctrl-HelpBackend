// Ticket attachments: POST/GET /api/tickets/:id/attachments, GET /api/attachments/:id/download, DELETE
// /api/attachments/:id, and attachments[] in GET /api/tickets/:id. Every test file gets its own empty UPLOAD_DIR
// (tests/setupEnv.js), so the tests can look at exactly which files are on disk.
const fs = require('fs')
const path = require('path')
const pool = require('../src/db')
const { api, resetData, createUser, loginAs, auth } = require('./helpers')
const { maxFileBytes, uploadDir } = require('../src/attachments')

// The tests run with a small size limit (ATTACHMENT_MAX_BYTES, 200 KB, from tests/setupEnv.js), so no test here builds a
// big file. The real 10 MB limit has its own test, run on its own: tests/real-size/attachments-10mb.test.js.
const LIMIT = maxFileBytes()

beforeEach(async () => {
  await resetData()
  fs.rmSync(uploadDir(), { recursive: true, force: true })
})

// ---- File contents: real signatures for the binary types, plain text for the rest ----
const bytes = (...parts) =>
  Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))))
const FILES = {
  png: bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], 'IHDR', [0, 0, 0, 1, 0, 0, 0, 1]),
  jpg: bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF', [0, 1, 1, 0, 0, 1]),
  gif: bytes('GIF89a', [1, 0, 1, 0, 0x80, 0, 0]),
  webp: bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 ', [0, 0, 0, 0]),
  pdf: bytes('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n'),
  txt: Buffer.from('The printer says PC LOAD LETTER.\n'),
  log: Buffer.from('2026-11-11 08:00:01 ERROR disk full\n'),
  csv: Buffer.from('name,count\nprinters,3\n'),
}
const EXE = bytes('MZ', [0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff])
const ZIP = bytes('PK', [3, 4, 20, 0, 0, 0, 8, 0])

// ---- Helpers ----
async function setup() {
  const requester = await createUser()
  const other = await createUser()
  const agent = await createUser({ role: 'agent' })
  const admin = await createUser({ role: 'admin' })
  const hr = await createUser({ role: 'hr' })
  const sessions = {}
  for (const [name, user] of Object.entries({ requester, other, agent, admin, hr }))
    sessions[name] = await loginAs(user)

  const [[category]] = await pool.query('SELECT id FROM categories LIMIT 1')
  const [[priority]] = await pool.query('SELECT id FROM priorities LIMIT 1')
  const res = await api.post('/api/tickets').set(auth(sessions.requester)).send({
    title: 'Printer broken',
    description: 'See the attached photo',
    category_id: category.id,
    priority_id: priority.id,
  })
  expect(res.status).toBe(201)
  return { users: { requester, other, agent, admin, hr }, sessions, ticketId: res.body.id }
}

// POST /api/tickets/:id/attachments with [name, content] pairs
function upload(session, ticketId, files, field = 'files') {
  const req = api.post(`/api/tickets/${ticketId}/attachments`).set(auth(session))
  for (const [name, content] of files) req.attach(field, content, name)
  return req
}

const storedFiles = () => (fs.existsSync(uploadDir()) ? fs.readdirSync(uploadDir()) : [])
const attachmentRows = async () => (await pool.query('SELECT * FROM attachments ORDER BY id'))[0]
const auditRows = async () =>
  (
    await pool.query("SELECT action, actor_id, details FROM audit_log WHERE action LIKE 'attachment_%' ORDER BY id")
  )[0].map((row) => ({ ...row, details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details }))

function expectNothingSaved(rows, files) {
  expect(rows).toHaveLength(0)
  expect(files).toHaveLength(0)
}

// ---- Uploading ----
describe('POST /api/tickets/:id/attachments: allowed files', () => {
  test.each([
    ['photo.png', 'png', 'image/png'],
    ['photo.jpg', 'jpg', 'image/jpeg'],
    ['photo.JPEG', 'jpg', 'image/jpeg'],
    ['animation.gif', 'gif', 'image/gif'],
    ['picture.webp', 'webp', 'image/webp'],
    ['invoice.pdf', 'pdf', 'application/pdf'],
    ['notes.txt', 'txt', 'text/plain'],
    ['server.log', 'log', 'text/plain'],
    ['report.csv', 'csv', 'text/csv'],
  ])('%s is accepted and stored as %s', async (name, kind, mime) => {
    const { sessions, users, ticketId } = await setup()
    const res = await upload(sessions.requester, ticketId, [[name, FILES[kind]]])

    expect(res.status).toBe(201)
    expect(res.body).toEqual([
      {
        id: expect.any(Number),
        ticket_id: ticketId,
        original_name: name,
        mime_type: mime,
        size_bytes: FILES[kind].length,
        uploaded_by: { id: users.requester.id, name: users.requester.name },
        created_at: expect.any(String),
      },
    ])
    // On disk under a random id (never the user's name), with exactly the uploaded bytes
    const [row] = await attachmentRows()
    expect(row.stored_name).toMatch(/^[0-9a-f-]{36}$/)
    expect(storedFiles()).toEqual([row.stored_name])
    expect(fs.readFileSync(path.join(uploadDir(), row.stored_name)).equals(FILES[kind])).toBe(true)
  })

  test('up to 5 files at once, and they all come back', async () => {
    const { sessions, ticketId } = await setup()
    const res = await upload(sessions.requester, ticketId, [
      ['a.png', FILES.png],
      ['b.pdf', FILES.pdf],
      ['c.txt', FILES.txt],
      ['d.csv', FILES.csv],
      ['e.gif', FILES.gif],
    ])
    expect(res.status).toBe(201)
    expect(res.body.map((a) => a.original_name)).toEqual(['a.png', 'b.pdf', 'c.txt', 'd.csv', 'e.gif'])
    expect(storedFiles()).toHaveLength(5)
  })

  test("staff (agent and admin) can add files to anyone's ticket", async () => {
    const { sessions, ticketId } = await setup()
    expect((await upload(sessions.agent, ticketId, [['trace.log', FILES.log]])).status).toBe(201)
    expect((await upload(sessions.admin, ticketId, [['shot.png', FILES.png]])).status).toBe(201)
  })

  test('a UTF-8 file name is kept as it was sent', async () => {
    const { sessions, ticketId } = await setup()
    const res = await upload(sessions.requester, ticketId, [['Préavis été.pdf', FILES.pdf]])
    expect(res.body[0].original_name).toBe('Préavis été.pdf')
  })

  test('a file of exactly the limit is accepted', async () => {
    expect(LIMIT).toBe(200 * 1024)
    const { sessions, ticketId } = await setup()
    const big = Buffer.concat([FILES.png, Buffer.alloc(LIMIT - FILES.png.length, 1)])
    const res = await upload(sessions.requester, ticketId, [['big.png', big]])
    expect(res.status).toBe(201)
    expect(res.body[0].size_bytes).toBe(LIMIT)
  })
})

describe('POST /api/tickets/:id/attachments: refused files (nothing is saved)', () => {
  test.each([
    ['a program', 'invoice.exe', EXE],
    ['a program renamed to .png', 'invoice.png', EXE],
    ['a .png that is really text', 'photo.png', Buffer.from('this is not an image')],
    ['a .pdf that is really a PNG (the name must match the content)', 'scan.pdf', FILES.png],
    ['a zip renamed to .csv', 'data.csv', ZIP],
    ['a .txt with binary bytes', 'notes.txt', bytes('hello', [0, 1, 2], 'world')],
    ['a .txt that is not valid UTF-8', 'notes.txt', bytes([0xc3, 0x28, 0x41])],
    ['an SVG (text, but not an allowed type)', 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['an HTML page', 'page.html', Buffer.from('<html><script>alert(1)</script></html>')],
    ['a file without an extension', 'README', FILES.txt],
  ])('%s: 400 UNSUPPORTED_FILE_TYPE', async (_, name, content) => {
    const { sessions, ticketId } = await setup()
    const res = await upload(sessions.requester, ticketId, [[name, content]])

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({
      code: 'UNSUPPORTED_FILE_TYPE',
      message: `${name}: this file type isn't allowed`,
      file: name,
      allowed: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'log', 'csv'],
    })
    expectNothingSaved(await attachmentRows(), storedFiles())
  })

  test('one bad file refuses the whole upload: the good ones are not saved either', async () => {
    const { sessions, ticketId } = await setup()
    const res = await upload(sessions.requester, ticketId, [
      ['good.png', FILES.png],
      ['invoice.exe', EXE],
    ])
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('UNSUPPORTED_FILE_TYPE')
    expectNothingSaved(await attachmentRows(), storedFiles())
  })

  test('an empty file: 400 EMPTY_FILE', async () => {
    const { sessions, ticketId } = await setup()
    const res = await upload(sessions.requester, ticketId, [['empty.txt', Buffer.alloc(0)]])
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'EMPTY_FILE', message: 'empty.txt is empty' })
  })

  test('one byte over the limit: 413 FILE_TOO_LARGE, with the limit in the message and in max_bytes', async () => {
    const { sessions, ticketId } = await setup()
    const tooBig = Buffer.concat([FILES.png, Buffer.alloc(LIMIT - FILES.png.length + 1, 1)])
    const res = await upload(sessions.requester, ticketId, [['big.png', tooBig]])
    expect(res.status).toBe(413)
    expect(res.body).toMatchObject({
      code: 'FILE_TOO_LARGE',
      message: 'Each file can be at most 200 KB',
      max_bytes: LIMIT,
    })
    expectNothingSaved(await attachmentRows(), storedFiles())
  })

  test('6 files in one upload: 400 TOO_MANY_FILES', async () => {
    const { sessions, ticketId } = await setup()
    const six = Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, FILES.txt])
    const res = await upload(sessions.requester, ticketId, six)
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'TOO_MANY_FILES', message: 'Upload at most 5 files at a time' })
    expectNothingSaved(await attachmentRows(), storedFiles())
  })

  test('no file at all: 400 NO_FILES (also when the body is JSON)', async () => {
    const { sessions, ticketId } = await setup()
    expect((await upload(sessions.requester, ticketId, [])).body.code).toBe('NO_FILES')
    const json = await api
      .post(`/api/tickets/${ticketId}/attachments`)
      .set(auth(sessions.requester))
      .send({ files: [] })
    expect(json.status).toBe(400)
    expect(json.body.code).toBe('NO_FILES')
  })

  test('files in another field, or extra text fields: 400 INVALID_UPLOAD', async () => {
    const { sessions, ticketId } = await setup()
    const wrongField = await upload(sessions.requester, ticketId, [['a.png', FILES.png]], 'file')
    expect(wrongField.status).toBe(400)
    expect(wrongField.body.code).toBe('INVALID_UPLOAD')

    const withField = await api
      .post(`/api/tickets/${ticketId}/attachments`)
      .set(auth(sessions.requester))
      .field('note', 'hello')
      .attach('files', FILES.png, 'a.png')
    expect(withField.status).toBe(400)
    expect(withField.body.code).toBe('INVALID_UPLOAD')
  })
})

describe('at most 20 attachments per ticket', () => {
  async function fill(ticketId, userId, count) {
    for (let i = 0; i < count; i += 1) {
      await pool.query(
        `INSERT INTO attachments (ticket_id, uploaded_by, original_name, stored_name, mime_type, size_bytes)
         VALUES (?, ?, ?, UUID(), 'text/plain', 1)`,
        [ticketId, userId, `old${i}.txt`],
      )
    }
  }

  test('18 already: 3 more are refused (400 TOO_MANY_ATTACHMENTS), 2 more fit, then nothing more', async () => {
    const { sessions, users, ticketId } = await setup()
    await fill(ticketId, users.requester.id, 18)

    const three = Array.from({ length: 3 }, (_, i) => [`n${i}.txt`, FILES.txt])
    const refused = await upload(sessions.requester, ticketId, three)
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({
      code: 'TOO_MANY_ATTACHMENTS',
      message: 'A ticket can have at most 20 attachments. This one has 18, so you can add 2 more.',
      max_per_ticket: 20,
      current: 18,
    })
    expect(storedFiles()).toHaveLength(0)

    expect((await upload(sessions.requester, ticketId, three.slice(0, 2))).status).toBe(201)
    const full = await upload(sessions.requester, ticketId, [['last.txt', FILES.txt]])
    expect(full.status).toBe(400)
    expect(full.body.current).toBe(20)
  })

  test('the limit is per ticket: another ticket is not affected', async () => {
    const { sessions, users, ticketId } = await setup()
    await fill(ticketId, users.requester.id, 20)
    const [[category]] = await pool.query('SELECT id FROM categories LIMIT 1')
    const [[priority]] = await pool.query('SELECT id FROM priorities LIMIT 1')
    const second = await api
      .post('/api/tickets')
      .set(auth(sessions.requester))
      .send({ title: 'Second', description: 'Another one', category_id: category.id, priority_id: priority.id })
    expect((await upload(sessions.requester, second.body.id, [['a.txt', FILES.txt]])).status).toBe(201)
  })
})

// ---- Who may see them ----
describe('visibility', () => {
  test('another employee and HR (an employee for tickets) get 403 for upload, list, download and delete', async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [['a.png', FILES.png]])).body

    for (const who of ['other', 'hr']) {
      const session = sessions[who]
      expect((await upload(session, ticketId, [['b.png', FILES.png]])).status).toBe(403)
      expect((await api.get(`/api/tickets/${ticketId}/attachments`).set(auth(session))).status).toBe(403)
      const download = await api.get(`/api/attachments/${attachment.id}/download`).set(auth(session))
      expect(download.status).toBe(403)
      expect(download.body.message).toBe('You can only see attachments on your own tickets')
      expect((await api.delete(`/api/attachments/${attachment.id}`).set(auth(session))).status).toBe(403)
    }
    expect(await attachmentRows()).toHaveLength(1)
  })

  test('the requester, an agent and an admin can list and download', async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [['a.png', FILES.png]])).body

    for (const who of ['requester', 'agent', 'admin']) {
      const list = await api.get(`/api/tickets/${ticketId}/attachments`).set(auth(sessions[who]))
      expect(list.status).toBe(200)
      expect(list.body).toEqual([attachment])
      expect((await api.get(`/api/attachments/${attachment.id}/download`).set(auth(sessions[who]))).status).toBe(200)
    }
  })

  test('GET /api/tickets/:id includes attachments[] (oldest first)', async () => {
    const { sessions, ticketId } = await setup()
    await upload(sessions.requester, ticketId, [['first.txt', FILES.txt]])
    await upload(sessions.agent, ticketId, [['second.log', FILES.log]])

    const res = await api.get(`/api/tickets/${ticketId}`).set(auth(sessions.requester))
    expect(res.body.attachments.map((a) => [a.original_name, a.uploaded_by.name])).toEqual([
      ['first.txt', expect.any(String)],
      ['second.log', expect.any(String)],
    ])
    expect(res.body.attachments[0]).not.toHaveProperty('stored_name')
  })

  test('an unknown ticket or attachment: 404', async () => {
    const { sessions } = await setup()
    expect((await upload(sessions.requester, 99999, [['a.png', FILES.png]])).status).toBe(404)
    expect((await api.get('/api/attachments/99999/download').set(auth(sessions.requester))).status).toBe(404)
    expect((await api.delete('/api/attachments/99999').set(auth(sessions.requester))).status).toBe(404)
  })

  test('the ticket is checked before the files are read: a 403 even for a refused file type', async () => {
    const { sessions, ticketId } = await setup()
    const res = await upload(sessions.other, ticketId, [['invoice.exe', EXE]])
    expect(res.status).toBe(403)
  })

  test('without a session: 401; with the cookie but no CSRF header: 403 CSRF_INVALID', async () => {
    const { sessions, ticketId } = await setup()
    expect((await api.post(`/api/tickets/${ticketId}/attachments`).attach('files', FILES.png, 'a.png')).status).toBe(
      401,
    )

    const noCsrf = await api
      .post(`/api/tickets/${ticketId}/attachments`)
      .set('Cookie', `tf_session=${sessions.requester}`)
      .attach('files', FILES.png, 'a.png')
    expect(noCsrf.status).toBe(403)
    expect(noCsrf.body.code).toBe('CSRF_INVALID')
    expect(await attachmentRows()).toHaveLength(0)
  })
})

// ---- Downloading ----
describe('GET /api/attachments/:id/download', () => {
  test('sends the exact file as a download (never inline), with its type and nosniff', async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [['invoice.pdf', FILES.pdf]])).body

    const res = await api
      .get(`/api/attachments/${attachment.id}/download`)
      .set(auth(sessions.agent))
      .buffer(true)
      .parse((response, done) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => done(null, Buffer.concat(chunks)))
      })
    expect(res.status).toBe(200)
    // A plain name may come with or without quotes; both mean the same
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="?invoice\.pdf"?$/)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.headers['content-length']).toBe(String(FILES.pdf.length))
    expect(res.body.equals(FILES.pdf)).toBe(true)
  })

  test('a text file is served as text/plain, never as HTML, even if it contains markup', async () => {
    const { sessions, ticketId } = await setup()
    const html = Buffer.from('<html><script>alert(1)</script></html>\n')
    const [attachment] = (await upload(sessions.requester, ticketId, [['page.txt', html]])).body
    const res = await api.get(`/api/attachments/${attachment.id}/download`).set(auth(sessions.requester))
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    expect(res.headers['content-disposition']).toMatch(/^attachment;/)
  })

  test('a non-ASCII name gets a safe ASCII fallback plus filename* in UTF-8', async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [['Préavis.pdf', FILES.pdf]])).body
    const res = await api.get(`/api/attachments/${attachment.id}/download`).set(auth(sessions.requester))
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Pr?avis.pdf"; filename*=UTF-8''Pr%C3%A9avis.pdf`,
    )
  })

  test('a file missing on disk: 404 FILE_MISSING (not a crash)', async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [['a.png', FILES.png]])).body
    for (const file of storedFiles()) fs.rmSync(path.join(uploadDir(), file))

    const errors = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await api.get(`/api/attachments/${attachment.id}/download`).set(auth(sessions.requester))
    errors.mockRestore()
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('FILE_MISSING')
  })
})

// ---- Names that try to escape ----
describe('file names are never paths', () => {
  test.each([
    ['../../../../etc/passwd.txt', 'passwd.txt'],
    ['..\\..\\Windows\\win.txt', 'win.txt'],
    ['/absolute/path/report.csv', 'report.csv'],
    ['..txt', 'txt'],
    ['  spaced\tout  name.txt ', 'spaced out name.txt'],
    ['line\r\nbreak.txt', 'line break.txt'],
  ])('%j is stored as %j, and the file lands only in UPLOAD_DIR', async (sent, kept) => {
    const { sessions, ticketId } = await setup()
    const res = await upload(sessions.requester, ticketId, [[sent, FILES.txt]])

    // "..txt" has no extension left once the leading dots go, so it isn't an allowed type
    if (!kept.includes('.')) {
      expect(res.status).toBe(400)
      return
    }
    expect(res.status).toBe(201)
    expect(res.body[0].original_name).toBe(kept)
    const [row] = await attachmentRows()
    expect(storedFiles()).toEqual([row.stored_name])
    expect(fs.existsSync(path.resolve(uploadDir(), '..', kept))).toBe(false)
  })

  test('a name with quotes and a line break cannot add headers to the download', async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [['a"\r\nX-Evil: 1.txt', FILES.txt]])).body
    const res = await api.get(`/api/attachments/${attachment.id}/download`).set(auth(sessions.requester))
    expect(res.status).toBe(200)
    expect(res.headers['x-evil']).toBeUndefined()
    expect(res.headers['content-disposition']).toBe('attachment; filename="a\\" X-Evil: 1.txt"')
  })

  test('a very long name is shortened to 255 characters, keeping the extension', async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [[`${'x'.repeat(300)}.pdf`, FILES.pdf]])).body
    expect(attachment.original_name).toHaveLength(255)
    expect(attachment.original_name.endsWith('.pdf')).toBe(true)
  })
})

// ---- Deleting ----
describe('DELETE /api/attachments/:id', () => {
  test('the uploader deletes their file: 204, gone from the list and from disk', async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [['a.png', FILES.png]])).body
    expect(storedFiles()).toHaveLength(1)

    const res = await api.delete(`/api/attachments/${attachment.id}`).set(auth(sessions.requester))
    expect(res.status).toBe(204)
    expect(storedFiles()).toHaveLength(0)
    expect(await attachmentRows()).toHaveLength(0)
    expect((await api.get(`/api/attachments/${attachment.id}/download`).set(auth(sessions.requester))).status).toBe(404)
  })

  test("an admin can delete anyone's file", async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [['a.png', FILES.png]])).body
    expect((await api.delete(`/api/attachments/${attachment.id}`).set(auth(sessions.admin))).status).toBe(204)
    expect(storedFiles()).toHaveLength(0)
  })

  test("an agent can see the file but not delete someone else's: 403, and the file stays", async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [['a.png', FILES.png]])).body
    const res = await api.delete(`/api/attachments/${attachment.id}`).set(auth(sessions.agent))
    expect(res.status).toBe(403)
    expect(res.body.message).toBe('Only the person who uploaded a file, or an admin, can delete it')
    expect(storedFiles()).toHaveLength(1)
  })

  test('the requester cannot delete a file an agent added to their ticket', async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.agent, ticketId, [['trace.log', FILES.log]])).body
    expect((await api.delete(`/api/attachments/${attachment.id}`).set(auth(sessions.requester))).status).toBe(403)
    expect((await api.delete(`/api/attachments/${attachment.id}`).set(auth(sessions.agent))).status).toBe(204)
  })

  test('deleting a ticket deletes its attachment rows (ON DELETE CASCADE)', async () => {
    const { sessions, ticketId } = await setup()
    await upload(sessions.requester, ticketId, [['a.png', FILES.png]])
    await pool.query('DELETE FROM ticket_history WHERE ticket_id = ?', [ticketId])
    await pool.query('DELETE FROM tickets WHERE id = ?', [ticketId])
    expect(await attachmentRows()).toHaveLength(0)
  })
})

// ---- Audit log ----
describe('audit log', () => {
  test('uploads and deletes are logged with the file name and size, never the content', async () => {
    const { sessions, users, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [['notes.txt', FILES.txt]])).body
    await api.delete(`/api/attachments/${attachment.id}`).set(auth(sessions.admin))

    const rows = await auditRows()
    expect(rows).toEqual([
      {
        action: 'attachment_uploaded',
        actor_id: users.requester.id,
        details: { ticket_id: ticketId, file_name: 'notes.txt', mime_type: 'text/plain', size_bytes: FILES.txt.length },
      },
      {
        action: 'attachment_deleted',
        actor_id: users.admin.id,
        details: { ticket_id: ticketId, file_name: 'notes.txt', size_bytes: FILES.txt.length },
      },
    ])
    expect(JSON.stringify(rows)).not.toContain('PC LOAD LETTER')
  })

  test('a refused upload logs nothing', async () => {
    const { sessions, ticketId } = await setup()
    await upload(sessions.requester, ticketId, [['invoice.exe', EXE]])
    expect(await auditRows()).toEqual([])
  })
})

describe('the size limit outside the test environment', () => {
  test('without NODE_ENV=test, ATTACHMENT_MAX_BYTES is ignored and the limit is always 10 MB', async () => {
    const { sessions, ticketId } = await setup()
    const overTheTestLimit = Buffer.concat([FILES.png, Buffer.alloc(LIMIT, 1)]) // 200 KB + a little

    for (const NODE_ENV of ['development', 'production']) {
      expect(maxFileBytes({ NODE_ENV, ATTACHMENT_MAX_BYTES: String(LIMIT) })).toBe(10 * 1024 * 1024)
    }
    // The real route, too: with NODE_ENV=development the same file that is too big in tests is accepted
    process.env.NODE_ENV = 'development'
    try {
      const res = await upload(sessions.requester, ticketId, [['over-test-limit.png', overTheTestLimit]])
      expect(res.status).toBe(201)
    } finally {
      process.env.NODE_ENV = 'test'
    }
    // ...and back in the test environment it's refused again
    const refused = await upload(sessions.requester, ticketId, [['again.png', overTheTestLimit]])
    expect(refused.status).toBe(413)
  })
})

// ---- The test plan's rules (email, uploads, pagination). Where the app does something else, the test states the rule
// and is marked test.failing with "BUG:" and why: Jest reports it as passing while the app is wrong, and fails as soon
// as the app is fixed, so the marker must then be removed. The tests above keep checking what the app does today.
describe('upload rules', () => {
  const crypto = require('crypto')
  const { assertThrowawayDb } = require('./support/guard')
  beforeAll(assertThrowawayDb)

  const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
  const KIND_FOR = { png: 'png', jpg: 'jpg', gif: 'gif', webp: 'webp', pdf: 'pdf', txt: 'txt', log: 'log', csv: 'csv' }

  test.each(Object.keys(KIND_FOR))(
    '.%s: 201; stored as a bare UUID (no extension) with the MIME type and size in the row',
    async (ext) => {
      const { sessions, ticketId } = await setup()
      const res = await upload(sessions.requester, ticketId, [[`file.${ext}`, FILES[KIND_FOR[ext]]]])
      expect(res.status).toBe(201)
      const [row] = await attachmentRows()
      expect(row.stored_name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(storedFiles()).toEqual([row.stored_name])
      expect(row.mime_type).toBe(res.body[0].mime_type)
      expect(row.size_bytes).toBe(FILES[KIND_FOR[ext]].length)
    },
  )

  // BUG: the attachments table (migration 012) has no sha256 column, and the upload never hashes the file
  test.failing('BUG: the attachment row stores the sha256 of the file', async () => {
    const { sessions, ticketId } = await setup()
    await upload(sessions.requester, ticketId, [['photo.png', FILES.png]])
    const [row] = await attachmentRows()
    expect(row.sha256).toBe(sha256(FILES.png))
  })

  // BUG: an empty file is refused with 400 EMPTY_FILE (routes/attachments.js uploadAttachments), not 422
  test.failing('BUG: an empty file is refused with 422', async () => {
    const { sessions, ticketId } = await setup()
    const res = await upload(sessions.requester, ticketId, [['empty.txt', Buffer.alloc(0)]])
    expect(res.status).toBe(422)
  })

  test('an empty file leaves nothing behind', async () => {
    const { sessions, ticketId } = await setup()
    await upload(sessions.requester, ticketId, [['empty.txt', Buffer.alloc(0)]])
    expectNothingSaved(await attachmentRows(), storedFiles())
  })

  const REFUSED = [
    ['an SVG', 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['an HTML page', 'page.html', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['an .htm page', 'page.htm', Buffer.from('<p>hi</p>')],
    ['an exe', 'setup.exe', EXE],
    ['an exe named .pdf', 'setup.pdf', EXE],
    ['a JPEG named .png', 'photo.png', FILES.jpg],
    ['a PDF named .txt', 'notes.txt', FILES.pdf],
    ['text with a NUL byte', 'notes.txt', bytes('abc', [0], 'def')],
    ['text that is not valid UTF-8', 'server.log', bytes('ok ', [0xff, 0xfe, 0xfd])],
  ]

  test.each(REFUSED)('%s is refused and nothing is saved', async (_, name, content) => {
    const { sessions, ticketId } = await setup()
    const res = await upload(sessions.requester, ticketId, [[name, content]])
    expect([400, 415]).toContain(res.status)
    expect(res.body.code).toBe('UNSUPPORTED_FILE_TYPE')
    expectNothingSaved(await attachmentRows(), storedFiles())
  })

  // BUG: a refused file type gets 400 UNSUPPORTED_FILE_TYPE (routes/attachments.js uploadAttachments), not 415
  test.failing.each(REFUSED)('BUG: %s is refused with 415', async (_, name, content) => {
    const { sessions, ticketId } = await setup()
    const res = await upload(sessions.requester, ticketId, [[name, content]])
    expect(res.status).toBe(415)
  })

  test('the Content-Type the client sends is ignored: an exe sent as image/png is refused', async () => {
    const { sessions, ticketId } = await setup()
    const res = await api
      .post(`/api/tickets/${ticketId}/attachments`)
      .set(auth(sessions.requester))
      .attach('files', EXE, { filename: 'photo.png', contentType: 'image/png' })
    expect(res.body.code).toBe('UNSUPPORTED_FILE_TYPE')
    expectNothingSaved(await attachmentRows(), storedFiles())
  })

  test('... and a real PNG sent as text/html is stored as image/png', async () => {
    const { sessions, ticketId } = await setup()
    const res = await api
      .post(`/api/tickets/${ticketId}/attachments`)
      .set(auth(sessions.requester))
      .attach('files', FILES.png, { filename: 'photo.png', contentType: 'text/html' })
    expect(res.status).toBe(201)
    expect(res.body[0].mime_type).toBe('image/png')
  })

  // BUG: see above; the fake Content-Type case gets 400 too
  test.failing('BUG: an exe sent as image/png is refused with 415', async () => {
    const { sessions, ticketId } = await setup()
    const res = await api
      .post(`/api/tickets/${ticketId}/attachments`)
      .set(auth(sessions.requester))
      .attach('files', EXE, { filename: 'photo.png', contentType: 'image/png' })
    expect(res.status).toBe(415)
  })

  test.each(['nul\u0000byte.txt', 'del\u007fete.txt'])(
    'a raw control character in the multipart name (%j) is refused by the parser, and nothing is saved',
    async (sent) => {
      const { sessions, ticketId } = await setup()
      const res = await upload(sessions.requester, ticketId, [[sent, FILES.txt]])
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('INVALID_UPLOAD')
      expectNothingSaved(await attachmentRows(), storedFiles())
    },
  )

  test('safeName drops control characters from any name that gets past the parser', () => {
    const { safeName } = require('../src/attachments')
    expect(safeName('nul\u0000byte.txt')).toBe('nulbyte.txt')
    expect(safeName('del\u007fete.txt')).toBe('delete.txt')
    expect(safeName('bell\u0007\u001b[31m.txt')).toBe('bell[31m.txt')
    expect(safeName('')).toBe('file')
  })

  test.each([
    ['C:\\Users\\me\\Desktop\\report.csv', 'report.csv'],
    ['....hidden.txt', 'hidden.txt'],
  ])('the name %j is kept as %j', async (sent, kept) => {
    const { sessions, ticketId } = await setup()
    const res = await upload(sessions.requester, ticketId, [[sent, sent.endsWith('.csv') ? FILES.csv : FILES.txt]])
    expect(res.status).toBe(201)
    expect(res.body[0].original_name).toBe(kept)
    const [row] = await attachmentRows()
    expect(row.original_name).toBe(kept)
    expect(storedFiles()).toEqual([row.stored_name])
  })
})

describe('attachment permissions and downloads (test plan)', () => {
  const { assertThrowawayDb } = require('./support/guard')
  beforeAll(assertThrowawayDb)

  // BUG: routes/tickets.js loadVisibleTicket and routes/attachments.js loadAttachment answer 403 for a ticket the
  // caller can't see, which tells them it exists; the rule is 404
  test.failing('BUG: another employee gets 404 (not 403) for upload, list, download and delete', async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [['a.png', FILES.png]])).body
    const statuses = [
      (await upload(sessions.other, ticketId, [['b.png', FILES.png]])).status,
      (await api.get(`/api/tickets/${ticketId}/attachments`).set(auth(sessions.other))).status,
      (await api.get(`/api/attachments/${attachment.id}/download`).set(auth(sessions.other))).status,
      (await api.delete(`/api/attachments/${attachment.id}`).set(auth(sessions.other))).status,
    ]
    expect(statuses).toEqual([404, 404, 404, 404])
  })

  test('another employee never gets the file, and nothing changes', async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [['a.png', FILES.png]])).body
    const res = await api.get(`/api/attachments/${attachment.id}/download`).set(auth(sessions.other))
    expect([403, 404]).toContain(res.status)
    expect(res.headers['content-disposition']).toBeUndefined()
    await api.delete(`/api/attachments/${attachment.id}`).set(auth(sessions.other))
    expect(await attachmentRows()).toHaveLength(1)
    expect(storedFiles()).toHaveLength(1)
  })

  const download = (session, id, query = '') =>
    api
      .get(`/api/attachments/${id}/download${query}`)
      .set(auth(session))
      .buffer(true)
      .parse((response, done) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => done(null, Buffer.concat(chunks)))
      })

  test.each(['png', 'jpg', 'gif', 'webp', 'pdf', 'txt', 'csv'])(
    '.%s: the exact bytes, as a download, with nosniff, no-store and Content-Length',
    async (ext) => {
      const { sessions, ticketId } = await setup()
      const content = FILES[ext]
      const [attachment] = (await upload(sessions.requester, ticketId, [[`Prüfung.${ext}`, content]])).body
      const res = await download(sessions.requester, attachment.id)
      expect(res.status).toBe(200)
      expect(res.body.equals(content)).toBe(true)
      expect(res.headers['content-disposition']).toMatch(/^attachment; /)
      expect(res.headers['content-disposition']).toContain(`filename*=UTF-8''Pr%C3%BCfung.${ext}`)
      expect(res.headers['content-type'].split(';')[0]).toBe(attachment.mime_type)
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['cache-control']).toBe('private, no-store')
      expect(res.headers['content-length']).toBe(String(content.length))
    },
  )

  // BUG: the download's Content-Security-Policy is the API-wide one from helmet in src/app.js
  // ("default-src 'none'; frame-ancestors 'none'"); it has no sandbox directive
  test.failing('BUG: a download is sent with Content-Security-Policy: sandbox', async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [['a.pdf', FILES.pdf]])).body
    const res = await download(sessions.requester, attachment.id)
    expect(res.headers['content-security-policy']).toMatch(/(^|;)\s*sandbox(\s|;|$)/)
  })

  // BUG: the download route ignores ?inline=1 and always sends Content-Disposition: attachment
  test.failing.each(['png', 'pdf'])('BUG: ?inline=1 shows a .%s inline', async (ext) => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [[`a.${ext}`, FILES[ext]]])).body
    const res = await download(sessions.requester, attachment.id, '?inline=1')
    expect(res.headers['content-disposition']).toMatch(/^inline/)
  })

  test.each(['txt', 'csv', 'log'])('?inline=1 never shows a .%s inline', async (ext) => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [[`a.${ext}`, FILES[ext]]])).body
    const res = await download(sessions.requester, attachment.id, '?inline=1')
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/^attachment; /)
  })

  test('there is no static URL for uploaded files', async () => {
    const { sessions, ticketId } = await setup()
    await upload(sessions.requester, ticketId, [['a.png', FILES.png]])
    const [row] = await attachmentRows()
    for (const url of [
      `/uploads/${row.stored_name}`,
      `/api/uploads/${row.stored_name}`,
      `/${row.stored_name}`,
      `/api/attachments/${row.stored_name}`,
      `/api/attachments/${row.stored_name}/download`,
    ]) {
      const res = await api.get(url).set(auth(sessions.requester))
      expect({ url, status: [400, 404].includes(res.status) }).toEqual({ url, status: true })
      expect(res.headers['content-type']).toMatch(/json/)
    }
  })

  test('a file missing on disk: 404, and the error is logged with the attachment id', async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [['a.png', FILES.png]])).body
    for (const file of storedFiles()) fs.rmSync(path.join(uploadDir(), file))
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await api.get(`/api/attachments/${attachment.id}/download`).set(auth(sessions.requester))
    const logged = errors.mock.calls.map((args) => args.join(' '))
    errors.mockRestore()
    expect(res.status).toBe(404)
    expect(logged).toEqual([expect.stringContaining(`Attachment ${attachment.id}`)])
  })

  // BUG: uploads take no comment_id (multer is set up with fields: 0, so any text field is 400 INVALID_UPLOAD); the
  // rule is that a comment from another ticket is refused with 422
  test.failing('BUG: a comment_id from another ticket is refused with 422', async () => {
    const { sessions, ticketId } = await setup()
    const [[category]] = await pool.query('SELECT id FROM categories LIMIT 1')
    const other = await api
      .post('/api/tickets')
      .set(auth(sessions.requester))
      .send({ title: 'Other', description: 'Another ticket', category_id: category.id })
    const comment = await api
      .post(`/api/tickets/${other.body.id}/comments`)
      .set(auth(sessions.requester))
      .send({ content: 'On the other ticket' })
    expect(comment.status).toBe(201)
    const res = await api
      .post(`/api/tickets/${ticketId}/attachments`)
      .set(auth(sessions.requester))
      .field('comment_id', String(comment.body.id))
      .attach('files', FILES.png, 'a.png')
    expect(res.status).toBe(422)
  })

  test('a comment_id from another ticket never attaches the file anywhere', async () => {
    const { sessions, ticketId } = await setup()
    const res = await api
      .post(`/api/tickets/${ticketId}/attachments`)
      .set(auth(sessions.requester))
      .field('comment_id', '999999')
      .attach('files', FILES.png, 'a.png')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expectNothingSaved(await attachmentRows(), storedFiles())
  })

  test('a download is streamed from disk, never read into memory whole', async () => {
    const { sessions, ticketId } = await setup()
    const [attachment] = (await upload(sessions.requester, ticketId, [['a.pdf', FILES.pdf]])).body
    const streams = jest.spyOn(fs, 'createReadStream')
    const readFile = jest.spyOn(fs.promises, 'readFile')
    const readFileSync = jest.spyOn(fs, 'readFileSync')
    const res = await download(sessions.requester, attachment.id)
    const calls = { streams: streams.mock.calls.length, readFile: readFile.mock.calls.length }
    const syncReads = readFileSync.mock.calls.filter(([file]) => String(file).startsWith(uploadDir())).length
    jest.restoreAllMocks()
    expect(res.body.equals(FILES.pdf)).toBe(true)
    expect(calls).toEqual({ streams: 1, readFile: 0 })
    expect(syncReads).toBe(0)
  })
})
