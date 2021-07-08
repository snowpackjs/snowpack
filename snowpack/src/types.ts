import type {InstallOptions as EsinstallOptions, InstallTarget} from 'esinstall';
import type {Loader} from 'esbuild';
import type * as net from 'net';
import type * as http from 'http';
import type * as http2 from 'http2';
import type {EsmHmrEngine} from './hmr-server-engine';

// RawSourceMap is inlined here for bundle purposes.
// import type {RawSourceMap} from 'source-map';
export interface RawSourceMap {
  version: number;
  sources: string[];
  names: string[];
  sourceRoot?: string;
  sourcesContent?: string[];
  mappings: string;
  file: string;
}

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T[P] extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepPartial<U>>
    : DeepPartial<T[P]>;
};

export interface ServerRuntimeConfig {
  config: SnowpackConfig;
  load: (url: string) => Promise<LoadResult<string>>;
}
export interface ServerRuntime {
  importModule: <T = any>(url: string) => Promise<ServerRuntimeModule<T>>;
  invalidateModule: (url: string) => void;
}

export interface ServerRuntimeModule<T extends any> {
  exports: T;
  css: string[];
}

export interface LoadResult<T = Buffer | string> {
  contents: T;
  imports: InstallTarget[];
  originalFileLoc: string | null;
  contentType: string | false;
  checkStale?: () => Promise<void>;
}

export type OnFileChangeCallback = ({filePath: string}) => any;
export interface LoadUrlOptions {
  isSSR?: boolean;
  isHMR?: boolean;
  isResolve?: boolean;
  allowStale?: boolean;
  encoding?: undefined | BufferEncoding | null;
  importMap?: ImportMap;
}

export interface SnowpackDevServer {
  port: number;
  hmrEngine?: EsmHmrEngine;
  rawServer?: http.Server | http2.Http2Server | undefined;
  loadUrl: {
    (reqUrl: string, opt?: (LoadUrlOptions & {encoding?: undefined}) | undefined): Promise<
      LoadResult<Buffer | string> | undefined
    >;
    (reqUrl: string, opt: LoadUrlOptions & {encoding: BufferEncoding}): Promise<
      LoadResult<string> | undefined
    >;
    (reqUrl: string, opt: LoadUrlOptions & {encoding: null}): Promise<
      LoadResult<Buffer> | undefined
    >;
  };
  handleRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: {handleError?: boolean},
  ) => Promise<void>;
  sendResponseFile: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    {contents, originalFileLoc, contentType}: LoadResult,
  ) => void;
  getServerRuntime: (options?: {invalidateOnChange?: boolean}) => ServerRuntime;
  sendResponseError: (req: http.IncomingMessage, res: http.ServerResponse, status: number) => void;
  getUrlForFile: (fileLoc: string) => string | null;
  getUrlForPackage: (packageSpec: string) => Promise<string>;
  onFileChange: (callback: OnFileChangeCallback) => void;
  shutdown(): Promise<void>;
  markChanged: (fileLoc: string) => void;
}

export type SnowpackBuildResultFileManifest = Record<
  string,
  {source: string | null; contents: string | Buffer}
>;

export interface SnowpackBuildResult {
  // result: SnowpackBuildResultFileManifest;
  onFileChange: (callback: OnFileChangeCallback) => void;
  shutdown(): Promise<void>;
}

export type SnowpackBuiltFile = {
  code: string | Buffer;
  map?: string;
};

export type SnowpackBuildMap = Record<string, SnowpackBuiltFile>;

/** Standard file interface */
export interface SnowpackSourceFile<Type = string | Buffer> {
  /** base extension (e.g. `.js`) */
  baseExt: string;
  /** file contents */
  contents: Type;
  /** if no location on disk, assume this exists in memory */
  locOnDisk: string;
  /** project "root" directory */
  root: string;
}

export interface PluginLoadOptions {
  /** The absolute file path of the source file, on disk. */
  filePath: string;
  /** A helper for just the file extension of the source file (ex: ".js", ".svelte") */
  fileExt: string;
  /** True if builder is in dev mode (`snowpack dev` or `snowpack build --watch`) */
  isDev: boolean;
  /** True if HMR is enabled (add any HMR code to the output here). */
  isHmrEnabled: boolean;
  /** True if builder is in SSR mode */
  isSSR: boolean;
  /** True if file being transformed is inside of a package. */
  isPackage: boolean;
}

export interface PluginTransformOptions {
  /** The final build file path (note: this may differ from the source, e.g. `.vue` will yield `.js` and `.css` IDs) */
  id: string;
  /** The original source location on disk (it may differ from ID) */
  srcPath: string;
  /** The extension of the file */
  fileExt: string;
  /** Contents of the file to transform */
  contents: string | Buffer;
  /** True if builder is in dev mode (`snowpack dev` or `snowpack build --watch`) */
  isDev: boolean;
  /** True if HMR is enabled (add any HMR code to the output here). */
  isHmrEnabled: boolean;
  /** True if builder is in SSR mode */
  isSSR: boolean;
  /** True if file being transformed is inside of a package. */
  isPackage: boolean;
}

export interface PluginRunOptions {
  isDev: boolean;
}

/** map of extensions -> code (e.g. { ".js": "[code]", ".css": "[code]" }) */
export type PluginLoadResult = SnowpackBuildMap;

export type PluginTransformResult = {contents: string; map: string | RawSourceMap};

export interface PluginOptimizeOptions {
  buildDirectory: string;
}

export interface SnowpackPlugin {
  /** name of the plugin */
  name: string;
  /** Tell Snowpack how the load() function will resolve files. */
  resolve?: {
    /**
       file extensions that this load function takes as input (e.g. [".jsx",
       ".js", …])
     */
    input: string[];
    /**
       file extensions that this load function outputs (e.g. [".js", ".css"])
     */
    output: string[];
  };
  /** load a file that matches resolve.input */
  load?(options: PluginLoadOptions): Promise<PluginLoadResult | string | null | undefined | void>;
  /** transform a file that matches resolve.input */
  transform?(
    options: PluginTransformOptions,
  ): Promise<PluginTransformResult | string | null | undefined | void>;
  /** runs a command, unrelated to file building (e.g. TypeScript, ESLint) */
  run?(options: PluginRunOptions): Promise<unknown>;
  /** optimize the entire built application */
  optimize?(options: PluginOptimizeOptions): Promise<void>;
  /** cleanup any long-running instances/services before exiting.  */
  cleanup?(): void | Promise<void>;
  /** Known dependencies that should be installed */
  knownEntrypoints?: string[];
  /** read and modify the Snowpack config object */
  config?(snowpackConfig: SnowpackConfig): void;
  /** Called when a watched file changes during development. */
  onChange?({filePath}: {filePath: string}): void;
  /** (internal interface, not set by the user) Mark a file as changed. */
  markChanged?(file: string): void;
}

/** Snowpack Build Plugin type */
export type SnowpackPluginFactory<PluginOptions = object> = (
  snowpackConfig: SnowpackConfig,
  pluginOptions?: PluginOptions,
) => SnowpackPlugin;

export type MountEntry = {
  url: string;
  static: boolean;
  resolve: boolean;
  dot: boolean;
};

export interface OptimizeOptions {
  entrypoints: 'auto' | string[] | ((options: {files: string[]}) => string[]);
  preload: boolean;
  bundle: boolean;
  loader?: {[ext: string]: Loader};
  sourcemap: boolean | 'both' | 'inline' | 'external';
  splitting: boolean;
  treeshake: boolean;
  manifest: boolean;
  minify: boolean;
  target: 'es2020' | 'es2019' | 'es2018' | 'es2017';
}

/**
 * {@link http.IncomingMessage} as a value type -- exposes data properties
 * without exposing access to sockets, streams, methods or iterators.
 */
export type Http1RequestData = Pick<
http.IncomingMessage,
'aborted' | 'httpVersion' | 'httpVersionMajor' | 'httpVersionMinor' | 'complete' | 'headers' | 'rawHeaders' | 'trailers' | 'rawTrailers' | 'method' | 'url'
>
/**
 * {@link http2.Http2ServerRequest} as a value type -- exposes data properties
 * without exposing access to sockets, streams, methods or iterators.
 */
export type Http2RequestData = Pick<
http2.Http2ServerRequest,
'aborted' | 'httpVersion' | 'httpVersionMajor' | 'httpVersionMinor' | 'complete' | 'headers' | 'rawHeaders' | 'trailers' | 'rawTrailers' | 'method' | 'url' | 'authority' | 'scheme'
>
/**
 * {@link http.IncomingMessage} or {@link http2.Http2ServerRequest} as a value type -- exposes data properties
 * without exposing access to sockets, streams, methods or iterators.
 * This is provided so that users of dev-server APIs may make decisions about
 * how to route a request (or transform its response), without being able to perform
 * side-effects upon the request handle.
 */
export type HttpRequestData = Http1RequestData | Http2RequestData;
export type DevServerResponseHeaders = http.OutgoingHttpHeaders;

/**
 * @param req the HTTP request. you can use this to check (for example) the file extension of the asset being requested.
 * @param proposed the HTTP response headers with which snowpack dev server intends to serve the asset
 * @returns your preferred HTTP response headers (snowpack dev server will serve the asset with these instead)
 * See {@link import('./commands/dev').isHttp2RequestData} for how to narrow the type of {@link HttpRequestData}.
 */
export type HeadersTransformer = (
  req: HttpRequestData,
  proposed: DevServerResponseHeaders
) => DevServerResponseHeaders;

export interface RouteConfigObject {
  src: string;
  dest: string | ((req: http.IncomingMessage, res: http.ServerResponse) => void) | undefined;
  /**
   * This callback (if supplied) will be invoked immediately prior to snowpack dev server's
   * writing of HTTP response headers. Use it to override the response headers, for example
   * to change the Content-Type or CORS policies with which assets are served.
   */
  transformHeaders?: HeadersTransformer;
  upgrade: ((req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void) | undefined;
  match: 'routes' | 'all';
  _srcRegex: RegExp;
}

export interface PackageOptionsLocal
  extends Omit<
    EsinstallOptions,
    'alias' | 'dest' | 'sourcemap' | 'verbose' | 'logger' | 'cwd' | 'dest' | 'treeshake'
  > {
  source: 'local' | 'remote-next' | {[key: string]: string};
  external: string[];
  knownEntrypoints: string[];
}

export interface PackageOptionsRemote {
  source: 'remote';
  external: string[];
  knownEntrypoints: string[];
  origin: string;
  cache: string;
  types: boolean;
}

// interface this library uses internally
export interface SnowpackConfig {
  root: string;
  mode: 'test' | 'development' | 'production';
  workspaceRoot?: string | false;
  extends?: string;
  exclude: string[];
  env?: Record<string, string | boolean | undefined>;
  mount: Record<string, MountEntry>;
  alias: Record<string, string>;
  plugins: SnowpackPlugin[];
  dependencies: Record<string, string>;
  devOptions: {
    secure: boolean | {cert: string | Buffer; key: string | Buffer};
    hostname: string;
    port: number;
    openUrl?: string;
    open?: string;
    output?: 'stream' | 'dashboard';
    hmr?: boolean;
    hmrDelay: number;
    hmrPort: number | undefined;
    hmrErrorOverlay: boolean;
    tailwindConfig?: string;
  };
  buildOptions: {
    out: string;
    baseUrl: string;
    metaUrlPath: string;
    cacheDirPath: string;
    clean: boolean;
    sourcemap: 'inline' | false | undefined;
    watch: boolean;
    htmlFragments: boolean;
    jsxFactory: string | undefined;
    jsxFragment: string | undefined;
    jsxInject: string | undefined;
    ssr: boolean;
    resolveProxyImports: boolean;
  };
  testOptions: {
    files: string[];
  };
  packageOptions: PackageOptionsLocal | PackageOptionsRemote;
  /** Optimize your site for production. */
  optimize?: OptimizeOptions;
  /** Configure routes during development. */
  routes: RouteConfigObject[];
  /** EXPERIMENTAL - This section is experimental and not yet finalized. May change across minor versions. */
  experiments: {
    /* intentionally left blank */
  };
  _extensionMap: Record<string, string[]>;
}

export type SnowpackUserConfig = {
  root?: string;
  mode?: SnowpackConfig['mode'];
  workspaceRoot?: string;
  install?: string[];
  env?: Record<string, string>;
  extends?: string;
  exclude?: string[];
  mount?: Record<string, string | Partial<MountEntry>>;
  alias?: Record<string, string>;
  plugins?: (string | [string, any])[];
  dependencies?: Record<string, string>;
  devOptions?: Partial<SnowpackConfig['devOptions']>;
  buildOptions?: Partial<SnowpackConfig['buildOptions']>;
  testOptions?: Partial<SnowpackConfig['testOptions']>;
  packageOptions?: Partial<SnowpackConfig['packageOptions']>;
  optimize?: Partial<SnowpackConfig['optimize']>;
  routes?: Pick<RouteConfigObject, 'src' | 'dest' | 'match' | 'transformHeaders'>[];
  experiments?: {
    /* intentionally left blank */
  };
};
export interface CLIFlags {
  help?: boolean; // display help text
  version?: boolean; // display Snowpack version
  reload?: boolean;
  root?: string; // manual path to project root
  config?: string; // manual path to config file
  env?: string[]; // env vars
  open?: string[];
  secure?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  [flag: string]: any;
}

export interface ImportMap {
  imports: {[specifier: string]: string};
}

export interface LockfileManifest {
  dependencies: {[packageName: string]: string};
  lock: {[specifier: string]: string};
}

export interface CommandOptions {
  config: SnowpackConfig;
  lockfile?: LockfileManifest | null;
}

export type LoggerLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'; // same as Pino
export type LoggerEvent = 'debug' | 'info' | 'warn' | 'error';
export interface LoggerOptions {
  /** (optional) change name at beginning of line */
  name?: string;
  /** (optional) do some additional work after logging a message, if log level is enabled */
  task?: Function;
}

/** PackageSource - a common interface for loading and interacting with dependencies.  */
export interface PackageSource {
  /**
   * Do any work needed before starting the dev server or build. Either will wait
   * for this to complete before continuing. Example: For "local", this involves
   * running esinstall (if needed) to prepare your local dependencies as ESM.
   */
  prepare(): Promise<void>;
  /**
   * Like prepare(), but only looks at a single file and meant to run at anytime,
   * usually after the server has already started and is running.
   */
  prepareSingleFile(fileLoc: string): Promise<void>;
  /**
   * Load a dependency with the given spec (ex: "/pkg/react" -> "react")
   * If load fails or is unsuccessful, reject the promise.
   */
  load(
    spec: string,
    options: {isSSR: boolean},
  ): Promise<undefined | {contents: Buffer | string; imports: InstallTarget[]}>;
  /** Resolve a package import to URL (ex: "react" -> "/pkg/react") */
  resolvePackageImport(
    spec: string,
    options?: {source?: string; importMap?: ImportMap; depth?: number},
  ): Promise<string>;
  /** Modify the build install config for optimized build install. */
  modifyBuildInstallOptions(
    installOptions: EsinstallOptions,
    installTargets: InstallTarget[],
  ): Promise<EsinstallOptions>;
  getCacheFolder(): string;
  clearCache(): void | Promise<void>;
}

export type ScannableExt =
  | '.astro'
  | '.cjs'
  | '.css'
  | '.html'
  | '.interface'
  | '.js'
  | '.jsx'
  | '.less'
  | '.mjs'
  | '.sass'
  | '.scss'
  | '.svelte'
  | '.ts'
  | '.tsx'
  | '.vue';
