// Request validation with zod.
// validate({ params, query, body }) checks each part it's given against a schema from src/schemas/.
// On failure it answers 400 with { message, errors: [{ field, message }] }; message is the first problem, ready to show.
// On success the parsed, cleaned values are in req.valid.params / .query / .body, and routes read them from there.
// They can't go back on req.query, because Express 5 makes it read-only.
// A route can validate in steps (e.g. params first, body after a database check); each step adds to req.valid.

// Turns zod's issues into { field, message } pairs
function toErrors(part, issues) {
  return issues.flatMap((issue) => {
    // One issue can list several unknown fields, so each gets its own entry
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({ field: key, message: `${key} is not allowed` }))
    }
    // No path means the problem is the whole part, e.g. a JSON array where an object belongs
    if (issue.path.length === 0 && issue.code === 'invalid_type') {
      return [{ field: part, message: `Request ${part} must be a JSON object` }]
    }
    return [{ field: issue.path.join('.') || part, message: issue.message }]
  })
}

// options.status: the status for a failed check (400 unless a route needs another, e.g. 422 for forgot-password)
function validate(schemas, { status = 400 } = {}) {
  return (req, res, next) => {
    const valid = {}
    const errors = []

    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue
      // Express 5 leaves req.body undefined when nothing was sent; {} reports each missing field instead
      const result = schemas[part].safeParse(req[part] ?? {})
      if (result.success) valid[part] = result.data
      else errors.push(...toErrors(part, result.error.issues))
    }

    if (errors.length > 0) {
      return res.status(status).json({ message: errors[0].message, errors })
    }
    req.valid = { ...req.valid, ...valid }
    next()
  }
}

module.exports = validate
