const dedent = require('dedent');
const {testFixture, testRuntimeFixture} = require('../../../fixture-utils');
const {fmtjson} = require('../../../test-utils');

const pkg = {
  'index.js': dedent`
    import {NetworkCanvas} from '@nivo/network';
  `,
  'package.json': fmtjson({
    dependencies: {
      '@nivo/core': '^0.72.0',
      '@nivo/network': '^0.72.0',
    },
  }),
};

/**
 * Fixes #3466
 * Main thing we’re testing for here is that dev server doesn’t hang on circular deps
 * Though this test is slow, it’s important to test on real npm packages and not mocked ones
 * as symlink behavior is really different here
 */
describe('@nivo/core', () => {
  it('dev', async () => {
    const server = await testRuntimeFixture(pkg);
    const js = (await server.loadUrl('/index.js')).contents.toString('utf8');
    expect(js).toBeTruthy(); // if this returned some response,
    await server.cleanup(); // clean up
  }, 60000); // wait an extra long time

  it('build', async () => {
    const result = await testFixture(pkg);
    expect(result['index.js']).toBeTruthy();
  });
});
