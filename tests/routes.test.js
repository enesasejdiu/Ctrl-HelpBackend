// Walks every route the app has (from src/routes/index.js, the list app.js mounts) and checks that each one needs a
// login and blocks users who still have a temporary password. A new route that skips requireAuth fails here.
const app = require('../src/app');
const apiRoutes = require('../src/routes');
const { ALLOWED_BEFORE_PASSWORD_CHANGE } = require('../src/middleware/auth');
const { api, resetData, createUser, loginAs } = require('./helpers');

// Routes anyone may call without logging in
const PUBLIC = ['POST /api/auth/login', 'GET /api/health'];
// What a user with a temporary password may still do. Pinned here so widening the list is a deliberate change.
const ALLOWED = ['GET /api/auth/me', 'POST /api/auth/change-password'];

// "METHOD /full/path/:param" for every route in a router
function routesOf(prefix, router) {
  return router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${prefix}${layer.route.path}`.replace(/\/$/, ''))
    );
}

const ROUTES = [
  ...routesOf('', app.router),
  ...apiRoutes.flatMap(([prefix, router]) => routesOf(prefix, router)),
];

// Sends the request with a made-up id (1) for each :param
function call(route, token) {
  const [method, pattern] = route.split(' ');
  const req = api[method.toLowerCase()](pattern.replace(/:\w+/g, '1'));
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
}

beforeEach(resetData);

describe('the route list', () => {
  test('covers every router the app mounts, and the only app-level route is the health check', () => {
    const mountedRouters = app.router.stack.filter((layer) => layer.handle && layer.handle.stack);
    expect(mountedRouters).toHaveLength(apiRoutes.length);
    expect(routesOf('', app.router)).toEqual(['GET /api/health']);
  });

  test('finds all the routes, including the user-management ones', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(18);
    expect(ROUTES).toEqual(
      expect.arrayContaining(['PATCH /api/users/:id', 'POST /api/users/:id/reset-password', 'POST /api/tickets', 'GET /api/stats'])
    );
  });

  test('the allowlist is exactly the expected two routes, and both exist', () => {
    expect(ALLOWED_BEFORE_PASSWORD_CHANGE).toEqual(ALLOWED);
    for (const route of ALLOWED) expect(ROUTES).toContain(route);
  });
});

describe('every route', () => {
  const protectedRoutes = ROUTES.filter((route) => !PUBLIC.includes(route));

  test('without a token returns 401', async () => {
    for (const route of protectedRoutes) {
      const res = await call(route);
      expect([route, res.status]).toEqual([route, 401]);
    }
  });

  test('a user with a temporary password gets 403 PASSWORD_CHANGE_REQUIRED, except on the allowlist', async () => {
    // An admin, so a 403 can only come from the temporary password and not from a role check
    const token = await loginAs(await createUser({ role: 'admin', mustChangePassword: true }));

    for (const route of protectedRoutes) {
      const res = await call(route, token);
      if (ALLOWED.includes(route)) {
        expect([route, res.status, res.body.code]).not.toEqual([route, 403, 'PASSWORD_CHANGE_REQUIRED']);
      } else {
        expect([route, res.status, res.body]).toEqual([
          route,
          403,
          { message: 'You must change your password before continuing', code: 'PASSWORD_CHANGE_REQUIRED' },
        ]);
      }
    }
  });

  test('a user without a temporary password is never told to change it', async () => {
    const token = await loginAs(await createUser({ role: 'admin' }));
    for (const route of protectedRoutes) {
      const res = await call(route, token);
      expect([route, res.body.code]).not.toEqual([route, 'PASSWORD_CHANGE_REQUIRED']);
    }
  });
});
