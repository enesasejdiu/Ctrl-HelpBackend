// Jest setupFiles: runs in every test file BEFORE any app code is loaded, so src/db.js connects to the test database.
const { assertTestDbName } = require('./testDb');

// Set by tests/globalSetup.js; throws (before anything connects) if it is missing or not a test database
process.env.DB_NAME = assertTestDbName(process.env.TEST_DB_NAME);
process.env.JWT_SECRET = 'test-only-jwt-secret-not-used-anywhere-else';
process.env.JWT_EXPIRES_IN = '1h';
process.env.NODE_ENV = 'test';

// Host, user and password from .env. dotenv never overwrites variables that are already set, so DB_NAME stays.
require('dotenv').config({ quiet: true });
