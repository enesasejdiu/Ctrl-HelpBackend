// PATCH /api/users/:id: role changes, including the hr role from migrations/002.
const pool = require('../src/db');
const { api, resetData, createUser, loginAs } = require('./helpers');

beforeEach(resetData);

// Inserts a ticket assigned to the given agent. Categories and priorities are added by tests/globalSetup.js.
async function createAssignedTicket(requester, assignee, status = 'assigned') {
  const [result] = await pool.query(
    `INSERT INTO tickets (title, description, requester_id, assigned_to, category_id, priority_id, status)
     VALUES ('Test ticket', 'Test description', ?, ?, 1, 1, ?)`,
    [requester.id, assignee.id, status]
  );
  return result.insertId;
}

describe('PATCH /api/users/:id with the hr role', () => {
  test('an admin can give a user the hr role', async () => {
    const admin = await createUser({ role: 'admin' });
    const employee = await createUser();
    const token = await loginAs(admin);

    const res = await api.patch(`/api/users/${employee.id}`).set('Authorization', `Bearer ${token}`).send({ role: 'hr' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('hr');
  });

  test('moving an agent to hr puts their unfinished tickets back in the queue', async () => {
    const admin = await createUser({ role: 'admin' });
    const agent = await createUser({ role: 'agent' });
    const employee = await createUser();
    const ticketId = await createAssignedTicket(employee, agent);
    const token = await loginAs(admin);

    const res = await api.patch(`/api/users/${agent.id}`).set('Authorization', `Bearer ${token}`).send({ role: 'hr' });
    expect(res.status).toBe(200);

    const [[ticket]] = await pool.query('SELECT assigned_to, status FROM tickets WHERE id = ?', [ticketId]);
    expect(ticket).toEqual({ assigned_to: null, status: 'open' });
  });

  test('an unknown role is refused', async () => {
    const admin = await createUser({ role: 'admin' });
    const employee = await createUser();
    const token = await loginAs(admin);

    const res = await api.patch(`/api/users/${employee.id}`).set('Authorization', `Bearer ${token}`).send({ role: 'manager' });
    expect(res.status).toBe(400);
  });
});
