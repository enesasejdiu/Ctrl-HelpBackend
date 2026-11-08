// Department routes.
// Mounted at /api/departments. Anyone logged in can list them; admins and HR create, rename and delete them.
// Names are unique without regard to case ("Sales" and "sales" are the same): the table's collation
// (utf8mb4_unicode_ci) makes both the lookups below and the UNIQUE index on name case-insensitive.
const express = require('express');
const pool = require('../db');
const { HttpError } = require('../middleware/errors');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const schemas = require('../schemas/departments');

const router = express.Router();

// One query for every department with its number of users (LEFT JOIN, so empty departments count 0)
const DEPARTMENTS_WITH_COUNTS = `
  SELECT d.id, d.name, COUNT(u.id) AS user_count, d.created_at, d.updated_at
  FROM departments d
  LEFT JOIN users u ON u.department_id = d.id`;

const nameTaken = () => new HttpError(409, 'A department with this name already exists', 'DEPARTMENT_NAME_TAKEN');

async function findDepartment(id) {
  const [rows] = await pool.query(`${DEPARTMENTS_WITH_COUNTS} WHERE d.id = ? GROUP BY d.id`, [id]);
  return rows[0];
}

// Throws 409 if another department already has this name (any letter case)
async function checkNameFree(name, exceptId = 0) {
  const [taken] = await pool.query('SELECT id FROM departments WHERE name = ? AND id <> ?', [name, exceptId]);
  if (taken.length > 0) throw nameTaken();
}

// Admin and HR only, and the department must exist (404 comes before any problem with the body)
const canManage = requireRole('admin', 'hr');
async function loadDepartment(req, res, next) {
  req.department = await findDepartment(req.valid.params.id);
  if (!req.department) {
    throw new HttpError(404, 'Department not found');
  }
  next();
}

router.use(requireAuth);

// GET /api/departments → [{ id, name, user_count, created_at, updated_at }], sorted by name
router.get('/', async (req, res) => {
  const [rows] = await pool.query(`${DEPARTMENTS_WITH_COUNTS} GROUP BY d.id ORDER BY d.name, d.id`);
  res.json(rows);
});

// POST /api/departments { name } (admin and HR) → 201 the new department
router.post('/', canManage, validate(schemas.departmentBody), async (req, res) => {
  const { name } = req.valid.body;
  await checkNameFree(name);

  let result;
  try {
    [result] = await pool.query('INSERT INTO departments (name) VALUES (?)', [name]);
  } catch (err) {
    // Two requests for the same name at once: both pass the check above, and the UNIQUE index stops the second
    if (err.code === 'ER_DUP_ENTRY') throw nameTaken();
    throw err;
  }
  res.status(201).json(await findDepartment(result.insertId));
});

// PATCH /api/departments/:id { name } (admin and HR) → the renamed department
// The same name exactly is a no-op (nothing is written, updated_at stays). A change of letter case is a real rename.
router.patch(
  '/:id',
  canManage,
  validate(schemas.departmentParams),
  loadDepartment,
  validate(schemas.departmentBody),
  async (req, res) => {
    const { id } = req.valid.params;
    const { name } = req.valid.body;
    if (name === req.department.name) {
      return res.json(req.department);
    }

    await checkNameFree(name, id);
    try {
      await pool.query('UPDATE departments SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [name, id]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw nameTaken();
      throw err;
    }
    res.json(await findDepartment(id));
  }
);

// DELETE /api/departments/:id (admin and HR) → 204, only when nobody is in it (409 DEPARTMENT_NOT_EMPTY otherwise)
router.delete('/:id', canManage, validate(schemas.departmentParams), loadDepartment, async (req, res) => {
  const { id } = req.valid.params;

  // The FK is ON DELETE SET NULL, so deleting a department that just got a user would silently unassign them.
  // FOR UPDATE locks the department row until this commits. Putting a user into the department needs a shared lock
  // on that row (InnoDB's foreign key check), so it waits until we're done and then fails because the department is
  // gone. An assignment that started first holds that lock, so we wait for it and then count its user.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM departments WHERE id = ? FOR UPDATE', [id]);
    // A locking read, so the count sees the latest committed data, not an older snapshot
    const [[{ userCount }]] = await conn.query(
      'SELECT COUNT(*) AS userCount FROM users WHERE department_id = ? LOCK IN SHARE MODE',
      [id]
    );
    if (userCount > 0) {
      throw new HttpError(409, 'Move the users out of this department before deleting it', 'DEPARTMENT_NOT_EMPTY', {
        user_count: userCount,
      });
    }
    await conn.query('DELETE FROM departments WHERE id = ?', [id]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  res.status(204).end();
});

module.exports = router;
