// Jest config for the API tests. See "Running tests" in README.md.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // The real-size attachment test runs on its own, in a second Jest run (jest.real-size.config.js)
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/real-size/'],
  // Creates the throwaway test database before all tests and drops it after, even when tests fail
  globalSetup: '<rootDir>/tests/globalSetup.js',
  globalTeardown: '<rootDir>/tests/globalTeardown.js',
  setupFiles: ['<rootDir>/tests/setupEnv.js'], // points the app at the test database before it loads
  // slowHooks.js first, so it also watches setupAfterEnv.js's hooks: logs any beforeEach / afterEach slower than 5 s
  // with a PROCESSLIST dump. setupAfterEnv.js closes the MySQL pool after each file.
  setupFilesAfterEnv: ['<rootDir>/tests/slowHooks.js', '<rootDir>/tests/setupAfterEnv.js'],
  // One test database for the whole run, so test files run one after another, never at the same time
  maxWorkers: 1,
  // Many tests hash several passwords with bcrypt (deliberately slow). 5s, Jest's default, was too tight on a busy
  // machine (e.g. with a dev server rebuilding), so a slow but correct test isn't reported as a failure
  testTimeout: 15000,
  collectCoverageFrom: ['src/**/*.js'],
  // npm run test:coverage (and CI) fails if coverage drops below these. They are today's numbers rounded down, so
  // coverage can only go up: raise them when new tests push the numbers higher. (Branches is still below 80%.)
  coverageThreshold: {
    global: { statements: 88, branches: 77, functions: 95, lines: 88 },
  },
}
