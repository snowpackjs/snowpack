import etag from 'etag';
import execa from 'execa';
import findUp from 'find-up';
import fs from 'fs';
import {isBinaryFile} from 'isbinaryfile';
import mkdirp from 'mkdirp';
import open from 'open';
import path from 'path';
import rimraf from 'rimraf';
import url from 'url';
import getDefaultBrowserId from 'default-browser-id';
import type {ImportMap, LockfileManifest, SnowpackConfig} from './types';
import type {InstallTarget} from 'esinstall';
import {SkypackSDK} from 'skypack';
import {REMOTE_PACKAGE_ORIGIN} from './config';
import {GLOBAL_CACHE_DIR} from './sources/util';

// (!) Beware circular dependencies! No relative imports!
// Because this file is imported from so many different parts of Snowpack,
// importing other relative files inside of it is likely to introduce broken
// circular dependencies (sometimes only visible in the final bundled build.)
export const IS_DOTFILE_REGEX = /\/\.[^\/]+$/; // note: always assume forward-slashes, even on Windows

export const LOCKFILE_NAME = 'snowpack.deps.json';

// We need to use eval here to prevent Rollup from detecting this use of `require()`
export const NATIVE_REQUIRE = eval('require');

// We need to use an external file here to prevent Typescript/Rollup from modifying `require` and `import`
// NOTE: revisit this when `node@10` reaches EOL. Can we move everything to ESM and just use `import`?
export const REQUIRE_OR_IMPORT: (
  id: string,
  opts?: {from?: string},
) => Promise<any> = require('../../assets/require-or-import.js');

export function createRemotePackageSDK(config: SnowpackConfig) {
  // This should only be called when config.packageOptions.source is 'remote'.
  if (config.packageOptions.source !== 'remote') {
    throw new Error('expected "remote" packageOptions.source');
  }

  // For consistency with previous behavior, we default to REMOTE_PACKAGE_ORIGIN
  // if no origin is provided.  We could simply leave it undefined and allow
  // SkypackSDK to use its own default.
  return new SkypackSDK({
    origin: config.packageOptions.origin || REMOTE_PACKAGE_ORIGIN,
  });
}

// A note on cache naming/versioning: We currently version our global caches
// with the version of the last breaking change. This allows us to re-use the
// same cache across versions until something in the data structure changes.
// At that point, bump the version in the cache name to create a new unique
// cache name.
export const BUILD_CACHE = path.join(GLOBAL_CACHE_DIR, 'build-cache-2.7');
const LOCKFILE_HASH_FILE = '.hash';

// NOTE(fks): Must match empty script elements to work properly.
export const HTML_JS_REGEX = /(<script[^>]*?type="module".*?>)(.*?)<\/script>/gims;
export const HTML_STYLE_REGEX = /(<style.*?>)(.*?)<\/style>/gims;
export const CSS_REGEX = /@import\s*['"](.*?)['"];/gs;
export const SVELTE_VUE_REGEX = /(<script[^>]*>)(.*?)<\/script>/gims;
export const ASTRO_REGEX = /---(.*?)---/gims;

export function getCacheKey(fileLoc: string, {isSSR, mode}) {
  return `${fileLoc}?mode=${mode}&isSSR=${isSSR ? '1' : '0'}`;
}

export type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T;

/**
 * Like rimraf, but will fail if "dir" is outside of your configured build output directory.
 */
export function deleteFromBuildSafe(dir: string, config: SnowpackConfig) {
  const {out} = config.buildOptions;
  if (!path.isAbsolute(dir)) {
    throw new Error(`rimrafSafe(): dir ${dir} must be a absolute path`);
  }
  if (!path.isAbsolute(out)) {
    throw new Error(`rimrafSafe(): buildOptions.out ${out} must be a absolute path`);
  }
  if (!dir.startsWith(out)) {
    throw new Error(`rimrafSafe(): ${dir} outside of buildOptions.out ${out}`);
  }
  return rimraf.sync(dir);
}

/** Read file from disk; return a string if it’s a code file */
export async function readFile(filepath: string): Promise<string | Buffer> {
  let data = await fs.promises.readFile(filepath);
  if (!data) {
    console.error(
      `Unexpected Node.js error: readFile(${filepath}) returned undefined.\n\n` +
        `Somehow in Github CI / Jest its possible for fs.promises.readFile to return undefined.\n` +
        `This should be impossible, and has not yet been reproduced in the real world, but we do see it in our own CI.\n` +
        `If you are seeing this error, please report!`,
    );
    data = fs.readFileSync(filepath);
  }
  const isBinary = await isBinaryFile(data);
  return isBinary ? data : data.toString('utf8');
}

export async function readLockfile(cwd: string): Promise<LockfileManifest | null> {
  try {
    var lockfileContents = fs.readFileSync(path.join(cwd, LOCKFILE_NAME), {
      encoding: 'utf8',
    });
  } catch (err) {
    // no lockfile found, ignore and continue
    return null;
  }
  // If this fails, we actually do want to alert the user by throwing
  return JSON.parse(lockfileContents);
}

export function createInstallTarget(specifier: string, all = true): InstallTarget {
  return {
    specifier,
    all,
    default: false,
    namespace: false,
    named: [],
  };
}

function sortObject<T>(originalObject: Record<string, T>): Record<string, T> {
  const newObject = {};
  for (const key of Object.keys(originalObject).sort()) {
    newObject[key] = originalObject[key];
  }
  return newObject;
}

export function convertLockfileToSkypackImportMap(
  origin: string,
  lockfile: LockfileManifest,
): ImportMap {
  const result = {imports: {}};
  for (const [key, val] of Object.entries(lockfile.lock)) {
    result.imports[key.replace(/\#.*/, '')] = origin + '/' + val;
    result.imports[key.replace(/\#.*/, '') + '/'] = origin + '/' + val + '/';
  }
  return result;
}

export function convertSkypackImportMapToLockfile(
  dependencies: Record<string, string>,
  importMap: ImportMap,
): LockfileManifest {
  const result = {dependencies, lock: {}};
  for (const [key, val] of Object.entries(dependencies)) {
    if (importMap.imports[key]) {
      const valPath = url.parse(importMap.imports[key]).pathname;
      result.lock[key + '#' + val] = valPath?.substr(1);
    }
  }
  return result;
}

export async function writeLockfile(loc: string, importMap: LockfileManifest): Promise<void> {
  importMap.dependencies = sortObject(importMap.dependencies);
  importMap.lock = sortObject(importMap.lock);
  fs.writeFileSync(loc, JSON.stringify(importMap, undefined, 2), {encoding: 'utf8'});
}

export function isTruthy<T>(item: T | false | null | undefined): item is T {
  return Boolean(item);
}

/**
 * Returns true if fsevents exists. When Snowpack is bundled, automatic fsevents
 * detection fails for many libraries. This function helps add back support.
 */
export function isFsEventsEnabled(): boolean {
  try {
    NATIVE_REQUIRE('fsevents');
    return true;
  } catch (e) {
    return false;
  }
}

/** Get the package name + an entrypoint within that package (if given). */
export function parsePackageImportSpecifier(imp: string): [string, string | null] {
  const impParts = imp.split('/');
  if (imp.startsWith('@')) {
    const [scope, name, ...rest] = impParts;
    return [`${scope}/${name}`, rest.join('/') || null];
  }
  const [name, ...rest] = impParts;
  return [name, rest.join('/') || null];
}

/**
 * Given a package name, look for that package's package.json manifest.
 * Return both the manifest location (if believed to exist) and the
 * manifest itself (if found).
 *
 * NOTE: You used to be able to require() a package.json file directly,
 * but now with export map support in Node v13 that's no longer possible.
 */
export function resolveDependencyManifest(dep: string, cwd: string): [string | null, any | null] {
  // Attempt #1: Resolve the dependency manifest normally. This works for most
  // packages, but fails when the package defines an export map that doesn't
  // include a package.json. If we detect that to be the reason for failure,
  // move on to our custom implementation.
  try {
    const depManifest = fs.realpathSync.native(
      require.resolve(`${dep}/package.json`, {paths: [cwd]}),
    );
    return [depManifest, NATIVE_REQUIRE(depManifest)];
  } catch (err) {
    // if its an export map issue, move on to our manual resolver.
    if (err.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      return [null, null];
    }
  }

  // Attempt #2: Resolve the dependency manifest manually. This involves resolving
  // the dep itself to find the entrypoint file, and then haphazardly replacing the
  // file path within the package with a "./package.json" instead. It's not as
  // thorough as Attempt #1, but it should work well until export maps become more
  // established & move out of experimental mode.
  let result = [null, null] as [string | null, any | null];
  try {
    const fullPath = fs.realpathSync.native(require.resolve(dep, {paths: [cwd]}));
    // Strip everything after the package name to get the package root path
    // NOTE: This find-replace is very gross, replace with something like upath.
    const searchPath = `${path.sep}node_modules${path.sep}${dep.replace('/', path.sep)}`;
    const indexOfSearch = fullPath.lastIndexOf(searchPath);
    if (indexOfSearch >= 0) {
      const manifestPath =
        fullPath.substring(0, indexOfSearch + searchPath.length + 1) + 'package.json';
      result[0] = manifestPath;
      const manifestStr = fs.readFileSync(manifestPath, {encoding: 'utf8'});
      result[1] = JSON.parse(manifestStr);
    }
  } catch (err) {
    // ignore
  } finally {
    return result;
  }
}

/**
 * If Rollup erred parsing a particular file, show suggestions based on its
 * file extension (note: lowercase is fine).
 */
export const MISSING_PLUGIN_SUGGESTIONS: {[ext: string]: string} = {
  '.svelte':
    'Try installing rollup-plugin-svelte and adding it to Snowpack (https://www.snowpack.dev/tutorials/svelte)',
  '.vue':
    'Try installing rollup-plugin-vue and adding it to Snowpack (https://www.snowpack.dev/guides/vue)',
};

const appNames = {
  win32: {
    brave: 'brave',
  },
  darwin: {
    brave: 'Brave Browser',
  },
  linux: {
    brave: 'brave',
  },
};

async function openInExistingChromeBrowser(url: string) {
  // see if Chrome process is open; fail if not
  await execa.command('ps cax | grep "Google Chrome"', {
    shell: true,
  });
  // use open Chrome tab if exists; create new Chrome tab if not
  const openChrome = execa(
    'osascript ../../assets/openChrome.appleScript "' + encodeURI(url) + '"',
    {
      cwd: __dirname,
      stdio: 'ignore',
      shell: true,
    },
  );
  // if Chrome doesn’t respond within 3s, fall back to opening new tab in default browser
  let isChromeStalled = setTimeout(() => {
    openChrome.cancel();
  }, 3000);
  try {
    await openChrome;
  } catch (err) {
    if (err.isCanceled) {
      console.warn(`Chrome not responding to Snowpack after 3s. Opening in new tab.`);
    } else {
      console.error(err.toString() || err);
    }
    throw err;
  } finally {
    clearTimeout(isChromeStalled);
  }
}
export async function openInBrowser(
  protocol: string,
  hostname: string,
  port: number,
  browser: string,
  openUrl?: string,
): Promise<void> {
  const url = new URL(openUrl || '', `${protocol}//${hostname}:${port}`).toString();
  if (/chrome/i.test(browser)) {
    browser = open.apps.chrome as string;
  }
  if (/brave/i.test(browser)) {
    browser = appNames[process.platform]['brave'];
  }
  const isMacChrome =
    process.platform === 'darwin' &&
    (/chrome/i.test(browser) ||
      (/default/i.test(browser) && /chrome/i.test(await getDefaultBrowserId())));
  if (!isMacChrome) {
    await (browser === 'default' ? open(url) : open(url, {app: {name: browser}}));
    return;
  }
  try {
    // If we're on macOS, and we haven't requested a specific browser,
    // we can try opening Chrome with AppleScript. This lets us reuse an
    // existing tab when possible instead of creating a new one.
    await openInExistingChromeBrowser(url);
  } catch (err) {
    // if no open Chrome process, just go ahead and open default browser.
    await open(url);
  }
}

export async function checkLockfileHash(dir: string) {
  const lockfileLoc = await findUp(['package-lock.json', 'yarn.lock']);
  if (!lockfileLoc) {
    return true;
  }
  const hashLoc = path.join(dir, LOCKFILE_HASH_FILE);
  const newLockHash = etag(await fs.promises.readFile(lockfileLoc, 'utf8'));
  const oldLockHash = await fs.promises.readFile(hashLoc, 'utf8').catch(() => '');
  return newLockHash === oldLockHash;
}

export async function updateLockfileHash(dir: string) {
  const lockfileLoc = await findUp(['package-lock.json', 'yarn.lock']);
  if (!lockfileLoc) {
    return;
  }
  const hashLoc = path.join(dir, LOCKFILE_HASH_FILE);
  const newLockHash = etag(await fs.promises.readFile(lockfileLoc));
  await mkdirp(path.dirname(hashLoc));
  await fs.promises.writeFile(hashLoc, newLockHash);
}

function getAliasType(val: string): 'package' | 'path' | 'url' {
  if (isRemoteUrl(val)) {
    return 'url';
  }
  return !path.isAbsolute(val) ? 'package' : 'path';
}

/**
 * For the given import specifier, return an alias entry if one is matched.
 */
export function findMatchingAliasEntry(
  config: SnowpackConfig,
  spec: string,
): {from: string; to: string; type: 'package' | 'path' | 'url'} | undefined {
  // Only match bare module specifiers. relative and absolute imports should not match
  if (isPathImport(spec) || isRemoteUrl(spec)) {
    return undefined;
  }

  for (const [from, to] of Object.entries(config.alias)) {
    const isExactMatch = spec === from;
    const isDeepMatch = spec.startsWith(addTrailingSlash(from));
    if (isExactMatch || isDeepMatch) {
      return {
        from,
        to,
        type: getAliasType(to),
      };
    }
  }
}

/**
 * Get the most specific file extension match possible.
 */
export function getExtensionMatch(
  fileName: string,
  extensionMap: Record<string, string[]>,
): [string, string[]] | undefined {
  let extensionPartial;
  let extensionMatch;
  // If a full URL is given, start at the basename. Otherwise, start at zero.
  let extensionMatchIndex = Math.max(0, fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  // Grab expanded file extensions, from longest to shortest.
  while (!extensionMatch && extensionMatchIndex > -1) {
    extensionMatchIndex++;
    extensionMatchIndex = fileName.indexOf('.', extensionMatchIndex);
    extensionPartial = fileName.substr(extensionMatchIndex).toLowerCase();
    extensionMatch = extensionMap[extensionPartial];
  }
  // Return the first match, if one was found. Otherwise, return undefined.
  return extensionMatch ? [extensionPartial, extensionMatch] : undefined;
}

export function isPathImport(spec: string): boolean {
  return spec[0] === '.' || spec[0] === '/';
}

export function isRemoteUrl(val: string): boolean {
  return val.startsWith('//') || !!url.parse(val).protocol?.startsWith('http');
}

export function isImportOfPackage(importUrl: string, packageName: string) {
  return packageName === importUrl || importUrl.startsWith(packageName + '/');
}

/**
 * Sanitizes npm packages that end in .js (e.g `tippy.js` -> `tippyjs`).
 * This is necessary because Snowpack can’t create both a file and directory
 * that end in .js.
 */
export function sanitizePackageName(filepath: string): string {
  const dirs = filepath.split('/');
  const file = dirs.pop() as string;
  return [...dirs.map((path) => path.replace(/\.js$/i, 'js')), file].join('/');
}

// Source Map spec v3: https://docs.google.com/document/d/1U1RGAehQwRypUTovF1KRlpiOFze0b-_2gc6fAH0KY0k/edit#heading=h.lmz475t4mvbx

/** CSS sourceMappingURL */
export function cssSourceMappingURL(code: string, sourceMappingURL: string) {
  return code + `/*# sourceMappingURL=${sourceMappingURL} */`;
}

/** JS sourceMappingURL */
export function jsSourceMappingURL(code: string, sourceMappingURL: string) {
  return code.replace(/\n*$/, '') + `\n//# sourceMappingURL=${sourceMappingURL}\n`; // strip ending lines & append source map (with linebreaks for safety)
}

/** URL relative */
export function relativeURL(path1: string, path2: string): string {
  let url = path.relative(path1, path2).replace(/\\/g, '/');
  if (!url.startsWith('./') && !url.startsWith('../')) {
    url = './' + url;
  }
  return url;
}

const CLOSING_HEAD_TAG = /<\s*\/\s*head\s*>/gi;

/** Append HTML before closing </head> tag */
export function appendHtmlToHead(doc: string, htmlToAdd: string) {
  const closingHeadMatch = doc.match(CLOSING_HEAD_TAG);
  // if no <head> tag found, throw an error (we can’t load your app properly)
  if (!closingHeadMatch) {
    throw new Error(`No <head> tag found in HTML (this is needed to optimize your app):\n${doc}`);
  }
  // if multiple <head> tags found, also freak out
  if (closingHeadMatch.length > 1) {
    throw new Error(`Multiple <head> tags found in HTML (perhaps commented out?):\n${doc}`);
  }
  return doc.replace(closingHeadMatch[0], htmlToAdd + closingHeadMatch[0]);
}

export function isJavaScript(pathname: string): boolean {
  const ext = path.extname(pathname).toLowerCase();
  return ext === '.js' || ext === '.mjs' || ext === '.cjs';
}

export function getExtension(str: string) {
  return path.extname(str).toLowerCase();
}

export function hasExtension(str: string, ext: string) {
  return new RegExp(`\\${ext}$`, 'i').test(str);
}

export function replaceExtension(fileName: string, oldExt: string, newExt: string): string {
  const extToReplace = new RegExp(`\\${oldExt}$`, 'i');
  return fileName.replace(extToReplace, newExt);
}

export function addExtension(fileName: string, newExt: string): string {
  return fileName + newExt;
}

export function removeExtension(fileName: string, oldExt: string): string {
  return replaceExtension(fileName, oldExt, '');
}

/** Add / to beginning of string (but don’t double-up) */
export function addLeadingSlash(path: string) {
  return path.replace(/^\/?/, '/');
}

/** Add / to the end of string (but don’t double-up) */
export function addTrailingSlash(path: string) {
  return path.replace(/\/?$/, '/');
}

/** Remove \ and / from beginning of string */
export function removeLeadingSlash(path: string) {
  return path.replace(/^[/\\]+/, '');
}

/** Remove \ and / from end of string */
export function removeTrailingSlash(path: string) {
  return path.replace(/[/\\]+$/, '');
}

/** It's `Array.splice`, but for Strings! */
export function spliceString(source: string, withSlice: string, start: number, end: number) {
  return source.slice(0, start) + (withSlice || '') + source.slice(end);
}

export const HMR_CLIENT_CODE = fs.readFileSync(
  path.resolve(__dirname, '../../assets/hmr-client.js'),
  'utf8',
);
export const HMR_OVERLAY_CODE = fs.readFileSync(
  path.resolve(__dirname, '../../assets/hmr-error-overlay.js'),
  'utf8',
);
export const INIT_TEMPLATE_FILE = fs.readFileSync(
  path.resolve(__dirname, '../../assets/snowpack-init-file.js'),
  'utf8',
);
