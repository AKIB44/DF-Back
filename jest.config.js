module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  globalSetup: './tests/global-setup.js',
  globalTeardown: './tests/global-teardown.js',
  testTimeout: 30000,
  maxWorkers: 1,   // serial — avoid DB race conditions
  verbose: true,
};
