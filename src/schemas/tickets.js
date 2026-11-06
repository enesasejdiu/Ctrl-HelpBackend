// Request schemas for /api/tickets, except comments (see comments.js).
const { z } = require('zod');
const { id, status, requiredText, optionalText, ticketParams } = require('./common');

// Whether a category, priority or assignee really exists needs the database, so the routes check that

// An empty filter (?status=) means "no filter"
function filter(schema) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

const listTickets = {
  query: z.object({
    status: filter(status),
    priority: filter(id('Priority')),
    category: filter(id('Category')),
    assigned: filter(z.enum(['me', 'unassigned'], { error: 'Assigned must be one of: me, unassigned' })),
    q: filter(z.string({ error: 'Search must be text' }).trim()),
    overdue: filter(z.literal('1', { error: 'Overdue must be 1 or left out' })),
  }),
};

const createTicket = {
  body: z.strictObject({
    title: requiredText('Title', 150, 'Title must be at most 150 characters'),
    description: requiredText('Description', 10000),
    category_id: id('Category', { invalid: 'Invalid category' }),
    priority_id: id('Priority', { invalid: 'Invalid priority' }),
  }),
};

const getTicket = { params: ticketParams };

const updateStatus = {
  params: ticketParams,
  body: z.strictObject({ status, resolution: optionalText('Resolution', 10000) }),
};

const updatePriority = {
  params: ticketParams,
  body: z.strictObject({
    priority_id: id('Priority', { invalid: 'Invalid priority', required: 'Invalid priority' }),
  }),
};

const assignTicket = {
  params: ticketParams,
  body: z.strictObject({
    assigned_to: id('Assignee', {
      invalid: 'That user cannot be assigned tickets',
      required: 'assigned_to is required (use null to unassign)',
    }).nullable(), // null = unassign
  }),
};

module.exports = { listTickets, createTicket, getTicket, updateStatus, updatePriority, assignTicket };
