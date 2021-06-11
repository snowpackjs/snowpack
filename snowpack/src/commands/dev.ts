import {FSWatcher} from 'chokidar';
import isCompressible from 'compressible';
import {InstallTarget} from 'esinstall';
import etag from 'etag';
import {EventEmitter} from 'events';
import {createReadStream, promises as fs, statSync} from 'fs';
import {fdir} from 'fdir';
import picomatch from 'picomatch';
import type {Socket} from 'net';
import http from 'http';
import http2 from 'http2';
import * as colors from 'kleur/colors';
import mime from 'mime-types';
import os from 'os';
import path from 'path';
import {performance} from 'perf_hooks';
import slash from 'slash';
import stream from 'stream';
import url from 'url';
import zlib from 'zlib';
import {generateEnvModule, getMetaUrlPath, wrapImportProxy} from '../build/build-import-proxy';
import {FileBuilder} from '../build/file-builder';
import {getBuiltFileUrls, getMountEntryForFile, getUrlsForFile} from '../build/file-urls';
import {startHmrEngine} from '../dev/hmr';
import {logger} from '../logger';
import {getPackageSource} from '../sources/util';
import {createLoader as createServerRuntime} from '../ssr-loader';
import {
  CommandOptions,
  LoadResult,
  LoadUrlOptions,
  OnFileChangeCallback,
  RouteConfigObject,
  ServerRuntime,
  SnowpackConfig,
  SnowpackDevServer,
} from '../types';
import {
  createInstallTarget,
  getCacheKey,
  HMR_CLIENT_CODE,
  HMR_OVERLAY_CODE,
  isFsEventsEnabled,
  openInBrowser,
} from '../util';
import {getPort, startDashboard, paintEvent} from './paint';
import {cssModuleJSON} from '../build/import-css';
import {runPipelineCleanupStep} from '../build/build-pipeline';

export class OneToManyMap {
  readonly keyToValue = new Map<string, string[]>();
  readonly valueToKey = new Map<string, string>();
  add(key: string, _value: string | string[]) {
    const value = Array.isArray(_value) ? _value : [_value];
    this.keyToValue.set(key, value);
    for (const val of value) {
      this.valueToKey.set(val, key);
    }
  }
  delete(key: string) {
    const value = this.value(key);
    this.keyToValue.delete(key);
    if (value) {
      for (const val of value) {
        this.valueToKey.delete(val);
      }
    }
  }
  key(value: string) {
    return this.valueToKey.get(value);
  }
  value(key: string) {
    return this.keyToValue.get(key);
  }
}

interface FoundFile {
  loc: string;
  type: string;
  // contents: Buffer;
  isStatic: boolean;
  isResolve: boolean;
}

const FILE_BUILD_RESULT_ERROR = `Build Result Error: There was a problem with a file build result.`;

/**
 * If encoding is defined, return a string. Otherwise, return a Buffer.
 */
function encodeResponse(
  response: Buffer | string,
  encoding: BufferEncoding | undefined | null,
): Buffer | string {
  if (encoding === undefined) {
    return response;
  }
  if (encoding) {
    if (typeof response === 'string') {
      return response;
    } else {
      return response.toString(encoding);
    }
  }
  if (typeof response === 'string') {
    return Buffer.from(response);
  } else {
    return response;
  }
}

/**
 * A helper class for "Not Found" errors, storing data about what file lookups were attempted.
 */
export class NotFoundError extends Error {
  constructor(url: string, lookups?: string[]) {
    if (!lookups) {
      super(`Not Found (${url})`);
    } else {
      super(`Not Found (${url}):\n${lookups.map((loc) => '  ✘ ' + loc).join('\n')}`);
    }
  }
}

function sendResponseFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  {contents, originalFileLoc, contentType}: LoadResult,
) {
  const body = Buffer.from(contents);
  const ETag = etag(body, {weak: true});
  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Content-Type': contentType || 'application/octet-stream',
    ETag,
    Vary: 'Accept-Encoding',
  };

  if (req.headers['if-none-match'] === ETag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  let acceptEncoding = (req.headers['accept-encoding'] as string) || '';
  if (
    req.headers['cache-control']?.includes('no-transform') ||
    ['HEAD', 'OPTIONS'].includes(req.method!) ||
    !contentType ||
    !isCompressible(contentType)
  ) {
    acceptEncoding = '';
  }

  // Handle gzip compression
  if (/\bgzip\b/.test(acceptEncoding) && stream.Readable.from) {
    const bodyStream = stream.Readable.from([body]);
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    stream.pipeline(bodyStream, zlib.createGzip(), res, function onError(err) {
      if (err) {
        res.end();
        logger.error(`✘ An error occurred serving ${colors.bold(req.url!)}`);
        logger.error(typeof err !== 'string' ? err.toString() : err);
      }
    });
    return;
  }

  // Handle partial requests
  // TODO: This throws out a lot of hard work, and ignores any build. Improve.
  const {range} = req.headers;
  if (range) {
    if (!originalFileLoc) {
      throw new Error('Virtual files do not support partial requests');
    }
    const {size: fileSize} = statSync(originalFileLoc);
    const [rangeStart, rangeEnd] = range.replace(/bytes=/, '').split('-');

    const start = parseInt(rangeStart, 10);
    const end = rangeEnd ? parseInt(rangeEnd, 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    const fileStream = createReadStream(originalFileLoc, {start, end});
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': chunkSize,
    });
    fileStream.pipe(res);
    return;
  }

  res.writeHead(200, headers);
  res.write(body);
  res.end();
}

function sendResponseError(req: http.IncomingMessage, res: http.ServerResponse, status: number) {
  const contentType = mime.contentType(path.extname(req.url!) || '.html');
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType || 'application/octet-stream',
    Vary: 'Accept-Encoding',
  };
  res.writeHead(status, headers);
  res.end();
}

function handleResponseError(req, res, err: Error | NotFoundError) {
  if (err instanceof NotFoundError) {
    // Don't log favicon "Not Found" errors. Browsers automatically request a favicon.ico file
    // from the server, which creates annoying errors for new apps / first experiences.
    if (req.url !== '/favicon.ico') {
      logger.error(`[404] ${err.message}`);
    }
    sendResponseError(req, res, 404);
    return;
  }
  console.log(err);
  logger.error(err.toString());
  logger.error(`[500] ${req.url}`, {
    // @ts-ignore
    name: err.__snowpackBuildDetails?.name,
  });
  sendResponseError(req, res, 500);
  return;
}

function getServerRuntime(
  sp: SnowpackDevServer,
  config: SnowpackConfig,
  options: {invalidateOnChange?: boolean} = {},
): ServerRuntime {
  const runtime = createServerRuntime({
    config,
    load: async (url) => {
      const result = await sp.loadUrl(url, {isSSR: true, allowStale: false, encoding: 'utf8'});
      if (!result) throw new NotFoundError(url);
      return result;
    },
  });
  if (options.invalidateOnChange !== false) {
    sp.onFileChange(({filePath}) => {
      const url = sp.getUrlForFile(filePath);
      if (url) {
        runtime.invalidateModule(url);
      }
    });
  }
  return runtime;
}

export async function startServer(
  commandOptions: CommandOptions,
  {
    isDev: _isDev,
    isWatch: _isWatch,
    preparePackages: _preparePackages,
  }: {isDev?: boolean; isWatch?: boolean; preparePackages?: boolean} = {},
): Promise<SnowpackDevServer> {
  const {config} = commandOptions;
  const isDev = _isDev ?? config.mode !== 'production';
  const isWatch = _isWatch ?? true;
  const isPreparePackages = _preparePackages ?? true;
  const pkgSource = getPackageSource(config);
  if (isPreparePackages) {
    await pkgSource.prepare();
    logger.info(colors.bold('Ready!'));
  }
  let serverStart = performance.now();
  const {port: defaultPort, hostname, open, openUrl} = config.devOptions;
  const messageBus = new EventEmitter();
  const PACKAGE_PATH_PREFIX = path.posix.join(config.buildOptions.metaUrlPath, 'pkg/');
  const PACKAGE_LINK_PATH_PREFIX = path.posix.join(config.buildOptions.metaUrlPath, 'link/');
  let port: number | undefined;
  let warnedDeprecatedPackageImport = new Set();
  if (defaultPort !== 0) {
    port = await getPort(defaultPort);
    // Reset the clock if we had to wait for the user prompt to select a new port.
    if (port !== defaultPort) {
      serverStart = performance.now();
    }
  }

  // Fill in any command-specific plugin methods.
  for (const p of config.plugins) {
    p.markChanged = (fileLoc) => {
      knownETags.clear();
      onWatchEvent(fileLoc);
    };
  }

  if (isWatch && config.devOptions.output === 'dashboard' && process.stdout.isTTY) {
    startDashboard(messageBus, config);
  } else {
    // "stream": Log relevent events to the console.
    messageBus.on(paintEvent.WORKER_MSG, ({id, msg}) => {
      logger.info(msg.trim(), {name: id});
    });
  }

  const symlinkDirectories = new Map<string, Promise<any>>();
  const inMemoryBuildCache = new Map<string, FileBuilder>();
  let fileToUrlMapping = new OneToManyMap();
  const excludeGlobs = [
    ...config.exclude,
    ...(config.mode === 'test' ? [] : config.testOptions.files),
  ];

  const foundExcludeMatch = picomatch(excludeGlobs, {ignore: '**/node_modules/**'});

  for (const [mountKey, mountEntry] of Object.entries(config.mount)) {
    logger.debug(`Mounting directory: '${mountKey}' as URL '${mountEntry.url}'`);
    const files = (await new fdir()
      .withFullPaths()
      // Note: exclude() only matches directories, and not files. However, the cost
      // of false positives here is minor, so do this as a quick check to possibly
      // skip scanning into entire folder trees.
      .exclude((_, dirPath) => foundExcludeMatch(dirPath))
      .crawl(mountKey)
      .withPromise()) as string[];

    for (const f of files) {
      fileToUrlMapping.add(f, getUrlsForFile(f, config)!);
    }
  }

  logger.debug(`Using in-memory cache: ${fileToUrlMapping}`);

  const readCredentials = async (cwd: string) => {
    const secure = config.devOptions.secure;
    let cert: Buffer;
    let key: Buffer;

    if (typeof secure === 'object') {
      cert = secure.cert as Buffer;
      key = secure.key as Buffer;
    } else {
      const certPath = path.join(cwd, 'snowpack.crt');
      const keyPath = path.join(cwd, 'snowpack.key');
      [cert, key] = await Promise.all([fs.readFile(certPath), fs.readFile(keyPath)]);
    }

    return {
      cert,
      key,
    };
  };

  let credentials: {cert: Buffer; key: Buffer} | undefined;
  if (config.devOptions.secure) {
    try {
      logger.debug(`reading credentials`);
      credentials = await readCredentials(config.root);
    } catch (e) {
      logger.error(`✘ No HTTPS credentials found!`);
      logger.info(`You can specify HTTPS credentials via either:

  - Including credentials in your project config under ${colors.yellow(`devOptions.secure`)}.
  - Including ${colors.yellow('snowpack.crt')} and ${colors.yellow(
        'snowpack.key',
      )} files in your project's root directory.

    You can automatically generate credentials for your project via either:

  - ${colors.cyan('devcert')}: ${colors.yellow('npx devcert-cli generate localhost')}
    https://github.com/davewasmer/devcert-cli (no install required)

  - ${colors.cyan('mkcert')}: ${colors.yellow(
        'mkcert -install && mkcert -key-file snowpack.key -cert-file snowpack.crt localhost',
      )}
    https://github.com/FiloSottile/mkcert (install required)`);
      process.exit(1);
    }
  }

  for (const runPlugin of config.plugins) {
    if (runPlugin.run) {
      logger.debug(`starting ${runPlugin.name} run() workers`);
      runPlugin
        .run({
          isDev,
          // @ts-ignore: internal API only
          log: (msg, data) => {
            if (msg === 'CONSOLE_INFO') {
              logger.info(data.msg, {name: runPlugin.name});
            } else {
              messageBus.emit(msg, {...data, id: runPlugin.name});
            }
          },
        })
        .then(() => {
          logger.info('Command completed.', {name: runPlugin.name});
        })
        .catch((err) => {
          logger.error(`Command exited with error code: ${err}`, {name: runPlugin.name});
          process.exit(1);
        });
    }
  }

  function getOutputExtensionMatch() {
    let outputExts: string[] = [];
    for (const plugin of config.plugins) {
      if (plugin.resolve) {
        for (const outputExt of plugin.resolve.output) {
          const ext = outputExt.toLowerCase();
          if (!outputExts.includes(ext)) {
            outputExts.push(ext);
          }
        }
      }
    }
    outputExts = outputExts.sort((a, b) => b.split('.').length - a.split('.').length);

    return (base: string): string => {
      const basename = base.toLowerCase();
      for (const ext of outputExts) {
        if (basename.endsWith(ext)) return ext;
      }
      return path.extname(basename);
    };
  }

  const matchOutputExt = getOutputExtensionMatch();

  async function loadUrl(
    reqUrl: string,
    opt?: (LoadUrlOptions & {encoding?: undefined}) | undefined,
  ): Promise<LoadResult<Buffer | string> | undefined>;
  async function loadUrl(
    reqUrl: string,
    opt: LoadUrlOptions & {encoding: BufferEncoding},
  ): Promise<LoadResult<string> | undefined>;
  async function loadUrl(
    reqUrl: string,
    opt: LoadUrlOptions & {encoding: null},
  ): Promise<LoadResult<Buffer> | undefined>;
  async function loadUrl(
    reqUrl: string,
    {
      isSSR: _isSSR,
      isHMR: _isHMR,
      isResolve: _isResolve,
      encoding: _encoding,
      importMap,
    }: LoadUrlOptions = {},
  ): Promise<LoadResult | undefined> {
    const isSSR = _isSSR ?? false;
    //   // Default to HMR on, but disable HMR if SSR mode is enabled.
    const isHMR = _isHMR ?? (!!config.devOptions.hmr && !isSSR);
    const encoding = _encoding ?? null;
    const reqUrlHmrParam = reqUrl.includes('?mtime=') && reqUrl.split('?')[1];
    let reqPath = decodeURI(url.parse(reqUrl).pathname!);

    if (reqPath === getMetaUrlPath('/hmr-client.js', config)) {
      return {
        contents: encodeResponse(HMR_CLIENT_CODE, encoding),
        imports: [],
        originalFileLoc: null,
        contentType: 'application/javascript',
      };
    }
    if (reqPath === getMetaUrlPath('/hmr-error-overlay.js', config)) {
      return {
        contents: encodeResponse(HMR_OVERLAY_CODE, encoding),
        imports: [],
        originalFileLoc: null,
        contentType: 'application/javascript',
      };
    }
    if (reqPath === getMetaUrlPath('/env.js', config)) {
      return {
        contents: encodeResponse(
          generateEnvModule({
            mode: config.mode,
            isSSR,
            configEnv: config.env,
          }),
          encoding,
        ),
        imports: [],
        originalFileLoc: null,
        contentType: 'application/javascript',
      };
    }
    // * NPM Packages:
    // NPM packages are served via `/_snowpack/pkg/` URLs. Behavior varies based on package source (local, remote)
    // but as a general rule all URLs contained within are managed by the package source loader. When this URL
    // prefix is hit, we load the file through the selected package source loader.
    if (reqPath.startsWith(PACKAGE_PATH_PREFIX)) {
      // Backwards-compatable redirect for legacy package URLs: If someone has created an import URL manually
      // (ex: /_snowpack/pkg/react.js) then we need to redirect and warn to use our new API in the future.
      if (reqUrl.split('.').length <= 2 && config.packageOptions.source !== 'remote') {
        if (!warnedDeprecatedPackageImport.has(reqUrl)) {
          logger.warn(
            `(${reqUrl}) Deprecated manual package import. Please use snowpack.getUrlForPackage() to create package URLs instead.`,
          );
          warnedDeprecatedPackageImport.add(reqUrl);
        }
        const redirectUrl = await pkgSource.resolvePackageImport(
          reqUrl.replace(PACKAGE_PATH_PREFIX, '').replace(/\.js/, ''),
        );
        reqPath = decodeURI(url.parse(redirectUrl).pathname!);
      }
      const resourcePath = reqPath.replace(/\.map$/, '').replace(/\.proxy\.js$/, '');
      const webModuleUrl = resourcePath.substr(PACKAGE_PATH_PREFIX.length);
      let loadedModule = await pkgSource.load(webModuleUrl, {isSSR});
      if (!loadedModule) {
        throw new NotFoundError(reqPath);
      }
      if (reqPath.endsWith('.proxy.js')) {
        return {
          imports: [],
          contents: await wrapImportProxy({
            url: resourcePath,
            code: loadedModule.contents,
            hmr: isHMR,
            config: config,
          }),
          originalFileLoc: null,
          contentType: 'application/javascript',
        };
      }
      return {
        imports: loadedModule.imports,
        contents: encodeResponse(loadedModule.contents, encoding),
        originalFileLoc: null,
        contentType: mime.lookup(reqPath) || 'application/javascript',
      };
    }

    // Most of the time, resourcePath should have ".map" and ".proxy.js" extensions stripped to
    // match the file on disk. However, sometimes the on disk is an actual source map in a static
    // directory, so we can't strip that info just yet. Try the exact match first, and then strip
    // it later on if there is no match.
    let resourcePath = reqPath;
    let resourceType = matchOutputExt(reqPath) || '.html';
    let foundFile: FoundFile;

    // * Workspaces & Linked Packages:
    // The "local" package resolver supports npm packages that live in a local directory,
    // usually a part of your monorepo/workspace. Snowpack treats these files as source files,
    // with each file served individually and rebuilt instantly when changed. In the future,
    // these linked packages may be bundled again with a rapid bundler like esbuild.
    if (config.workspaceRoot && reqPath.startsWith(PACKAGE_LINK_PATH_PREFIX)) {
      const symlinkResourceUrl = reqPath.substr(PACKAGE_LINK_PATH_PREFIX.length);
      const symlinkResourceLoc = path.resolve(
        config.workspaceRoot as string,
        process.platform === 'win32' ? symlinkResourceUrl.replace(/\//g, '\\') : symlinkResourceUrl,
      );
      const symlinkResourceDirectory = path.dirname(symlinkResourceLoc);
      const fileStat = await fs.stat(symlinkResourceDirectory).catch(() => null);
      if (!fileStat) {
        throw new NotFoundError(reqPath, [symlinkResourceDirectory]);
      }
      // If this is the first file served out of this linked directory
      // - add it to our file watcher (to enable HMR)
      // - add it to our file<>URL mapping for future lookups
      // - add a promise to our directory<>promise map, which acts as
      //   a guard to ensure no loadUrls for this directory proceed before
      //   proccessing of this directory is done
      // Each directory is scanned shallowly, so nested directories inside
      // of `symlinkDirectories` are okay.
      if (!symlinkDirectories.get(symlinkResourceDirectory)) {
        logger.debug(
          `Mounting symlink directory: '${symlinkResourceDirectory}' as URL '${path.dirname(
            reqPath,
          )}'`,
        );
        symlinkDirectories.set(symlinkResourceDirectory, processDirectory());
        watcher && watcher.add(symlinkResourceDirectory);

        async function processDirectory() {
          const shallowFiles = (await new fdir()
            .withFullPaths()
            .withMaxDepth(0)
            .crawl(symlinkResourceDirectory)
            .withPromise()) as string[];

          for (const f of shallowFiles) {
            if (fileToUrlMapping.value(f)) {
              logger.warn(
                `Warning: mounted file is being imported as a package.\n` +
                  `Workspace & monorepo packages work automatically and do not need to be mounted.`,
              );
            } else {
              fileToUrlMapping.add(
                f,
                getBuiltFileUrls(f, config).map((u) => {
                  const url = path.posix.join(
                    config.buildOptions.metaUrlPath,
                    'link',
                    slash(path.relative(config.workspaceRoot as string, u)),
                  );
                  return url;
                }),
              );
            }
          }
        }
      }

      // guard: ensure directory is properly read and files registered before proceeding
      await symlinkDirectories.get(symlinkResourceDirectory);

      let attemptedFileLoc = fileToUrlMapping.key(reqPath);
      if (!attemptedFileLoc) {
        resourcePath = reqPath.replace(/\.map$/, '').replace(/\.proxy\.js$/, '');
        resourceType = path.extname(resourcePath) || '.html';
      }
      attemptedFileLoc = fileToUrlMapping.key(resourcePath);
      if (!attemptedFileLoc) {
        throw new NotFoundError(reqPath);
      }
      const fileLocationExists = await fs.stat(attemptedFileLoc).catch(() => null);
      if (!fileLocationExists) {
        throw new NotFoundError(reqPath, [attemptedFileLoc]);
      }
      foundFile = {
        loc: attemptedFileLoc,
        type: path.extname(reqPath),
        isStatic: false,
        isResolve: true,
      };
    }
    // * Local Files
    // If this is not a special URL route, then treat it as a normal file request.
    // Check our file<>URL mapping for the most relevant match, and continue if found.
    // Otherwise, return a 404.
    else {
      let attemptedFileLoc = fileToUrlMapping.key(resourcePath);
      if (!attemptedFileLoc) {
        resourcePath = reqPath.replace(/\.map$/, '').replace(/\.proxy\.js$/, '');
        resourceType = path.extname(resourcePath) || '.html';
      }
      attemptedFileLoc =
        fileToUrlMapping.key(resourcePath) ||
        fileToUrlMapping.key(resourcePath + '.html') ||
        fileToUrlMapping.key(resourcePath + 'index.html') ||
        fileToUrlMapping.key(resourcePath + '/index.html');
      if (!attemptedFileLoc) {
        // last attempt: if this is a CSS Module, try and load JSON
        if (resourcePath.endsWith('.module.css.json')) {
          const srcLoc = resourcePath.replace(/\.json$/i, '');
          return {
            imports: [],
            contents: cssModuleJSON(srcLoc),
            originalFileLoc: srcLoc,
            contentType: mime.lookup('.json'),
          };
        }

        throw new NotFoundError(reqPath);
      }

      const [, mountEntry] = getMountEntryForFile(attemptedFileLoc, config)!;

      // TODO: This data type structuring/destructuring is neccesary for now,
      // but we hope to add "virtual file" support soon via plugins. This would
      // be the interface for those response types.
      foundFile = {
        loc: attemptedFileLoc,
        type: path.extname(reqPath) || '.html',
        isStatic: mountEntry.static,
        isResolve: mountEntry.resolve,
      };
    }

    const {loc: fileLoc, type: responseType} = foundFile;

    // TODO: Once plugins are able to add virtual files + imports, this will no longer be needed.
    // - isStatic Workaround: HMR plugins need to add scripts to HTML file, even if static.
    const isStatic = foundFile.isStatic && responseType !== '.html';
    const isResolve = _isResolve ?? true;

    // 1. Check the hot build cache. If it's already found, then just serve it.
    const cacheKey = getCacheKey(fileLoc, {isSSR, mode: config.mode});
    let fileBuilder: FileBuilder | undefined = inMemoryBuildCache.get(cacheKey);
    if (!fileBuilder) {
      fileBuilder = new FileBuilder({
        loc: fileLoc,
        isDev,
        isSSR,
        isHMR,
        config,
        hmrEngine,
      });
      // note: for Tailwind, CSS needs to avoid caching in dev server (Tailwind needs to handle rebuilding, not Snowpack)
      const isTailwind =
        config.devOptions.tailwindConfig && (fileLoc.endsWith('.css') || fileLoc.endsWith('.pcss'));
      if (!isTailwind) {
        inMemoryBuildCache.set(cacheKey, fileBuilder);
      }
    }

    function handleFinalizeError(err: Error) {
      logger.error(FILE_BUILD_RESULT_ERROR);
      hmrEngine &&
        hmrEngine.broadcastMessage({
          type: 'error',
          title: FILE_BUILD_RESULT_ERROR,
          errorMessage: err.toString(),
          fileLoc,
          errorStackTrace: err.stack,
        });
    }

    let finalizedResponse: string | Buffer | undefined;
    let resolvedImports: InstallTarget[] = [];
    try {
      if (Object.keys(fileBuilder.buildOutput).length === 0) {
        await fileBuilder.build(isStatic);
      }
      if (resourcePath !== reqPath && reqPath.endsWith('.proxy.js')) {
        finalizedResponse = await fileBuilder.getProxy(resourcePath, resourceType);

        // CSS Modules only: also generate JSON module mapping (not imported so must be added manually)
        if (reqPath.endsWith('.module.css.proxy.js') && fileBuilder.buildOutput['.json']) {
          resolvedImports.push(createInstallTarget(`${resourcePath}.json`));
        }
      } else if (resourcePath !== reqPath && reqPath.endsWith('.map')) {
        finalizedResponse = fileBuilder.getSourceMap(resourcePath);
      } else {
        if (foundFile.isResolve) {
          // TODO: Warn if reqUrlHmrParam was needed here? HMR can't work if URLs aren't resolved.
          resolvedImports = await fileBuilder.resolveImports(isResolve, reqUrlHmrParam, importMap);
        }
        finalizedResponse = fileBuilder.getResult(resourceType);
      }
    } catch (err) {
      handleFinalizeError(err);
      throw err;
    }

    if (finalizedResponse) {
      return {
        imports: resolvedImports,
        contents: encodeResponse(finalizedResponse, encoding),
        originalFileLoc: fileLoc,
        contentType: mime.lookup(responseType),
      };
    }
  }

  /**
   * A simple map to optimize the speed of our 304 responses. If an ETag check is
   * sent in the request, check if it matches the last known etag for tat file.
   *
   * Remember: This is just a nice-to-have! If we get this logic wrong, it can mean
   * stale files in the user's cache. Feel free to clear aggressively, as needed.
   */
  const knownETags = new Map<string, string>();

  function matchRouteHandler(
    reqUrl: string,
    expectHandler: 'dest',
  ): RouteConfigObject['dest'] | null;
  function matchRouteHandler(
    reqUrl: string,
    expectHandler: 'upgrade',
  ): RouteConfigObject['upgrade'] | null;
  function matchRouteHandler(
    reqUrl: string,
    expectHandler: 'dest' | 'upgrade',
  ): RouteConfigObject['dest'] | RouteConfigObject['upgrade'] | null {
    if (reqUrl.startsWith(config.buildOptions.metaUrlPath)) {
      return null;
    }
    const reqPath = decodeURI(url.parse(reqUrl).pathname!);
    const reqExt = matchOutputExt(reqPath);
    const isRoute = !reqExt || reqExt.toLowerCase() === '.html';
    for (const route of config.routes) {
      if (route.match === 'routes' && !isRoute) {
        continue;
      }
      if (!route[expectHandler]) {
        continue;
      }
      if (route._srcRegex.test(reqPath)) {
        return route[expectHandler];
      }
    }
    return null;
  }

  /**
   * Fully handle the response for a given request. This is used internally for
   * every response that the dev server sends, but it can also be used via the
   * JS API to handle most boilerplate around request handling.
   */
  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    {handleError}: {handleError?: boolean} = {},
  ) {
    let reqUrl = req.url!;
    const matchedRouteHandler = matchRouteHandler(reqUrl, 'dest');
    // If a route is matched, rewrite the URL or call the route function
    if (matchedRouteHandler) {
      if (typeof matchedRouteHandler === 'string') {
        reqUrl = matchedRouteHandler;
      } else {
        return matchedRouteHandler(req, res);
      }
    }
    // Check if we can send back an optimized 304 response
    const quickETagCheck = req.headers['if-none-match'];
    const quickETagCheckUrl = reqUrl.replace(/\/$/, '/index.html');
    if (quickETagCheck && quickETagCheck === knownETags.get(quickETagCheckUrl)) {
      logger.debug(`optimized etag! sending 304...`);
      res.writeHead(304, {'Access-Control-Allow-Origin': '*'});
      res.end();
      return;
    }
    // Backwards-compatable redirect for legacy package URLs: If someone has created an import URL manually
    // (ex: /_snowpack/pkg/react.js) then we need to redirect and warn to use our new API in the future.
    if (
      reqUrl.startsWith(PACKAGE_PATH_PREFIX) &&
      reqUrl.split('.').length <= 2 &&
      config.packageOptions.source !== 'remote'
    ) {
      if (!warnedDeprecatedPackageImport.has(reqUrl)) {
        logger.warn(
          `(${reqUrl}) Deprecated manual package import. Please use snowpack.getUrlForPackage() to create package URLs instead.`,
        );
        warnedDeprecatedPackageImport.add(reqUrl);
      }
      const redirectUrl = await pkgSource.resolvePackageImport(
        reqUrl.replace(PACKAGE_PATH_PREFIX, '').replace(/\.js/, ''),
      );
      res.writeHead(301, {Location: redirectUrl});
      res.end();
      return;
    }

    // Otherwise, load the file and respond if successful.
    try {
      const result = await loadUrl(reqUrl, {allowStale: true, encoding: null});
      if (!result) {
        throw new NotFoundError(reqUrl);
      }
      sendResponseFile(req, res, result);
      if (result.checkStale) {
        await result.checkStale();
      }
      if (result.contents) {
        const tag = etag(result.contents, {weak: true});
        const reqPath = decodeURI(url.parse(reqUrl).pathname!);
        knownETags.set(reqPath, tag);
      }
      return;
    } catch (err) {
      // Some consumers may want to handle/ignore errors themselves.
      if (handleError === false) {
        throw err;
      }
      handleResponseError(req, res, err);
    }
  }

  async function handleUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer) {
    let reqUrl = req.url!;
    const matchedRouteHandler = matchRouteHandler(reqUrl, 'upgrade');
    if (matchedRouteHandler) {
      matchedRouteHandler(req, socket, head);
      return;
    }
  }

  type Http2RequestListener = (
    request: http2.Http2ServerRequest,
    response: http2.Http2ServerResponse,
  ) => void;
  const createServer = (responseHandler: http.RequestListener | Http2RequestListener) => {
    if (credentials) {
      return http2.createSecureServer(
        {...credentials!, allowHTTP1: true},
        responseHandler as Http2RequestListener,
      );
    }

    return http.createServer(responseHandler as http.RequestListener);
  };

  let server: http.Server | http2.Http2Server | undefined;
  if (port) {
    server = createServer(async (req, res) => {
      // Attach a request logger.
      res.on('finish', () => {
        const {method, url} = req;
        const {statusCode} = res;
        logger.debug(`[${statusCode}] ${method} ${url}`);
      });
      // Otherwise, pass requests directly to Snowpack's request handler.
      handleRequest(req, res);
    })
      .on('upgrade', (req, socket, head) => {
        handleUpgrade(req, socket, head);
      })
      .on('error', (err: Error) => {
        logger.error(colors.red(`  ✘ Failed to start server at port ${colors.bold(port!)}.`), err);
        server!.close();
        process.exit(1);
      })
      .listen(port);

    // Announce server has started
    const remoteIps = Object.values(os.networkInterfaces())
      .reduce((every: os.NetworkInterfaceInfo[], i) => [...every, ...(i || [])], [])
      .filter((i) => i.family === 'IPv4' && i.internal === false)
      .map((i) => i.address);
    const protocol = config.devOptions.secure ? 'https:' : 'http:';

    // Log the successful server start.
    const startTimeMs = Math.round(performance.now() - serverStart);
    logger.info(colors.green(`Server started in ${startTimeMs}ms.`));
    logger.info(`${colors.green('Local:')} ${`${protocol}//${hostname}:${port}`}`);
    if (remoteIps.length > 0) {
      logger.info(`${colors.green('Network:')} ${`${protocol}//${remoteIps[0]}:${port}`}`);
    }
  }

  // HMR Engine
  const {hmrEngine, handleHmrUpdate} = config.devOptions.hmr
    ? startHmrEngine(inMemoryBuildCache, server, port, config)
    : {hmrEngine: undefined, handleHmrUpdate: undefined};

  // Allow the user to hook into this callback, if they like (noop by default)
  let onFileChangeCallback: OnFileChangeCallback = () => {};
  let watcher: FSWatcher | undefined;

  // Watch src files
  async function onWatchEvent(fileLoc: string) {
    logger.info(
      colors.cyan('File changed: ') + path.relative(config.workspaceRoot || config.root, fileLoc),
    );

    const updatedUrls = getUrlsForFile(fileLoc, config);
    if (updatedUrls) {
      handleHmrUpdate && handleHmrUpdate(fileLoc, updatedUrls[0]);
      knownETags.delete(updatedUrls[0]);
      knownETags.delete(updatedUrls[0] + '.proxy.js');
    }
    inMemoryBuildCache.delete(getCacheKey(fileLoc, {isSSR: true, mode: config.mode}));
    inMemoryBuildCache.delete(getCacheKey(fileLoc, {isSSR: false, mode: config.mode}));
    await onFileChangeCallback({filePath: fileLoc});

    for (const plugin of config.plugins) {
      plugin.onChange && plugin.onChange({filePath: fileLoc});
    }
  }

  if (isWatch) {
    // Start watching the file system.
    // Defer "chokidar" loading to here, to reduce impact on overall startup time
    const chokidar = await import('chokidar');
    watcher = chokidar.watch([], {
      ignored: config.exclude.filter((k) => k !== '**/_*.{sass,scss}'), // Sass partials ignored for builds, but not for dev changes
      persistent: true,
      ignoreInitial: true,
      disableGlobbing: false,
      useFsEvents: isFsEventsEnabled(),
    });
    watcher.on('add', async (fileLoc) => {
      knownETags.clear();
      await pkgSource.prepareSingleFile(fileLoc);
      await onWatchEvent(fileLoc);
      fileToUrlMapping.add(fileLoc, getUrlsForFile(fileLoc, config)!);
    });
    watcher.on('unlink', async (fileLoc) => {
      knownETags.clear();
      await onWatchEvent(fileLoc);
      fileToUrlMapping.delete(fileLoc);
    });
    watcher.on('change', async (fileLoc) => {
      // TODO: If this needs to build a new dependency, report to the browser via HMR event.
      await pkgSource.prepareSingleFile(fileLoc);
      await onWatchEvent(fileLoc);
    });
    // [hmrDelay] - Let users with noisy startups delay HMR (ex: 11ty, tsc builds)
    setTimeout(() => {
      watcher!.add(Object.keys(config.mount));
      if (config.devOptions.output !== 'dashboard' || !process.stdout.isTTY) {
        logger.info(colors.cyan('watching for file changes... '));
      }
    }, config.devOptions.hmrDelay);
  }

  // Open the user's browser (ignore if failed)
  if (server && port && open && open !== 'none') {
    const protocol = config.devOptions.secure ? 'https:' : 'http:';
    await openInBrowser(protocol, hostname, port, open, openUrl).catch((err) => {
      logger.debug(`Browser open error: ${err}`);
    });
  }

  const sp: SnowpackDevServer = {
    port: port || defaultPort,
    hmrEngine,
    rawServer: server,
    loadUrl,
    handleRequest,
    sendResponseFile,
    sendResponseError,
    getUrlForPackage: (pkgSpec: string) => {
      return pkgSource.resolvePackageImport(pkgSpec);
    },
    getUrlForFile: (fileLoc: string) => {
      const result = getUrlsForFile(fileLoc, config);
      return result ? result[0] : null;
    },
    onFileChange: (callback) => (onFileChangeCallback = callback),
    getServerRuntime: (options) => getServerRuntime(sp, config, options),
    async shutdown() {
      watcher && (await watcher.close());
      await runPipelineCleanupStep(config);
      server && server.close();
      hmrEngine && (await hmrEngine.stop());
    },
  };
  return sp;
}

export async function command(commandOptions: CommandOptions) {
  try {
    // Set some CLI-focused defaults
    commandOptions.config.devOptions.output =
      commandOptions.config.devOptions.output || 'dashboard';
    commandOptions.config.devOptions.open = commandOptions.config.devOptions.open || 'default';
    commandOptions.config.devOptions.hmr = commandOptions.config.devOptions.hmr !== false;
    // Start the server
    await startServer(commandOptions, {isWatch: true});
  } catch (err) {
    logger.error(err.message);
    logger.debug(err.stack);
    process.exit(1);
  }
  return new Promise(() => {});
}
