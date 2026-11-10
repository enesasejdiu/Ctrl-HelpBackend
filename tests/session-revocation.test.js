// Ending sessions (users.session_version, migration 007): every token carries the version it was issued with, and
// requireAuth refuses it once the user's version has moved on. A password change, a password reset, deactivation and
// a role change raise the version; logout and ordinary edits don't. The person who changes their own password gets a
// fresh session straight away.
const jwt = require('jsonwebtoken')
const pool = require('../src/db')
const { api, resetData, createUser, loginAs, auth, dbUser, expectError } = require('./helpers')

beforeEach(resetData)

const ENDED = 'Session expired, please log in again'

// Set-Cookie headers → { name: value }
function cookiesOf(res) {
  const cookies = {}
  for (const line of res.headers['set-cookie'] || []) {
    const [pair] = line.split(';')
    const [name, ...value] = pair.trim().split('=')
    cookies[name] = decodeURIComponent(value.join('='))
  }
  return cookies
}

// Logs in like the browser does and returns its two cookies
async function browserLogin(user, password = user.password) {
  const res = await api.post('/api/auth/login').send({ email: user.email, password })
  expect(res.status).toBe(200)
  const { tf_session: session, tf_csrf: csrf } = cookiesOf(res)
  return { session, csrf }
}

// A request from that browser: the session cookie, plus the CSRF header for changes
const asBrowser = (req, { session, csrf }) =>
  req.set('Cookie', `tf_session=${session}; tf_csrf=${csrf}`).set('X-CSRF-Token', csrf)

const me = (token) => api.get('/api/auth/me').set(auth(token))
const browserMe = (browser) => asBrowser(api.get('/api/auth/me'), browser)
const patchUser = (id, token, body) => api.patch(`/api/users/${id}`).set(auth(token)).send(body)

describe('changing your own password', () => {
  test('in the browser: the changing browser gets fresh cookies and stays logged in; its old cookie is ended', async () => {
    const user = await createUser()
    const browser = await browserLogin(user)

    const res = await asBrowser(api.post('/api/auth/change-password'), browser).send({
      currentPassword: user.password,
      newPassword: 'Brand-new-pass1',
    })
    expect(res.status).toBe(200)
    const fresh = cookiesOf(res)
    expect(fresh.tf_session).toBe(res.body.token)
    expect(fresh.tf_csrf).toMatch(/^[0-9a-f]{64}$/)

    const freshBrowser = { session: fresh.tf_session, csrf: fresh.tf_csrf }
    expect((await browserMe(freshBrowser)).status).toBe(200)
    // A change (POST) works too, so the new CSRF cookie is accepted
    const ticket = await asBrowser(api.post('/api/tickets'), freshBrowser).send({
      title: 'Printer broken',
      description: 'It prints blank pages',
      category_id: 1,
      priority_id: 1,
    })
    expect(ticket.status).toBe(201)

    expectError(await browserMe(browser), 401, undefined, ENDED)
  })

  test("ends the user's sessions in other browsers and devices", async () => {
    const user = await createUser()
    const laptop = await browserLogin(user)
    const phone = await browserLogin(user)
    const script = await loginAs(user)

    const res = await asBrowser(api.post('/api/auth/change-password'), laptop).send({
      currentPassword: user.password,
      newPassword: 'Brand-new-pass1',
    })
    expect(res.status).toBe(200)

    expectError(await browserMe(phone), 401, undefined, ENDED)
    expectError(await me(script), 401, undefined, ENDED)
  })

  test("doesn't end anyone else's sessions", async () => {
    const user = await createUser()
    const colleague = await createUser()
    const colleagueToken = await loginAs(colleague)
    const res = await api
      .post('/api/auth/change-password')
      .set(auth(await loginAs(user)))
      .send({ currentPassword: user.password, newPassword: 'Brand-new-pass1' })
    expect(res.status).toBe(200)
    expect((await me(colleagueToken)).status).toBe(200)
  })

  test('a wrong current password ends nothing', async () => {
    const user = await createUser()
    const token = await loginAs(user)
    const other = await loginAs(user)
    const res = await api
      .post('/api/auth/change-password')
      .set(auth(token))
      .send({ currentPassword: 'Not-my-password1', newPassword: 'Brand-new-pass1' })
    expect(res.status).toBe(400)
    expect((await me(token)).status).toBe(200)
    expect((await me(other)).status).toBe(200)
    expect((await dbUser(user.id)).session_version).toBe(0)
  })

  test('raises session_version by exactly 1', async () => {
    const user = await createUser()
    await api
      .post('/api/auth/change-password')
      .set(auth(await loginAs(user)))
      .send({ currentPassword: user.password, newPassword: 'Brand-new-pass1' })
    expect((await dbUser(user.id)).session_version).toBe(1)
  })
})

describe('password reset by an admin or HR', () => {
  test.each(['admin', 'hr'])('a reset by %s ends every session of the user, browser and token alike', async (role) => {
    const resetter = await createUser({ role })
    const target = await createUser()
    const browser = await browserLogin(target)
    const token = await loginAs(target)

    const res = await api
      .post(`/api/users/${target.id}/reset-password`)
      .set(auth(await loginAs(resetter)))
      .send()
    expect(res.status).toBe(200)

    expectError(await browserMe(browser), 401, undefined, ENDED)
    expectError(await me(token), 401, undefined, ENDED)
    // The user logs in again with the temporary password
    const login = await api.post('/api/auth/login').send({ email: target.email, password: res.body.temporaryPassword })
    expect((await me(login.body.token)).status).toBe(200)
  })

  test("doesn't end the resetter's own session", async () => {
    const admin = await createUser({ role: 'admin' })
    const adminToken = await loginAs(admin)
    const target = await createUser()
    await api.post(`/api/users/${target.id}/reset-password`).set(auth(adminToken)).send()
    expect((await me(adminToken)).status).toBe(200)
  })
})

describe('deactivation and reactivation', () => {
  test("deactivating a user ends their sessions, and reactivating doesn't bring the old ones back", async () => {
    const adminToken = await loginAs(await createUser({ role: 'admin' }))
    const target = await createUser({ role: 'agent' })
    const browser = await browserLogin(target)
    const token = await loginAs(target)

    expect((await patchUser(target.id, adminToken, { is_active: false })).status).toBe(200)
    expectError(await browserMe(browser), 401, undefined, ENDED)
    expectError(await me(token), 401, undefined, ENDED)

    expect((await patchUser(target.id, adminToken, { is_active: true })).status).toBe(200)
    expectError(await browserMe(browser), 401, undefined, ENDED)
    expectError(await me(token), 401, undefined, ENDED)
    // A new login works again
    expect((await me(await loginAs(target))).status).toBe(200)
  })

  test('HR deactivating an employee ends their sessions', async () => {
    const hrToken = await loginAs(await createUser({ role: 'hr' }))
    const target = await createUser()
    const token = await loginAs(target)
    expect((await patchUser(target.id, hrToken, { is_active: false })).status).toBe(200)
    expectError(await me(token), 401, undefined, ENDED)
  })

  test('reactivating raises nothing: a login made while inactive is impossible, and the version stays', async () => {
    const adminToken = await loginAs(await createUser({ role: 'admin' }))
    const target = await createUser({ isActive: false })
    await patchUser(target.id, adminToken, { is_active: true })
    expect((await dbUser(target.id)).session_version).toBe(0)
  })

  test('deactivating an account that is already inactive raises nothing', async () => {
    const adminToken = await loginAs(await createUser({ role: 'admin' }))
    const target = await createUser({ isActive: false })
    expect((await patchUser(target.id, adminToken, { is_active: false })).status).toBe(200)
    expect((await dbUser(target.id)).session_version).toBe(0)
  })
})

describe('role change', () => {
  test("changing a user's role ends their sessions; the new login carries the new role", async () => {
    const adminToken = await loginAs(await createUser({ role: 'admin' }))
    const target = await createUser({ role: 'agent' })
    const browser = await browserLogin(target)
    const token = await loginAs(target)

    expect((await patchUser(target.id, adminToken, { role: 'employee' })).status).toBe(200)
    expectError(await browserMe(browser), 401, undefined, ENDED)
    expectError(await me(token), 401, undefined, ENDED)

    const login = await api.post('/api/auth/login').send({ email: target.email, password: target.password })
    expect(jwt.decode(login.body.token).role).toBe('employee')
    expect((await me(login.body.token)).body.role).toBe('employee')
  })

  test('a promotion ends the old sessions too', async () => {
    const adminToken = await loginAs(await createUser({ role: 'admin' }))
    const target = await createUser({ role: 'employee' })
    const token = await loginAs(target)
    expect((await patchUser(target.id, adminToken, { role: 'agent' })).status).toBe(200)
    expectError(await me(token), 401, undefined, ENDED)
  })

  test('sending the role the user already has ends nothing', async () => {
    const adminToken = await loginAs(await createUser({ role: 'admin' }))
    const target = await createUser({ role: 'agent' })
    const token = await loginAs(target)
    expect((await patchUser(target.id, adminToken, { role: 'agent' })).status).toBe(200)
    expect((await me(token)).status).toBe(200)
    expect((await dbUser(target.id)).session_version).toBe(0)
  })

  test('a refused role change ends nothing: HR sending a role (403)', async () => {
    const hrToken = await loginAs(await createUser({ role: 'hr' }))
    const target = await createUser()
    const token = await loginAs(target)
    expect((await patchUser(target.id, hrToken, { role: 'agent' })).status).toBe(403)
    expect((await me(token)).status).toBe(200)
    expect((await dbUser(target.id)).session_version).toBe(0)
  })

  test('a refused role change ends nothing: an admin changing their own role (403)', async () => {
    const admin = await createUser({ role: 'admin' })
    const adminToken = await loginAs(admin)
    expect((await patchUser(admin.id, adminToken, { role: 'employee' })).status).toBe(403)
    expect((await me(adminToken)).status).toBe(200)
    expect((await dbUser(admin.id)).session_version).toBe(0)
  })
})

describe('what does not end sessions', () => {
  test("logout ends only that browser's cookie, not the user's other sessions", async () => {
    const user = await createUser()
    const laptop = await browserLogin(user)
    const phone = await browserLogin(user)

    const res = await asBrowser(api.post('/api/auth/logout'), laptop).send()
    expect(res.status).toBe(204)
    expect((await browserMe(phone)).status).toBe(200)
    expect((await dbUser(user.id)).session_version).toBe(0)
  })

  test('editing name, email, department or job title ends nothing', async () => {
    const adminToken = await loginAs(await createUser({ role: 'admin' }))
    const target = await createUser()
    const token = await loginAs(target)
    const res = await patchUser(target.id, adminToken, {
      name: 'Renamed Person',
      email: 'renamed@test.local',
      job_title: 'Accountant',
    })
    expect(res.status).toBe(200)
    expect((await me(token)).status).toBe(200)
    expect((await dbUser(target.id)).session_version).toBe(0)
  })
})

describe('the session_version check in requireAuth', () => {
  test('a token from before migration 007 (no session_version) works while the version is 0', async () => {
    const user = await createUser()
    const oldStyle = jwt.sign({ id: user.id, name: user.name, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    })
    expect((await me(oldStyle)).status).toBe(200)

    await pool.query('UPDATE users SET session_version = 1 WHERE id = ?', [user.id])
    expectError(await me(oldStyle), 401, undefined, ENDED)
  })

  test('a token with a different version is refused, even a higher one', async () => {
    const user = await createUser()
    const sign = (version) =>
      jwt.sign({ id: user.id, name: user.name, role: user.role, session_version: version }, process.env.JWT_SECRET, {
        expiresIn: '1h',
      })
    expect((await me(sign(0))).status).toBe(200)
    expectError(await me(sign(1)), 401, undefined, ENDED)
  })

  test('login puts the current version in the token', async () => {
    const user = await createUser()
    await pool.query('UPDATE users SET session_version = 4 WHERE id = ?', [user.id])
    const token = await loginAs(user)
    expect(jwt.decode(token).session_version).toBe(4)
    expect((await me(token)).status).toBe(200)
  })
})
