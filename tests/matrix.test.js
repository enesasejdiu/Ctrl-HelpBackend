// The permission matrix: every user-management, auth and departments endpoint, called by nobody, an employee, HR, an
// admin, and a user who still has a temporary password (flagged). Every refusal (401/403/404) must leave the database
// exactly as it was, so each one compares a snapshot of every table before and after.
const {
  api,
  resetData,
  createUser,
  createCallers,
  createDepartment,
  dbSnapshot,
  expectError,
  expectNoPasswordHash,
  auth,
} = require('./helpers')

const NEW_PASSWORD = 'Matrix-new-pass1'
let uniqueCount = 0
const unique = (prefix) => `${prefix}-${(uniqueCount += 1)}`

// Everything a row needs: the callers, users to act on, and an empty department
let ctx
beforeEach(async () => {
  await resetData()
  const callers = await createCallers()
  ctx = {
    callers,
    targets: {
      employee: await createUser({ role: 'employee' }),
      hr: await createUser({ role: 'hr' }),
      admin: callers.admin2, // another admin, so "admin edits an admin" never touches the caller
    },
    emptyDepartment: await createDepartment(),
  }
})

// One row per endpoint (and target, where it matters). `expect` gives the status for each caller; a missing caller
// means the combination doesn't apply. `request(caller)` returns [method, path, body].
const ROWS = [
  {
    name: 'POST /auth/register',
    request: () => ['post', '/auth/register', { name: 'X', email: 'x@test.local', password: 'password123' }],
    expect: { none: 404, employee: 404, hr: 404, admin: 404, flagged: 404 },
  },
  {
    name: 'POST /api/auth/register',
    request: () => ['post', '/api/auth/register', { name: 'X', email: 'x@test.local', password: 'password123' }],
    expect: { none: 404, employee: 404, hr: 404, admin: 404, flagged: 404 },
  },

  ...['employee', 'hr', 'admin'].map((role) => ({
    name: `POST /api/users (role=${role})`,
    request: () => ['post', '/api/users', { name: 'New Person', email: `${unique('new')}@test.local`, role }],
    expect: { none: 401, employee: 403, hr: role === 'employee' ? 201 : 403, admin: 201 },
  })),

  {
    name: 'PATCH /api/users/:id (target employee, no role)',
    request: () => ['patch', `/api/users/${ctx.targets.employee.id}`, { name: 'Renamed' }],
    expect: { none: 401, employee: 403, hr: 200, admin: 200 },
  },
  {
    name: 'PATCH /api/users/:id (target hr)',
    request: () => ['patch', `/api/users/${ctx.targets.hr.id}`, { name: 'Renamed' }],
    expect: { none: 401, employee: 403, hr: 403, admin: 200 },
  },
  {
    name: 'PATCH /api/users/:id (target admin)',
    request: () => ['patch', `/api/users/${ctx.targets.admin.id}`, { name: 'Renamed' }],
    expect: { none: 401, employee: 403, hr: 403, admin: 200 },
  },
  {
    name: 'PATCH /api/users/:id (with role, target employee)',
    request: () => ['patch', `/api/users/${ctx.targets.employee.id}`, { role: 'agent' }],
    expect: { none: 401, employee: 403, hr: 403, admin: 200 },
  },
  {
    name: 'PATCH /api/users/:id (with an unchanged role)',
    request: () => ['patch', `/api/users/${ctx.targets.employee.id}`, { role: 'employee' }],
    expect: { none: 401, employee: 403, hr: 403, admin: 200 },
  },

  {
    name: 'POST /api/users/:id/reset-password (target employee)',
    request: () => ['post', `/api/users/${ctx.targets.employee.id}/reset-password`],
    expect: { none: 401, employee: 403, hr: 200, admin: 200 },
  },
  {
    name: 'POST /api/users/:id/reset-password (target hr)',
    request: () => ['post', `/api/users/${ctx.targets.hr.id}/reset-password`],
    expect: { none: 401, employee: 403, hr: 403, admin: 200 },
  },
  {
    name: 'POST /api/users/:id/reset-password (target admin)',
    request: () => ['post', `/api/users/${ctx.targets.admin.id}/reset-password`],
    expect: { none: 401, employee: 403, hr: 403, admin: 200 },
  },
  {
    name: 'POST /api/users/:id/reset-password (self)',
    request: (caller) => ['post', `/api/users/${caller.id}/reset-password`],
    expect: { employee: 403, hr: 403, admin: 403 },
  },

  {
    name: 'POST /api/auth/change-password',
    request: (caller) => [
      'post',
      '/api/auth/change-password',
      { currentPassword: caller ? caller.password : 'x', newPassword: NEW_PASSWORD },
    ],
    expect: { none: 401, employee: 200, hr: 200, admin: 200, flagged: 200 },
  },
  {
    name: 'GET /api/auth/me',
    request: () => ['get', '/api/auth/me'],
    expect: { none: 401, employee: 200, hr: 200, admin: 200, flagged: 200 },
  },

  {
    name: 'GET /api/departments',
    request: () => ['get', '/api/departments'],
    expect: { none: 401, employee: 200, hr: 200, admin: 200 },
  },
  {
    name: 'POST /api/departments',
    request: () => ['post', '/api/departments', { name: unique('Matrix department') }],
    expect: { none: 401, employee: 403, hr: 201, admin: 201 },
  },
  {
    name: 'PATCH /api/departments/:id',
    request: () => ['patch', `/api/departments/${ctx.emptyDepartment}`, { name: unique('Renamed department') }],
    expect: { none: 401, employee: 403, hr: 200, admin: 200 },
  },
  {
    name: 'DELETE /api/departments/:id',
    request: () => ['delete', `/api/departments/${ctx.emptyDepartment}`],
    expect: { none: 401, employee: 403, hr: 204, admin: 204 },
  },
]

// A flagged user gets 403 PASSWORD_CHANGE_REQUIRED everywhere except the allowlist (and unknown routes, which are 404)
for (const row of ROWS) {
  if (!('flagged' in row.expect)) row.expect.flagged = 403
}

const CASES = ROWS.flatMap((row) =>
  Object.entries(row.expect).map(([caller, status]) => [row.name, caller, status, row]),
)

describe('permission matrix', () => {
  test.each(CASES)('%s as %s → %i', async (_, callerName, status, row) => {
    const caller = callerName === 'none' ? null : ctx.callers[callerName]
    const [method, path, body] = row.request(caller)
    const before = await dbSnapshot()

    let req = api[method](path)
    if (caller) req = req.set(auth(caller.token))
    const res = await (body === undefined ? req : req.send(body))

    expect(res.status).toBe(status)
    expectNoPasswordHash(res.body)

    if (status >= 400) {
      // A refusal changes nothing, anywhere
      expect(await dbSnapshot()).toEqual(before)
      if (status === 403 && callerName === 'flagged') {
        expectError(res, 403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing')
      } else if (status === 401) {
        expectError(res, 401, undefined)
      } else if (status === 403) {
        expectError(res, 403, undefined) // a role refusal has a message and no code
      } else if (status === 404) {
        expectError(res, 404, undefined, `Route not found: ${method.toUpperCase()} ${path}`)
      }
    }
  })
})
