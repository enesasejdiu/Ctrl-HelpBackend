// Jest config for the API tests. See "Running tests" in README.md.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // Creates the throwaway test database before all tests and drops it after, even when tests fail
  globalSetup: '<rootDir>/tests/globalSetup.js',
  globalTeardown: '<rootDir>/tests/globalTeardown.js',
  setupFiles: ['<rootDir>/tests/setupEnv.js'], // points the app at the test database before it loads
  setupFilesAfterEnv: ['<rootDir>/tests/setupAfterEnv.js'], // closes the MySQL pool after each file
  // One test database for the whole run, so test files run one after another, never at the same time
  maxWorkers: 1,
  // Many tests hash several passwords with bcrypt (deliberately slow). 5s, Jest's default, was too tight on a busy
  // machine (e.g. with a dev server rebuilding), so a slow but correct test isn't reported as a failure
  testTimeout: 15000,
  collectCoverageFrom: ['src/**/*.js'],
};
