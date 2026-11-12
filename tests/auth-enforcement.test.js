// Tests for logging in and for must_change_password: self-registration is gone, login reports the flag and sets
// last_login_at, and a user with a temporary password is blocked everywhere except the allowlist. The route sweep
// walks every route the app mounts (src/routes/index.js), so a new route that skips requireAuth fails here.
const app = require('../src/app')
const pool = require('../src/db')
const apiRoutes = require('../src/routes')
const { ALLOWED_BEFORE_PASSWORD_CHANGE } = require('../src/middleware/auth')
const {
  api,
  resetData,
  createUser,
  loginAs,
  dbUser,
  dbSnapshot,
  expectError,
  expectNoPasswordHash,
  auth,
  sessionOf,
  inviteTokenFor,
  useEmail,
} = require('./helpers')

// Routes anyone may call without logging in
// (the set-password routes are for people who have no usable password: the emailed link's token is their proof)
const PUBLIC = [
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/health',
  'GET /api/auth/set-password/validate',
  'POST /api/auth/set-password',
  // Asking for a reset link by email: for people who can't log in
  'POST /api/auth/forgot-password',
  // The company name and whether email is set up, for the sign-in page (nothing private)
  'GET /api/settings/public',
  // What the sign-in page may offer (email_enabled)
  'GET /api/auth/config',
]
// What a user with a temporary password may still do. Pinned here so widening the list is a deliberate change.
const ALLOWED = ['GET /api/auth/me', 'POST /api/auth/change-password']

// "METHOD /full/path/:param" for every route in a router
function routesOf(prefix, router) {
  return router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) =>
        `${method.toUpperCase()} ${prefix}${layer.route.path}`.replace(/\/$/, ''),
      ),
    )
}

const ROUTES = [...routesOf('', app.router), ...apiRoutes.flatMap(([prefix, router]) => routesOf(prefix, router))]

// Sends the request with a made-up id (1) for each :param
function call(route, token) {
  const [method, pattern] = route.split(' ')
  const req = api[method.toLowerCase()](pattern.replace(/:\w+/g, '1'))
  return token ? req.set(auth(token)) : req
}

beforeEach(resetData)

describe('self-registration', () => {
  const SIGNUP = { name: 'Someone', email: 'someone@test.local', password: 'password123' }

  // Paths under /api/users are behind the login (401 before any route lookup); the others don't exist (404).
  // Either way nothing is created.
  test.each([
    ['/auth/register', true, 404],
    ['/auth/register', false, 404],
    ['/api/auth/register', true, 404],
    ['/api/auth/register', false, 404],
    ['/auth/signup', true, 404],
    ['/api/auth/signup', true, 404],
    ['/api/register', true, 404],
    ['/api/signup', true, 404],
    ['/api/users/register', true, 401],
    ['/api/users/signup', true, 401],
  ])(
    'no self-signup route: POST %s (with a body: %s) is refused with %i and creates nothing',
    async (path, withBody, status) => {
      const before = await dbSnapshot()
      const res = await (withBody ? api.post(path).send(SIGNUP) : api.post(path))
      if (status === 404) expectError(res, 404, undefined, `Route not found: POST ${path}`)
      else expectError(res, 401, undefined, 'Not logged in')
      expect(await dbSnapshot()).toEqual(before)
    },
  )

  test('creating an account without logging in (POST /api/users with no token) is 401 and creates nothing', async () => {
    const before = await dbSnapshot()
    const res = await api.post('/api/users').send({ name: 'Someone', email: 'someone@test.local', role: 'employee' })
    expectError(res, 401, undefined)
    expect(await dbSnapshot()).toEqual(before)
  })

  test('POST /api/auth/register returns 404 and creates nothing', async () => {
    const res = await api.post('/api/auth/register').send({
      name: 'Someone',
      email: 'someone@test.local',
      password: 'password123',
    })
    expect(res.status).toBe(404)
    expect(res.body.message).toMatch(/Route not found/)

    const login = await api.post('/api/auth/login').send({ email: 'someone@test.local', password: 'password123' })
    expect(login.status).toBe(401)
  })
})

describe('must_change_password', () => {
  test('login and /me return false for an account that has its own password', async () => {
    const user = await createUser()
    const login = await api.post('/api/auth/login').send({ email: user.email, password: user.password })
    expect(login.status).toBe(200)
    expect(login.body.user.must_change_password).toBe(false)
    expect(login.body.user).not.toHaveProperty('password_hash')

    const me = await api.get('/api/auth/me').set(auth(sessionOf(login)))
    expect(me.body.must_change_password).toBe(false)
  })

  test.each([
    ['a flagged user', true],
    ['a normal user', false],
  ])(
    'login returns { user } telling the client whether %s must change their password; no token in the body',
    async (_, flagged) => {
      const user = await createUser({ mustChangePassword: flagged })
      const login = await api.post('/api/auth/login').send({ email: user.email, password: user.password })
      expect(login.status).toBe(200)
      expect(Object.keys(login.body)).toEqual(['user'])
      expect(login.body.user.must_change_password).toBe(flagged)
      expect(sessionOf(login)).toEqual(expect.any(String)) // the session is the cookie
    },
  )

  test('a successful login sets last_login_at; a wrong password or a deactivated account does not', async () => {
    const user = await createUser()
    const inactive = await createUser({ isActive: false })
    const lastLogin = async (id) => (await dbUser(id)).last_login_at
    expect(await lastLogin(user.id)).toBeNull()

    expect((await api.post('/api/auth/login').send({ email: user.email, password: 'wrong-password1' })).status).toBe(
      401,
    )
    expect(await lastLogin(user.id)).toBeNull()
    expect(
      (await api.post('/api/auth/login').send({ email: inactive.email, password: inactive.password })).status,
    ).toBe(403)
    expect(await lastLogin(inactive.id)).toBeNull()

    const before = Date.now() - 2000 // the database clock rounds to whole seconds
    expect((await api.post('/api/auth/login').send({ email: user.email, password: user.password })).status).toBe(200)
    expect((await lastLogin(user.id)).getTime()).toBeGreaterThanOrEqual(before)
  })

  test('/me returns job_title, created_at and last_login_at, and never the password hash', async () => {
    const user = await createUser({ jobTitle: 'Accountant' })
    const login = await api.post('/api/auth/login').send({ email: user.email, password: user.password })
    const me = await api.get('/api/auth/me').set(auth(sessionOf(login)))
    expect(me.status).toBe(200)

    const stored = await dbUser(user.id)
    expect(me.body).toMatchObject({
      job_title: 'Accountant',
      created_at: stored.created_at.toISOString(),
      last_login_at: stored.last_login_at.toISOString(),
    })
    expectNoPasswordHash(me.body)
    // The user returned by login carries the login it just recorded, the same as /me
    expect(login.body.user).toMatchObject({
      job_title: 'Accountant',
      created_at: me.body.created_at,
      last_login_at: me.body.last_login_at,
    })
    expectNoPasswordHash(login.body.user)
  })

  test('/me returns null for an empty job title and a user who has never logged in', async () => {
    const user = await createUser()
    const token = await loginAs(user)
    // Clear the login loginAs just recorded, as for an account that has a token but no recorded login
    await pool.query('UPDATE users SET last_login_at = NULL WHERE id = ?', [user.id])

    const me = await api.get('/api/auth/me').set(auth(token))
    expect(me.status).toBe(200)
    expect(me.body).toHaveProperty('job_title', null)
    expect(me.body).toHaveProperty('last_login_at', null)
    expect(me.body.created_at).toEqual(expect.any(String))
  })

  test('an HR user can log in and /me shows the hr role', async () => {
    const hr = await createUser({ role: 'hr' })
    const token = await loginAs(hr)
    const me = await api.get('/api/auth/me').set(auth(token))
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ id: hr.id, role: 'hr', must_change_password: false })
  })
})

describe('blocking until a temporary password is changed', () => {
  const PASSWORD_CHANGE_REQUIRED = {
    message: 'You must change your password before continuing',
    code: 'PASSWORD_CHANGE_REQUIRED',
  }
  const get = (path, token) => api.get(path).set(auth(token))

  test('a flagged user can log in and use /me, but every other endpoint returns 403 PASSWORD_CHANGE_REQUIRED', async () => {
    const user = await createUser({ role: 'admin', mustChangePassword: true })
    const login = await api.post('/api/auth/login').send({ email: user.email, password: user.password })
    expect(login.status).toBe(200)
    expect(login.body.user.must_change_password).toBe(true)
    const token = sessionOf(login)

    expect((await get('/api/auth/me', token)).status).toBe(200)
    expect((await get('/api/auth/me/', token)).status).toBe(200)
    for (const path of ['/api/tickets', '/api/tickets?status=open', '/api/meta', '/api/users', '/api/stats']) {
      const res = await get(path, token)
      expect([path, res.status, res.body]).toEqual([path, 403, PASSWORD_CHANGE_REQUIRED])
    }
    const create = await api
      .post('/api/tickets')
      .set(auth(token))
      .send({ title: 'x', description: 'y', category_id: 1, priority_id: 1 })
    expect(create.status).toBe(403)
    expect(create.body.code).toBe('PASSWORD_CHANGE_REQUIRED')
  })

  test('after changing the password the same session works everywhere', async () => {
    const user = await createUser({ mustChangePassword: true })
    const token = await loginAs(user)
    expect((await get('/api/tickets', token)).status).toBe(403)

    const res = await api
      .post('/api/auth/change-password')
      .set(auth(token))
      .send({ currentPassword: user.password, newPassword: 'my-own-password9' })
    expect(res.status).toBe(200)
    expect((await get('/api/tickets', token)).status).toBe(200)
  })

  test('an account created by an admin (email not set up) is blocked until its temporary password is changed', async () => {
    const admin = await createUser({ role: 'admin' })
    const created = await api
      .post('/api/users')
      .set(auth(await loginAs(admin)))
      .send({ name: 'Temp Person', email: 'temp.person@test.local', role: 'employee' })
    const { temporaryPassword } = created.body
    expect(created.body.password_delivery).toBe('temporary_password')

    const login = await api
      .post('/api/auth/login')
      .send({ email: 'temp.person@test.local', password: temporaryPassword })
    expect((await get('/api/tickets', sessionOf(login))).body.code).toBe('PASSWORD_CHANGE_REQUIRED')

    const changed = await api
      .post('/api/auth/change-password')
      .set(auth(sessionOf(login)))
      .send({ currentPassword: temporaryPassword, newPassword: 'chosen-by-me1' })
    expect(changed.status).toBe(200)
    // The same session continues, now unblocked
    expect((await get('/api/tickets', sessionOf(login))).status).toBe(200)
  })

  test('an account created by an admin (email set up) has no usable password until the emailed link sets one', async () => {
    useEmail(true)
    const admin = await createUser({ role: 'admin' })
    const created = await api
      .post('/api/users')
      .set(auth(await loginAs(admin)))
      .send({ name: 'New Person', email: 'new.person@test.local', role: 'employee' })
    expect(created.status).toBe(201)

    // Nothing to log in with yet: the usual message, as for any wrong password
    const before = await api.post('/api/auth/login').send({ email: 'new.person@test.local', password: 'password123' })
    expectError(before, 401, undefined, 'Wrong email or password')

    const token = await inviteTokenFor('new.person@test.local')
    const set = await api.post('/api/auth/set-password').send({ token, new_password: 'chosen-by-me1' })
    expect(set.status).toBe(200)

    const login = await api.post('/api/auth/login').send({ email: 'new.person@test.local', password: 'chosen-by-me1' })
    expect(login.body.user.must_change_password).toBe(false)
    expect((await get('/api/tickets', sessionOf(login))).status).toBe(200)
  })

  test('an unflagged user is never blocked', async () => {
    const user = await createUser({ role: 'agent' })
    const token = await loginAs(user)
    for (const path of ['/api/auth/me', '/api/tickets', '/api/meta', '/api/users/agents']) {
      expect([path, (await get(path, token)).status]).toEqual([path, 200])
    }
  })

  test('other errors never leak a code (e.g. a 404 has only a message)', async () => {
    const res = await api.get('/api/nope')
    expect(res.status).toBe(404)
    expect(Object.keys(res.body)).toEqual(['message'])
  })
})

describe('the route list', () => {
  test('covers every router the app mounts, and the only app-level route is the health check', () => {
    const mountedRouters = app.router.stack.filter((layer) => layer.handle && layer.handle.stack)
    expect(mountedRouters).toHaveLength(apiRoutes.length)
    expect(routesOf('', app.router)).toEqual(['GET /api/health'])
  })

  test('finds all the routes, including the user-management ones', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(18)
    expect(ROUTES).toEqual(
      expect.arrayContaining([
        'PATCH /api/users/:id',
        'POST /api/users/:id/reset-password',
        'POST /api/tickets',
        'GET /api/stats',
      ]),
    )
  })

  test('the allowlist is exactly the expected two routes, and both exist', () => {
    expect(ALLOWED_BEFORE_PASSWORD_CHANGE).toEqual(ALLOWED)
    for (const route of ALLOWED) expect(ROUTES).toContain(route)
  })
})

describe('every route', () => {
  const protectedRoutes = ROUTES.filter((route) => !PUBLIC.includes(route))

  test('without a token returns 401', async () => {
    for (const route of protectedRoutes) {
      const res = await call(route)
      expect([route, res.status]).toEqual([route, 401])
    }
  })

  test('a user with a temporary password gets 403 PASSWORD_CHANGE_REQUIRED, except on the allowlist', async () => {
    // An admin, so a 403 can only come from the temporary password and not from a role check
    const token = await loginAs(await createUser({ role: 'admin', mustChangePassword: true }))

    for (const route of protectedRoutes) {
      const res = await call(route, token)
      if (ALLOWED.includes(route)) {
        expect([route, res.status, res.body.code]).not.toEqual([route, 403, 'PASSWORD_CHANGE_REQUIRED'])
      } else {
        expect([route, res.status, res.body]).toEqual([
          route,
          403,
          { message: 'You must change your password before continuing', code: 'PASSWORD_CHANGE_REQUIRED' },
        ])
      }
    }
  })

  test('a user without a temporary password is never told to change it', async () => {
    const admin = await createUser({ role: 'admin' })
    for (const route of protectedRoutes) {
      // A fresh session per route: some routes end the session (POST /api/auth/logout-all), and every later route
      // would then only see a 401 and test nothing
      const res = await call(route, await loginAs(admin))
      expect([route, res.body.code]).not.toEqual([route, 'PASSWORD_CHANGE_REQUIRED'])
      expect([route, res.status]).not.toEqual([route, 401])
    }
  })
})
