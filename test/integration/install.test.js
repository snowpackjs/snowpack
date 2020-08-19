const path = require('path');
const fs = require('fs').promises;
const {readdirSync, readFileSync, existsSync} = require('fs');
const execa = require('execa');
const rimraf = require('rimraf');
const glob = require('glob');

const KEEP_LOCKFILE = [
  'source-pika-lockfile', // We explicitly want to test the lockfile in this test
];

function stripBenchmark(stdout) {
  return stdout.replace(/\s*\[\d+\.?\d+s\](\n?)/g, '$1'); //remove benchmark
}
function stripStats(stdout) {
  // Need to strip leading whitespace to get around strange Node v13 behavior
  return stdout.replace(/\s+[\d\.]*? KB/g, '    XXXX KB');
}
function stripWhitespace(stdout) {
  return stdout.replace(/((\s+$)|((\\r\\n)|(\\n)))/gm, '');
}
function stripRev(code) {
  return code.replace(/\?rev=\w+/gm, '?rev=XXXXXXXXXX');
}
function stripChunkHash(stdout) {
  return stdout.replace(/([\w\-]+\-)[a-z0-9]{8}(\.js)/g, '$1XXXXXXXX$2');
}
function stripUrlHash(stdout) {
  return stdout.replace(/\-[A-Za-z0-9]{20}\//g, 'XXXXXXXX');
}
function stripConfigErrorPath(stdout) {
  return stdout.replace(/^\[snowpack\] ! (.*)package\.json$/gm, '! XXX/package.json');
}
function stripResolveErrorPath(stdout) {
  return stdout.replace(/" via "(.*)"/g, '" via "XXX"');
}
function stripStacktrace(stdout) {
  return stdout.replace(/^\s+at\s+.*/gm, ''); // this is OK to show to the user but annoying to have in a test
}
function stripSvelteComment(stdout) {
  return stdout.replace(/^.*generated by Svelte.*$/gm, '/* XXXX generated by Svelte vX.X.X */');
}

function removeLockfile(testName) {
  const lockfileLoc = path.join(__dirname, testName, 'snowpack.lock.json');
  try {
    rimraf.sync(lockfileLoc);
  } catch (err) {
    // ignore
  }
}

describe('snowpack install', () => {
  beforeAll(() => {
    // Needed so that ora (spinner) doesn't use platform-specific characters
    process.env = Object.assign(process.env, {CI: '1'});
  });

  for (const testName of readdirSync(__dirname)) {
    if (testName === 'node_modules' || testName === '__snapshots__' || testName.includes('.')) {
      continue;
    }

    it(testName, async () => {
      // Cleanup
      if (!KEEP_LOCKFILE.includes(testName)) {
        removeLockfile(testName);
      }

      // Run Test
      const {all} = await execa('yarn', ['--silent', 'run', 'testinstall'], {
        cwd: path.join(__dirname, testName),
        reject: false,
        all: true,
      });
      // Test Output
      let expectedOutputLoc = path.join(__dirname, testName, 'expected-output.txt');
      if (process.platform === 'win32') {
        const expectedWinOutputLoc = path.resolve(expectedOutputLoc, '../expected-output.win.txt');
        if (existsSync(expectedWinOutputLoc)) {
          expectedOutputLoc = expectedWinOutputLoc;
        }
      }
      const expectedOutput = await fs.readFile(expectedOutputLoc, {encoding: 'utf8'});
      expect(
        stripWhitespace(
          stripConfigErrorPath(
            stripResolveErrorPath(stripBenchmark(stripChunkHash(stripStats(stripStacktrace(all))))),
          ),
        ),
      ).toBe(stripWhitespace(expectedOutput));

      // Test Lockfile (if one exists)
      const expectedLockLoc = path.join(__dirname, testName, 'expected-lock.json');
      const expectedLock = await fs
        .readFile(expectedLockLoc, {encoding: 'utf8'})
        .catch((/* ignore */) => null);
      if (expectedLock) {
        const actualLockLoc = path.join(__dirname, testName, 'snowpack.lock.json');
        const actualLock = await fs.readFile(actualLockLoc, {encoding: 'utf8'});
        if (KEEP_LOCKFILE.includes(testName)) {
          expect(stripWhitespace(actualLock)).toBe(stripWhitespace(expectedLock));
        } else {
          expect(stripWhitespace(stripUrlHash(actualLock))).toBe(
            stripWhitespace(stripUrlHash(expectedLock)),
          );
        }
      }
      // Cleanup
      if (!KEEP_LOCKFILE.includes(testName)) {
        removeLockfile(testName);
      }

      const actual = path.join(__dirname, testName, 'web_modules');
      const allFiles = glob.sync(`**/*`, {
        ignore: ['**/common/**/*'],
        cwd: actual,
        nodir: true,
      });

      if (allFiles.length === 0) {
        // skip web_modules/ comparison for tests that start with error-*
        if (testName.startsWith('error-')) {
          return;
        }
        throw new Error('Empty build directory!');
      }

      expect(allFiles.map(f => f.replace(/\\/g, '/'))).toMatchSnapshot('allFiles');

      // If any diffs are detected, we'll assert the difference so that we get nice output.
      for (const entry of allFiles) {
        // don’t compare CSS or .map files.
        if (entry.endsWith('.css') || entry.endsWith('.map')) {
          continue;
        }
        const f1 = readFileSync(path.resolve(actual, entry), {encoding: 'utf8'});
        expect(stripWhitespace(stripSvelteComment(stripChunkHash(stripRev(f1))))).toMatchSnapshot(
          entry.replace(/\\/g, '/'),
        );
      }
    });
  }
});
