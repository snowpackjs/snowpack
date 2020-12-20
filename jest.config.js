module.exports = {
  modulePathIgnorePatterns: [
    '<rootDir>/create-snowpack-app/app-template-', // don’t run tests intended as user examples
    '<rootDir>/examples', // don’t run any tests in examples
    '<rootDir>/test/create-snowpack-app/test-install', // don’t run tests inside our mock create-snowpack-app install
    '<rootDir>/www', // docs has its own tests
  ],
  testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.js$', // `tsx?` and `jsx` files are not transformed, thus only test `js` file
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testEnvironment: 'node',
};
