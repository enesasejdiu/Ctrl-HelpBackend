// The API documentation (src/docs/swagger.js): every route the app has is in the OpenAPI spec, the spec is valid, and
// the docs page gets its own content security policy while the API keeps default-src 'none'.
const SwaggerParser = require('@apidevtools/swagger-parser')
const { api } = require('./helpers')
const app = require('../src/app')
const apiRoutes = require('../src/routes')
const { spec } = require('../src/docs/swagger')

// "METHOD /path" for every route of a router, with :param written as OpenAPI's {param}
function routesOf(prefix, router) {
  return router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) =>
        `${method.toUpperCase()} ${prefix}${layer.route.path}`.replace(/\/$/, '').replace(/:(\w+)/g, '{$1}'),
      ),
    )
}

const realRoutes = [
  ...routesOf('', app.router).filter((route) => !route.includes('/api-docs')),
  ...apiRoutes.flatMap(([prefix, router]) => routesOf(prefix, router)),
].sort()
const documented = Object.entries(spec.paths)
  .flatMap(([path, operations]) => Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`))
  .sort()

describe('the OpenAPI spec', () => {
  test('documents exactly the routes the app has (add an @openapi block to every new route)', () => {
    expect(documented).toEqual(realRoutes)
  })

  test('is a valid OpenAPI 3 document', async () => {
    await expect(SwaggerParser.validate(structuredClone(spec))).resolves.toBeDefined()
  })

  test('every change outside the public routes asks for the CSRF header', () => {
    const writes = Object.entries(spec.paths).flatMap(([path, operations]) =>
      Object.entries(operations)
        .filter(([method, op]) => ['post', 'patch', 'put', 'delete'].includes(method) && op.security?.length !== 0)
        .map(([method, op]) => [`${method.toUpperCase()} ${path}`, JSON.stringify(op.security)]),
    )
    for (const [route, security] of writes) {
      expect([route, security]).toEqual([route, JSON.stringify([{ cookieAuth: [], csrfToken: [] }])])
    }
  })
})

describe('serving the docs', () => {
  test('GET /api-docs.json is the spec, without a login', async () => {
    const res = await api.get('/api-docs.json')
    expect(res.status).toBe(200)
    expect(res.body.info.title).toBe('IT Helpdesk API')
    expect(Object.keys(res.body.paths)).toEqual(Object.keys(spec.paths))
  })

  test('GET /api-docs/ is the Swagger UI page, with a policy that lets it load its own scripts only', async () => {
    const res = await api.get('/api-docs/')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.text).toContain('swagger-ui-bundle.js')
    const csp = res.headers['content-security-policy']
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toMatch(/script-src[^;]*unsafe/)
  })

  test('the API itself keeps its strict policy', async () => {
    const res = await api.get('/api/health')
    expect(res.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'")
  })
})
