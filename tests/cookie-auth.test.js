// Cookie sessions with CSRF protection (src/session.js, middleware/auth.js): login sets the httpOnly tf_session cookie
// and the readable tf_csrf cookie; requireAuth reads the cookie first and falls back to the Bearer header (for now);
// cookie-authenticated changes need X-CSRF-Token = tf_csrf; logout clears both cookies; CORS allows only CLIENT_URL,
// with credentials.
const jwt = require('jsonwebtoken')
const request = require('supertest')
const app = require('../src/app')
const { api, createUser, createDepartment, auth } = require('./helpers')

const EIGHT_HOURS = 8 * 60 * 60

// Set-Cookie headers → { name: { value, flags: Set of lower-case attribute names, attrs: { name: value } } }
function cookiesOf(res) {
  const cookies = {}
  for (const line of res.headers['set-cookie'] || []) {
    const [pair, ...attributes] = line.split(';').map((part) => part.trim())
    const [name, ...value] = pair.split('=')
    const attrs = {}
    for (const attribute of attributes) {
      const [key, ...rest] = attribute.split('=')
      attrs[key.toLowerCase()] = rest.join('=')
    }
    cookies[name] = { value: decodeURIComponent(value.join('=')), flags: new Set(Object.keys(attrs)), attrs }
  }
  return cookies
}

// Logs in and returns the token from the body and the two cookie values
async function loginWithCookies(user) {
  const res = await api.post('/api/auth/login').send({ email: user.email, password: user.password })
  expect(res.status).toBe(200)
  const cookies = cookiesOf(res)
  return { token: res.body.token, session: cookies.tf_session.value, csrf: cookies.tf_csrf.value }
}

const cookieHeader = (values) =>
  Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')

describe('login sets the session cookies', () => {
  test('tf_session: the token, httpOnly, SameSite=Lax, path /, 8 hours, not Secure outside production', async () => {
    const user = await createUser()
    const res = await api.post('/api/auth/login').send({ email: user.email, password: user.password })
    const { tf_session: session } = cookiesOf(res)

    expect(session.value).toBe(res.body.token)
    expect(session.flags.has('httponly')).toBe(true)
    expect(session.attrs.samesite).toBe('Lax')
    expect(session.attrs.path).toBe('/')
    expect(session.attrs['max-age']).toBe(String(EIGHT_HOURS))
    expect(session.flags.has('secure')).toBe(false)
  })

  test('tf_csrf: a random value scripts can read (not httpOnly), same SameSite, path and lifetime', async () => {
    const user = await createUser()
    const first = cookiesOf(await api.post('/api/auth/login').send({ email: user.email, password: user.password }))
    const second = cookiesOf(await api.post('/api/auth/login').send({ email: user.email, password: user.password }))

    expect(first.tf_csrf.value).toMatch(/^[0-9a-f]{64}$/)
    expect(second.tf_csrf.value).not.toBe(first.tf_csrf.value)
    expect(first.tf_csrf.flags.has('httponly')).toBe(false)
    expect(first.tf_csrf.attrs).toMatchObject({ samesite: 'Lax', path: '/', 'max-age': String(EIGHT_HOURS) })
  })

  test('both cookies are Secure when NODE_ENV=production', async () => {
    const user = await createUser()
    process.env.NODE_ENV = 'production'
    try {
      const cookies = cookiesOf(await api.post('/api/auth/login').send({ email: user.email, password: user.password }))
      expect(cookies.tf_session.flags.has('secure')).toBe(true)
      expect(cookies.tf_csrf.flags.has('secure')).toBe(true)
    } finally {
      process.env.NODE_ENV = 'test'
    }
  })

  test('the body still has { token, user }, and the token is valid for 8 hours', async () => {
    const user = await createUser()
    const res = await api.post('/api/auth/login').send({ email: user.email, password: user.password })

    expect(res.body).toMatchObject({ token: expect.any(String), user: { id: user.id } })
    const { iat, exp } = jwt.decode(res.body.token)
    expect(exp - iat).toBe(EIGHT_HOURS)
  })

  test('a failed login sets no cookies', async () => {
    const user = await createUser()
    const res = await api.post('/api/auth/login').send({ email: user.email, password: 'wrong-password1' })
    expect(res.status).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
  })
})

describe('authenticating', () => {
  test('the cookie alone is enough for a GET', async () => {
    const user = await createUser()
    const { session } = await loginWithCookies(user)

    const me = await api.get('/api/auth/me').set('Cookie', cookieHeader({ tf_session: session }))
    expect(me.status).toBe(200)
    expect(me.body.id).toBe(user.id)
  })

  test('the Bearer header still works, and its changes need no CSRF header', async () => {
    const admin = await createUser({ role: 'admin' })
    const { token } = await loginWithCookies(admin)

    expect((await api.get('/api/auth/me').set(auth(token))).status).toBe(200)
    const created = await api.post('/api/departments').set(auth(token)).send({ name: 'Bearer Dept' })
    expect(created.status).toBe(201)
  })

  test("a Bearer header wins over the cookie: the request runs as the header's user, with no CSRF check", async () => {
    // Like Postman or Playwright's API helper: it kept the cookie from an earlier login, but sends another token
    const admin = await createUser({ role: 'admin' })
    const employee = await createUser()
    const { token: adminToken } = await loginWithCookies(admin)
    const { session: employeeSession, csrf } = await loginWithCookies(employee)
    const cookies = cookieHeader({ tf_session: employeeSession, tf_csrf: csrf })

    const me = await api.get('/api/auth/me').set(auth(adminToken)).set('Cookie', cookies)
    expect(me.body.id).toBe(admin.id)
    const created = await api
      .post('/api/departments')
      .set(auth(adminToken))
      .set('Cookie', cookies)
      .send({ name: 'Header Dept' })
    expect(created.status).toBe(201)
  })

  test('an invalid Bearer header is a 401 even with a valid cookie (no falling back)', async () => {
    const user = await createUser()
    const { session } = await loginWithCookies(user)

    const res = await api
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not-a-token')
      .set('Cookie', `tf_session=${session}`)
    expect(res.status).toBe(401)
  })

  test("an Authorization header that isn't Bearer is ignored: the cookie is used", async () => {
    const user = await createUser()
    const { session } = await loginWithCookies(user)

    const res = await api.get('/api/auth/me').set('Authorization', 'Basic abc').set('Cookie', `tf_session=${session}`)
    expect(res.status).toBe(200)
  })

  test.each([
    ['cookie', (token) => ['Cookie', `tf_session=${token}`]],
    ['Bearer header', (token) => ['Authorization', `Bearer ${token}`]],
  ])('an expired token in the %s is a 401', async (_, header) => {
    const user = await createUser()
    const expired = jwt.sign({ id: user.id, name: user.name, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: -10,
    })

    const res = await api.get('/api/auth/me').set(...header(expired))
    expect(res.status).toBe(401)
    expect(res.body.message).toBe('Session expired, please log in again')
  })

  test('no cookie and no header is a 401', async () => {
    expect((await api.get('/api/auth/me')).status).toBe(401)
  })
})

describe('CSRF: changes authenticated by the cookie need X-CSRF-Token', () => {
  const CSRF_INVALID = {
    message: 'Missing or invalid CSRF token. Reload the page and try again.',
    code: 'CSRF_INVALID',
  }
  let session
  let csrf
  let cookies

  beforeEach(async () => {
    ;({ session, csrf } = await loginWithCookies(await createUser({ role: 'admin' })))
    cookies = cookieHeader({ tf_session: session, tf_csrf: csrf })
  })

  test('a POST without the header is refused with 403 CSRF_INVALID, and nothing is created', async () => {
    const res = await api.post('/api/departments').set('Cookie', cookies).send({ name: 'No Token Dept' })
    expect(res.status).toBe(403)
    expect(res.body).toEqual(CSRF_INVALID)
    const list = await api.get('/api/departments').set('Cookie', cookies)
    expect(list.body.map((d) => d.name)).not.toContain('No Token Dept')
  })

  test('a POST with a wrong header is refused', async () => {
    const wrong = csrf.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))
    const res = await api.post('/api/departments').set('Cookie', cookies).set('X-CSRF-Token', wrong).send({ name: 'X' })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('CSRF_INVALID')
  })

  test('a header without the tf_csrf cookie is refused (it has to match the cookie)', async () => {
    const res = await api
      .post('/api/departments')
      .set('Cookie', cookieHeader({ tf_session: session }))
      .set('X-CSRF-Token', csrf)
      .send({ name: 'X' })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('CSRF_INVALID')
  })

  test('POST, PATCH and DELETE with the right header work', async () => {
    const withCsrf = (req) => req.set('Cookie', cookies).set('X-CSRF-Token', csrf)

    const created = await withCsrf(api.post('/api/departments')).send({ name: 'Cookie Dept' })
    expect(created.status).toBe(201)
    const renamed = await withCsrf(api.patch(`/api/departments/${created.body.id}`)).send({ name: 'Cookie Dept 2' })
    expect(renamed.status).toBe(200)
    const deleted = await withCsrf(api.delete(`/api/departments/${created.body.id}`))
    expect(deleted.status).toBe(204)
  })

  test.each(['patch', 'delete'])('%s without the header is refused too', async (method) => {
    const id = await createDepartment()
    const req = api[method](`/api/departments/${id}`).set('Cookie', cookies)
    const res = method === 'patch' ? await req.send({ name: 'Renamed' }) : await req
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('CSRF_INVALID')
  })

  test('GETs need no header', async () => {
    expect((await api.get('/api/departments').set('Cookie', cookies)).status).toBe(200)
  })

  test('login itself needs no header', async () => {
    const user = await createUser()
    const res = await api
      .post('/api/auth/login')
      .set('Cookie', cookies)
      .send({ email: user.email, password: user.password })
    expect(res.status).toBe(200)
  })
})

describe('POST /api/auth/logout', () => {
  test('clears both cookies (204), and the next request is a 401', async () => {
    const user = await createUser()
    const agent = request.agent(app) // keeps cookies between requests, like a browser
    expect((await agent.post('/api/auth/login').send({ email: user.email, password: user.password })).status).toBe(200)
    expect((await agent.get('/api/auth/me')).status).toBe(200)

    const res = await agent.post('/api/auth/logout')
    expect(res.status).toBe(204)
    const cleared = cookiesOf(res)
    for (const name of ['tf_session', 'tf_csrf']) {
      expect(cleared[name].value).toBe('')
      expect(new Date(cleared[name].attrs.expires).getTime()).toBeLessThan(Date.now())
      expect(cleared[name].attrs.path).toBe('/')
    }
    expect(cleared.tf_session.flags.has('httponly')).toBe(true)

    expect((await agent.get('/api/auth/me')).status).toBe(401)
  })

  test('works without a session, and with an expired one', async () => {
    expect((await api.post('/api/auth/logout')).status).toBe(204)
    expect((await api.post('/api/auth/logout').set('Cookie', 'tf_session=expired-or-garbage')).status).toBe(204)
  })
})

describe('CORS', () => {
  test('allows the frontend origin with credentials', async () => {
    const res = await api.get('/api/health').set('Origin', process.env.CLIENT_URL)
    expect(res.headers['access-control-allow-origin']).toBe(process.env.CLIENT_URL)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  test('never allows other origins, and never "*"', async () => {
    const res = await api.get('/api/health').set('Origin', 'https://evil.example')
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example')
    expect(res.headers['access-control-allow-origin']).not.toBe('*')
  })

  test('the preflight allows the X-CSRF-Token header for the frontend', async () => {
    const res = await api
      .options('/api/departments')
      .set('Origin', process.env.CLIENT_URL)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-headers']).toMatch(/x-csrf-token/i)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })
})
