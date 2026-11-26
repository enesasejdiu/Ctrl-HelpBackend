// The audit log, for admins only. Mounted at /api/audit. See "Audit log" in README.md for the exact contract.
const express = require('express')
const { requireAuth, requireRole } = require('../middleware/auth')
const validate = require('../middleware/validate')
const schemas = require('../schemas/audit')
const { AUDIT_ACTIONS, listAudit } = require('../audit')

const router = express.Router()

router.use(requireAuth, requireRole('admin'))

// GET /api/audit?user=&action=&from=&to=&page=&pageSize= → { entries, total, page, pageSize }, newest first
/**
 * @openapi
 * /api/audit:
 *   get:
 *     tags: [Audit]
 *     summary: Read the audit log
 *     description: |
 *       **Roles:** `admin`. Logins, password and account changes, attachment uploads/deletes, knowledge-base and
 *       shared canned-response changes, newest first. Always paged. Filters are optional; an empty value means none.
 *     parameters:
 *       - name: user
 *         in: query
 *         description: A user id; entries where this user did something OR something was done to them
 *         schema: { type: integer, minimum: 1, example: 4 }
 *       - name: action
 *         in: query
 *         schema: { $ref: '#/components/schemas/AuditAction' }
 *       - name: from
 *         in: query
 *         description: First day, inclusive (server time zone)
 *         schema: { type: string, format: date, example: '2026-11-01' }
 *       - name: to
 *         in: query
 *         description: Last day, inclusive; must not be before `from`
 *         schema: { type: string, format: date, example: '2026-11-30' }
 *       - name: page
 *         in: query
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - name: pageSize
 *         in: query
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 25 }
 *     responses:
 *       '200':
 *         description: One page of entries
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuditPage' }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '500': { $ref: '#/components/responses/InternalError' }
 */
router.get('/', validate(schemas.listAudit), async (req, res) => {
  const query = req.valid.query
  const { entries, total } = await listAudit(query)
  res.json({ entries, total, page: query.page, pageSize: query.pageSize })
})

// GET /api/audit/actions → every action name, for the page's filter dropdown
/**
 * @openapi
 * /api/audit/actions:
 *   get:
 *     tags: [Audit]
 *     summary: List audit action names
 *     description: '**Roles:** `admin`. Every action name, for the filter dropdown.'
 *     responses:
 *       '200':
 *         description: The action names
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/AuditAction' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 */
router.get('/actions', (req, res) => {
  res.json(AUDIT_ACTIONS)
})

module.exports = router
