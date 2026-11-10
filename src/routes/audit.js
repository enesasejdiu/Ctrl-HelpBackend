// The audit log, for admins only. Mounted at /api/audit. See "Audit log" in README.md for the exact contract.
const express = require('express')
const { requireAuth, requireRole } = require('../middleware/auth')
const validate = require('../middleware/validate')
const schemas = require('../schemas/audit')
const { AUDIT_ACTIONS, listAudit } = require('../audit')

const router = express.Router()

router.use(requireAuth, requireRole('admin'))

// GET /api/audit?user=&action=&from=&to=&page=&pageSize= → { entries, total, page, pageSize }, newest first
router.get('/', validate(schemas.listAudit), async (req, res) => {
  const query = req.valid.query
  const { entries, total } = await listAudit(query)
  res.json({ entries, total, page: query.page, pageSize: query.pageSize })
})

// GET /api/audit/actions → every action name, for the page's filter dropdown
router.get('/actions', (req, res) => {
  res.json(AUDIT_ACTIONS)
})

module.exports = router
