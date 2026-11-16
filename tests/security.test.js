// Request limits, CORS and security headers (src/app.js): bodies over 100 KB get 413 PAYLOAD_TOO_LARGE; only
// CLIENT_URL gets CORS headers, with the allowed methods and headers listed; helmet's headers for an API; HSTS and
// "trust proxy" only in production.
const request = require('supertest')
const { api } = require('./helpers')

const OTHER_ORIGIN = 'https://evil.example'
const kb = (n) => 'x'.repeat(n * 1024)

describe('request size limit', () => {
  test('a JSON body over 100 KB gets 413 PAYLOAD_TOO_LARGE with a clear message', async () => {
    const res = await api.post('/api/auth/login').send({ email: 'a@test.local', password: kb(101) })
    expect(res.status).toBe(413)
    expect(res.body).toEqual({ message: 'Request body is too large (at most 100 KB)', code: 'PAYLOAD_TOO_LARGE' })
  })

  test('a body just under the limit is read normally (not a 413: the login itself answers)', async () => {
    const res = await api.post('/api/auth/login').send({ email: 'a@test.local', password: kb(99) })
    expect(res.status).not.toBe(413)
    expect(res.body.code).not.toBe('PAYLOAD_TOO_LARGE')
  })
})

describe('CORS', () => {
  test('another origin gets no CORS headers at all', async () => {
    const res = await api.get('/api/health').set('Origin', OTHER_ORIGIN)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })

  test("another origin's preflight is not allowed either", async () => {
    const res = await api
      .options('/api/departments')
      .set('Origin', OTHER_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })

  test("the frontend's preflight lists exactly the allowed methods and headers, with credentials", async () => {
    const res = await api
      .options('/api/departments')
      .set('Origin', process.env.CLIENT_URL)
      .set('Access-Control-Request-Method', 'PATCH')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(process.env.CLIENT_URL)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST,PATCH,PUT,DELETE')
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type,X-CSRF-Token')
    expect(res.headers['access-control-max-age']).toBe('600')
  })

  test('an ordinary request from the frontend gets its origin back, never "*"', async () => {
    const res = await api.get('/api/health').set('Origin', process.env.CLIENT_URL)
    expect(res.headers['access-control-allow-origin']).toBe(process.env.CLIENT_URL)
    expect(res.headers.vary).toMatch(/Origin/)
  })
})

describe('security headers (development/test)', () => {
  let headers
  beforeAll(async () => {
    headers = (await api.get('/api/health')).headers
  })

  test('no X-Powered-By', () => {
    expect(headers['x-powered-by']).toBeUndefined()
  })

  test('a content security policy that allows nothing to load and no framing', () => {
    expect(headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'")
    expect(headers['x-frame-options']).toBe('DENY')
  })

  test('nosniff, no referrer, same-origin resource and opener policies', () => {
    expect(headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
      'cross-origin-opener-policy': 'same-origin',
    })
  })

  test('no HSTS outside production (it would lock http://localhost out in the browser)', () => {
    expect(headers['strict-transport-security']).toBeUndefined()
  })

  test('X-Forwarded-For is not trusted outside production', async () => {
    const app = require('../src/app')
    expect(app.get('trust proxy')).toBe(false)
  })
})

describe('in production (NODE_ENV=production)', () => {
  // src/app.js reads NODE_ENV once, so load a separate copy of the app with production settings
  let prodApp
  beforeAll(() => {
    const before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      jest.isolateModules(() => {
        prodApp = require('../src/app')
      })
    } finally {
      process.env.NODE_ENV = before
    }
  })
  afterAll(async () => {
    // The isolated copy has its own MySQL pool (never used here); close it so Jest exits cleanly
    let pool
    jest.isolateModules(() => {
      pool = require('../src/db')
    })
    await pool.end()
  })

  test('HSTS: HTTPS only for 180 days, including subdomains', async () => {
    const res = await request(prodApp).get('/api/health')
    expect(res.headers['strict-transport-security']).toBe('max-age=15552000; includeSubDomains')
  })

  test('trusts exactly one proxy hop by default, so req.ip is the real client behind nginx', () => {
    expect(prodApp.get('trust proxy')).toBe(1)
  })

  // A copy of the app in production with TRUST_PROXY_HOPS set; req.ip as the app sees it, through a test route
  function appWithHops(hops) {
    const before = { NODE_ENV: process.env.NODE_ENV, TRUST_PROXY_HOPS: process.env.TRUST_PROXY_HOPS }
    process.env.NODE_ENV = 'production'
    process.env.TRUST_PROXY_HOPS = hops
    let app
    let pool
    try {
      jest.isolateModules(() => {
        app = require('express')().set('trust proxy', require('../src/app').get('trust proxy'))
        pool = require('../src/db')
      })
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    app.get('/ip', (req, res) => res.json({ ip: req.ip }))
    return { app, pool }
  }

  test.each([
    // Caddy → nginx → API: Caddy writes the client, nginx appends Caddy; the socket is nginx
    ['2', '203.0.113.7, 172.18.0.7', '203.0.113.7'],
    // Only nginx: it appends the client; whatever the client sent before that is not believed
    ['1', '6.6.6.6, 203.0.113.7', '203.0.113.7'],
    // Not set: 1
    ['', '6.6.6.6, 203.0.113.7', '203.0.113.7'],
  ])('TRUST_PROXY_HOPS=%p with X-Forwarded-For "%s": req.ip is %s', async (hops, forwardedFor, expected) => {
    const { app, pool } = appWithHops(hops)
    try {
      const res = await request(app).get('/ip').set('X-Forwarded-For', forwardedFor)
      expect(res.body.ip).toBe(expected)
    } finally {
      await pool.end()
    }
  })

  test('still no X-Powered-By, and the same strict CSP', async () => {
    const res = await request(prodApp).get('/api/health')
    expect(res.headers['x-powered-by']).toBeUndefined()
    expect(res.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'")
  })
})
