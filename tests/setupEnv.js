// Jest setupFiles: runs in every test file BEFORE any app code is loaded, so src/db.js connects to the test database.
const { assertTestDbName } = require('./testDb');

// Set by tests/globalSetup.js; throws (before anything connects) if it is missing or not a test database
process.env.DB_NAME = assertTestDbName(process.env.TEST_DB_NAME);
process.env.JWT_SECRET = 'test-only-jwt-secret-not-used-anywhere-else';
process.env.NODE_ENV = 'test';
// The frontend origin CORS allows (with credentials); fixed so the CORS tests don't depend on .env
process.env.CLIENT_URL = 'http://localhost:5173';

// Host, user and password from .env. dotenv never overwrites variables that are already set, so DB_NAME stays.
require('dotenv').config({ quiet: true });
