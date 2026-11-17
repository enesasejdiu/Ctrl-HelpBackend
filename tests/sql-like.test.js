// "Contains" searches take the text literally (src/sqlLike.js): % and _ typed by the user are characters, not
// wildcards. Unit-tested, and through GET /api/tickets?q=.
const { api, resetData, createUser, loginAs, auth } = require('./helpers')
const { likeContains } = require('../src/sqlLike')

test.each([
  ['printer', '%printer%'],
  ['50%', '%50!%%'],
  ['file_name', '%file!_name%'],
  ['wow!', '%wow!!%'],
])('likeContains(%j) is %j', (text, pattern) => {
  expect(likeContains(text)).toBe(pattern)
})

test('the ticket search finds "50%" and "a_b" as written', async () => {
  await resetData()
  const session = await loginAs(await createUser({ role: 'employee' }))
  const create = (title) =>
    api.post('/api/tickets').set(auth(session)).send({ title, description: 'Created by a test.', category_id: 1 })
  for (const title of ['Disk 50% full', 'Disk 5000 full', 'Rename a_b', 'Rename axb']) {
    expect((await create(title)).status).toBe(201)
  }
  const titles = async (q) =>
    (await api.get(`/api/tickets?q=${encodeURIComponent(q)}`).set(auth(session))).body.map((t) => t.title)
  expect(await titles('50%')).toEqual(['Disk 50% full'])
  expect(await titles('a_b')).toEqual(['Rename a_b'])
  expect((await titles('Disk')).sort()).toEqual(['Disk 50% full', 'Disk 5000 full'])
})
