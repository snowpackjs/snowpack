import crypto from 'crypto';
import {all as merge} from 'deepmerge';
import projectCacheDir from 'find-cache-dir';
import {existsSync} from 'fs';
import {isPlainObject} from 'is-plain-object';
import {validate} from 'jsonschema';
import {dim} from 'kleur/colors';
import os from 'os';
import path from 'path';
import {logger} from './logger';
import {esbuildPlugin} from './plugins/plugin-esbuild';
import {
  CLIFlags,
  MountEntry,
  PackageOptionsLocal,
  PackageOptionsRemote,
  PluginLoadResult,
  RouteConfigObject,
  SnowpackConfig,
  SnowpackPlugin,
  SnowpackUserConfig,
} from './types';
import {
  addLeadingSlash,
  addTrailingSlash,
  NATIVE_REQUIRE,
  REQUIRE_OR_IMPORT,
  removeTrailingSlash,
  isPathImport,
} from './util';
import {GLOBAL_CACHE_DIR} from './sources/util';
import type {Awaited} from './util';

const CONFIG_NAME = 'snowpack';
const ALWAYS_EXCLUDE = ['**/_*.{sass,scss}', '**.d.ts'];
const DEFAULT_PROJECT_CACHE_DIR =
  projectCacheDir({name: 'snowpack'}) ||
  // If `projectCacheDir()` is null, no node_modules directory exists.
  // Use the current path (hashed) to create a cache entry in the global cache instead.
  // Because this is specifically for dependencies, this fallback should rarely be used.
  path.join(GLOBAL_CACHE_DIR, crypto.createHash('md5').update(process.cwd()).digest('hex'));

// default settings
const DEFAULT_ROOT = process.cwd();
const DEFAULT_CONFIG: SnowpackUserConfig = {
  root: DEFAULT_ROOT,
  plugins: [],
  alias: {},
  env: {},
  exclude: [],
  routes: [],
  dependencies: {},
  devOptions: {
    secure: false,
    hostname: 'localhost',
    port: 8080,
    hmrDelay: 0,
    hmrPort: undefined,
    hmrErrorOverlay: true,
  },
  buildOptions: {
    out: 'build',
    baseUrl: '/',
    metaUrlPath: '_snowpack',
    cacheDirPath: DEFAULT_PROJECT_CACHE_DIR,
    clean: true,
    sourcemap: false,
    watch: false,
    htmlFragments: false,
    ssr: false,
    resolveProxyImports: true,
  },
  testOptions: {
    files: ['__tests__/**/*', '**/*.@(spec|test).*'],
  },
  packageOptions: {source: 'local'},
};

export const DEFAULT_PACKAGES_LOCAL_CONFIG: PackageOptionsLocal = {
  source: 'local',
  external: [],
  packageLookupFields: [],
  knownEntrypoints: [],
};

export const REMOTE_PACKAGE_ORIGIN = 'https://pkg.snowpack.dev';

const DEFAULT_PACKAGES_REMOTE_CONFIG: PackageOptionsRemote = {
  source: 'remote',
  origin: REMOTE_PACKAGE_ORIGIN,
  external: [],
  knownEntrypoints: [],
  cache: '.snowpack',
  types: false,
};

const configSchema = {
  type: 'object',
  properties: {
    mode: {type: 'string', enum: ['test', 'development', 'production']},
    extends: {type: 'string'},
    exclude: {type: 'array', items: {type: 'string'}},
    plugins: {type: 'array'},
    env: {type: 'object'},
    alias: {
      type: 'object',
      additionalProperties: {type: 'string'},
    },
    mount: {
      type: 'object',
      additionalProperties: {
        oneOf: [
          {type: 'string'},
          {
            type: ['object'],
            properties: {
              url: {type: 'string'},
              static: {type: 'boolean'},
              resolve: {type: 'boolean'},
              dot: {type: 'boolean'},
            },
          },
        ],
      },
    },
    devOptions: {
      type: 'object',
      properties: {
        secure: {
          oneOf: [
            {type: 'boolean'},
            {
              type: 'object',
              properties: {
                cert: {},
                key: {},
              },
            },
          ],
        },
        port: {type: 'number'},
        openUrl: {type: 'string'},
        open: {type: 'string'},
        output: {type: 'string', enum: ['stream', 'dashboard']},
        hmr: {type: 'boolean'},
        hmrDelay: {type: 'number'},
        hmrPort: {type: 'number'},
        hmrErrorOverlay: {type: 'boolean'},
        tailwindConfig: {type: 'string'},
      },
    },
    packageOptions: {
      type: 'object',
      properties: {
        dest: {type: 'string'},
        external: {type: 'array', items: {type: 'string'}},
        treeshake: {type: 'boolean'},
        installTypes: {type: 'boolean'},
        polyfillNode: {type: 'boolean'},
        env: {
          type: 'object',
          additionalProperties: {
            oneOf: [
              {id: 'EnvVarString', type: 'string'},
              {id: 'EnvVarNumber', type: 'number'},
              {id: 'EnvVarTrue', type: 'boolean', enum: [true]},
            ],
          },
        },
        rollup: {
          type: 'object',
          properties: {
            context: {type: 'string'},
            plugins: {type: 'array', items: {type: 'object'}},
            dedupe: {
              type: 'array',
              items: {type: 'string'},
            },
          },
        },
      },
    },
    buildOptions: {
      type: ['object'],
      properties: {
        out: {type: 'string'},
        baseUrl: {type: 'string'},
        cacheDirPath: {type: 'string'},
        clean: {type: 'boolean'},
        sourcemap: {
          oneOf: [{type: 'boolean'}, {type: 'string', enum: ['inline']}],
        },
        watch: {type: 'boolean'},
        ssr: {type: 'boolean'},
        htmlFragments: {type: 'boolean'},
        jsxFactory: {type: 'string'},
        jsxFragment: {type: 'string'},
        jsxInject: {type: 'string'},
      },
    },
    testOptions: {
      type: 'object',
      properties: {
        files: {type: 'array', items: {type: 'string'}},
      },
    },
    experiments: {
      type: ['object'],
      properties: {},
    },
    optimize: {
      type: ['object'],
      properties: {
        preload: {type: 'boolean'},
        bundle: {type: 'boolean'},
        loader: {type: 'object'},
        splitting: {type: 'boolean'},
        treeshake: {type: 'boolean'},
        manifest: {type: 'boolean'},
        minify: {type: 'boolean'},
        target: {type: 'string'},
      },
    },
    proxy: {
      type: 'object',
    },
  },
};

/**
 * Convert CLI flags to an incomplete Snowpack config representation.
 * We need to be careful about setting properties here if the flag value
 * is undefined, since the deep merge strategy would then overwrite good
 * defaults with 'undefined'.
 */
export function expandCliFlags(flags: CLIFlags): SnowpackUserConfig {
  const result = {
    packageOptions: {},
    devOptions: {},
    buildOptions: {},
    experiments: {},
  } as {packageOptions: any; devOptions: any; buildOptions: any; experiments: any; optimize?: any};
  const {help, version, reload, config, ...relevantFlags} = flags;

  const CLI_ONLY_FLAGS = ['quiet', 'verbose'];

  for (const [flag, val] of Object.entries(relevantFlags)) {
    if (flag === '_' || flag.includes('-')) {
      continue;
    }
    if (configSchema.properties[flag]) {
      result[flag] = val;
      continue;
    }
    if (flag === 'source') {
      result.packageOptions = {source: val};
      continue;
    }
    if (configSchema.properties.experiments.properties[flag]) {
      result.experiments[flag] = val;
      continue;
    }
    if (configSchema.properties.optimize.properties[flag]) {
      result.optimize = result.optimize || {};
      result.optimize[flag] = val;
      continue;
    }
    if (configSchema.properties.packageOptions.properties[flag]) {
      result.packageOptions[flag] = val;
      continue;
    }
    if (configSchema.properties.devOptions.properties[flag]) {
      result.devOptions[flag] = val;
      continue;
    }
    if (configSchema.properties.buildOptions.properties[flag]) {
      result.buildOptions[flag] = val;
      continue;
    }
    if (CLI_ONLY_FLAGS.includes(flag)) {
      continue;
    }
    logger.error(`Unknown CLI flag: "${flag}"`);
    process.exit(1);
  }
  if (result.packageOptions.env) {
    result.packageOptions.env = result.packageOptions.env.reduce((acc, id) => {
      const index = id.indexOf('=');
      const [key, val] = index > 0 ? [id.substr(0, index), id.substr(index + 1)] : [id, true];
      acc[key] = val;
      return acc;
    }, {});
  }
  return result;
}

/** load and normalize plugins from config */
function loadPlugins(config: SnowpackConfig): {
  plugins: SnowpackPlugin[];
  extensionMap: Record<string, string[]>;
} {
  const plugins: SnowpackPlugin[] = [];

  function execPluginFactory(pluginFactory: any, pluginOptions: any = {}): SnowpackPlugin {
    let plugin: SnowpackPlugin | null = null;
    plugin = pluginFactory(config, pluginOptions) as SnowpackPlugin;
    return plugin;
  }

  function loadPluginFromConfig(
    pluginLoc: string,
    options: any,
    config: SnowpackConfig,
  ): SnowpackPlugin {
    if (!path.isAbsolute(pluginLoc)) {
      throw new Error(
        `Snowpack Internal Error: plugin ${pluginLoc} should have been resolved to an absolute path.`,
      );
    }
    const pluginRef = NATIVE_REQUIRE(pluginLoc, {paths: [config.root]});
    let plugin: SnowpackPlugin;
    try {
      plugin = typeof pluginRef.default === 'function' ? pluginRef.default : pluginRef;
      if (typeof plugin !== 'function') logger.error(`plugin ${pluginLoc} must export a function.`);
      plugin = execPluginFactory(plugin, options) as SnowpackPlugin;
    } catch (err) {
      logger.error(err.toString());
      throw err;
    }

    if (!plugin.name) {
      plugin.name = path.relative(process.cwd(), pluginLoc);
    }

    // Add any internal plugin methods. Placeholders are okay when individual
    // commands implement these differently.
    plugin.markChanged = (file) => {
      logger.debug(`clearCache(${file}) called, but function not yet hooked up.`, {
        name: plugin.name,
      });
    };

    // Finish up.
    validatePlugin(plugin);
    return plugin;
  }

  // 2. config.plugins
  config.plugins.forEach((ref) => {
    const pluginName = Array.isArray(ref) ? ref[0] : ref;
    const pluginOptions = Array.isArray(ref) ? ref[1] : {};
    const plugin = loadPluginFromConfig(pluginName, pluginOptions, config);
    logger.debug(`loaded plugin: ${pluginName}`);
    plugins.push(plugin);
  });

  // add internal JS handler plugin
  plugins.push(execPluginFactory(esbuildPlugin, {input: ['.mjs', '.jsx', '.ts', '.tsx']}));

  const extensionMap = plugins.reduce((map, {resolve}) => {
    if (resolve) {
      for (const inputExt of resolve.input) {
        map[inputExt] = resolve.output;
      }
    }
    return map;
  }, {} as Record<string, string[]>);

  return {
    plugins,
    extensionMap,
  };
}

function normalizeMount(config: SnowpackConfig) {
  const mountedDirs: Record<string, string | Partial<MountEntry>> = config.mount || {};
  const normalizedMount: Record<string, MountEntry> = {};
  for (const [mountDir, rawMountEntry] of Object.entries(mountedDirs)) {
    const mountEntry: Partial<MountEntry> =
      typeof rawMountEntry === 'string'
        ? {url: rawMountEntry, static: false, resolve: true, dot: false}
        : rawMountEntry;
    if (!mountEntry.url) {
      handleConfigError(
        `mount[${mountDir}]: Object "${mountEntry.url}" missing required "url" option.`,
      );
      return normalizedMount;
    }
    if (mountEntry.url[0] !== '/') {
      handleConfigError(
        `mount[${mountDir}]: Value "${mountEntry.url}" must be a URL path, and start with a "/"`,
      );
    }
    normalizedMount[removeTrailingSlash(mountDir)] = {
      url: mountEntry.url === '/' ? '/' : removeTrailingSlash(mountEntry.url),
      static: mountEntry.static ?? false,
      resolve: mountEntry.resolve ?? true,
      dot: mountEntry.dot ?? false,
    };
  }
  // if no mounted directories, mount the root directory to the base URL
  if (!Object.keys(normalizedMount).length) {
    normalizedMount[config.root] = {
      url: '/',
      static: false,
      resolve: true,
      dot: false,
    };
  }
  return normalizedMount;
}

function normalizeRoutes(routes: RouteConfigObject[]): RouteConfigObject[] {
  return routes.map(({src, dest, upgrade, match}, i) => {
    // Normalize
    if (typeof dest === 'string') {
      dest = addLeadingSlash(dest);
    }
    if (!src.startsWith('^')) {
      src = '^' + src;
    }
    if (!src.endsWith('$')) {
      src = src + '$';
    }
    // Validate
    try {
      return {src, dest, upgrade, match: match || 'all', _srcRegex: new RegExp(src)};
    } catch (err) {
      throw new Error(`config.routes[${i}].src: invalid regular expression syntax "${src}"`);
    }
  });
}

/** resolve --dest relative to cwd, etc. */
function normalizeConfig(_config: SnowpackUserConfig): SnowpackConfig {
  // TODO: This function is really fighting with TypeScript. Now that we have an accurate
  // SnowpackUserConfig type, we can have this function construct a fresh config object
  // from scratch instead of trying to modify the user's config object in-place.
  let config: SnowpackConfig = _config as any as SnowpackConfig;
  config.mode = config.mode || (process.env.NODE_ENV as SnowpackConfig['mode']);
  if (config.packageOptions.source === 'local') {
    config.packageOptions.rollup = config.packageOptions.rollup || {};
    config.packageOptions.rollup.plugins = config.packageOptions.rollup.plugins || [];
  }
  // normalize config URL/path values
  config.buildOptions.out = removeTrailingSlash(config.buildOptions.out);
  config.buildOptions.baseUrl = addTrailingSlash(config.buildOptions.baseUrl);
  config.buildOptions.metaUrlPath = removeTrailingSlash(
    addLeadingSlash(config.buildOptions.metaUrlPath),
  );
  config.mount = normalizeMount(config);
  config.routes = normalizeRoutes(config.routes);

  config.exclude = Array.from(
    new Set([
      ...ALWAYS_EXCLUDE,
      // Always ignore the final build directory.
      `${config.buildOptions.out}/**`,
      // We want to ignore all node_modules directories.
      `**/node_modules/**`,
      // If a node_modules directory is explicity mounted, it should be treated as source.
      // In that case, we add the mounted directory to "picomatch.ignore" elsewhere
      ...config.exclude,
    ]),
  );

  if (config.optimize && JSON.stringify(config.optimize) !== '{}') {
    config.optimize = {
      entrypoints: config.optimize.entrypoints ?? 'auto',
      preload: config.optimize.preload ?? false,
      bundle: config.optimize.bundle ?? false,
      loader: config.optimize.loader,
      sourcemap: config.optimize.sourcemap ?? true,
      splitting: config.optimize.splitting ?? false,
      treeshake: config.optimize.treeshake ?? true,
      manifest: config.optimize.manifest ?? false,
      target: config.optimize.target ?? 'es2020',
      minify: config.optimize.minify ?? false,
    };
  } else {
    config.optimize = undefined;
  }

  // new pipeline
  const {plugins, extensionMap} = loadPlugins(config);
  config.plugins = plugins;
  config._extensionMap = extensionMap;

  // If any plugins defined knownEntrypoints, add them here
  for (const {knownEntrypoints} of config.plugins) {
    if (knownEntrypoints) {
      config.packageOptions.knownEntrypoints =
        config.packageOptions.knownEntrypoints.concat(knownEntrypoints);
    }
  }

  plugins.forEach((plugin) => {
    if (plugin.config) {
      plugin.config(config);
    }
  });

  return config;
}

function handleConfigError(msg: string) {
  logger.error(msg);
  throw new Error(msg);
}

function handleValidationErrors(filepath: string, err: ConfigValidationError) {
  const msg = `! ${filepath}\n${err.message}`;
  logger.error(msg);
  logger.info(dim(`See https://www.snowpack.dev for more info.`));
  throw new Error(msg);
}

function handleDeprecatedConfigError(mainMsg: string, ...msgs: string[]) {
  const msg = `${mainMsg}\n${msgs.join('\n')}See https://www.snowpack.dev for more info.`;
  logger.error(msg);
  throw new Error(msg);
}

function valdiateDeprecatedConfig(rawConfig: any) {
  if (rawConfig.scripts) {
    handleDeprecatedConfigError(
      '[v3.0] Legacy "scripts" config is deprecated in favor of "plugins". Safe to remove if empty.',
    );
  }
  if (rawConfig.proxy) {
    handleDeprecatedConfigError(
      '[v3.0] Legacy "proxy" config is deprecated in favor of "routes". Safe to remove if empty.',
    );
  }
  if (rawConfig.buildOptions?.metaDir) {
    handleDeprecatedConfigError(
      '[v3.0] "config.buildOptions.metaDir" is now "config.buildOptions.metaUrlPath".',
    );
  }
  if (rawConfig.buildOptions?.webModulesUrl) {
    handleDeprecatedConfigError(
      '[v3.0] "config.buildOptions.webModulesUrl" is now always set within the "config.buildOptions.metaUrlPath" directory.',
    );
  }
  if (rawConfig.buildOptions?.sourceMaps) {
    handleDeprecatedConfigError(
      '[v3.0] "config.buildOptions.sourceMaps" is now "config.buildOptions.sourcemap".',
    );
  }
  if (rawConfig.installOptions) {
    handleDeprecatedConfigError(
      '[v3.0] "config.installOptions" is now "config.packageOptions". Safe to remove if empty.',
    );
  }
  if (rawConfig.packageOptions?.externalPackage) {
    handleDeprecatedConfigError(
      '[v3.0] "config.installOptions.externalPackage" is now "config.packageOptions.external".',
    );
  }
  if (rawConfig.packageOptions?.treeshake) {
    handleDeprecatedConfigError(
      '[v3.0] "config.installOptions.treeshake" is now "config.optimize.treeshake".',
    );
  }
  if (rawConfig.install) {
    handleDeprecatedConfigError(
      '[v3.0] "config.install" is now "config.packageOptions.knownEntrypoints". Safe to remove if empty.',
    );
  }
  if (rawConfig.experiments?.source) {
    handleDeprecatedConfigError(
      '[v3.0] Experiment promoted! "config.experiments.source" is now "config.packageOptions.source".',
    );
  }
  if (rawConfig.packageOptions?.source === 'skypack') {
    handleDeprecatedConfigError(
      '[v3.0] Renamed! "config.experiments.source=skypack" is now "config.packageOptions.source=remote".',
    );
  }
  if (rawConfig.experiments?.ssr) {
    handleDeprecatedConfigError(
      '[v3.0] Experiment promoted! "config.experiments.ssr" is now "config.buildOptions.ssr".',
    );
  }
  if (rawConfig.experiments?.optimize) {
    handleDeprecatedConfigError(
      '[v3.0] Experiment promoted! "config.experiments.optimize" is now "config.optimize".',
    );
  }
  if (rawConfig.experiments?.routes) {
    handleDeprecatedConfigError(
      '[v3.0] Experiment promoted! "config.experiments.routes" is now "config.routes".',
    );
  }
  if (rawConfig.devOptions?.fallback) {
    handleDeprecatedConfigError(
      '[v3.0] Deprecated! "devOptions.fallback" is now replaced by "routes".\n' +
        'More info: https://www.snowpack.dev/guides/routing',
    );
  }
}

function validatePlugin(plugin: SnowpackPlugin) {
  const pluginName = plugin.name;
  if (plugin.resolve && !plugin.load) {
    handleConfigError(`[${pluginName}] "resolve" config found but "load()" method missing.`);
  }
  if (!plugin.resolve && plugin.load) {
    handleConfigError(`[${pluginName}] "load" method found but "resolve()" config missing.`);
  }
  if (plugin.resolve && !Array.isArray(plugin.resolve.input)) {
    handleConfigError(
      `[${pluginName}] "resolve.input" should be an array of input file extensions.`,
    );
  }
  if (plugin.resolve && !Array.isArray(plugin.resolve.output)) {
    handleConfigError(
      `[${pluginName}] "resolve.output" should be an array of output file extensions.`,
    );
  }
}

export function validatePluginLoadResult(
  plugin: SnowpackPlugin,
  result: PluginLoadResult | string | void | undefined | null,
) {
  const pluginName = plugin.name;
  if (!result) {
    return;
  }
  const isValidSingleResultType = typeof result === 'string' || Buffer.isBuffer(result);
  if (isValidSingleResultType && plugin.resolve!.output.length !== 1) {
    handleConfigError(
      `[plugin=${pluginName}] "load()" returned a string, but "resolve.output" contains multiple possible outputs. If multiple outputs are expected, the object return format is required.`,
    );
  }
  const unexpectedOutput =
    typeof result === 'object' &&
    Object.keys(result).find((fileExt) => !plugin.resolve!.output.includes(fileExt));
  if (unexpectedOutput) {
    handleConfigError(
      `[plugin=${pluginName}] "load()" returned entry "${unexpectedOutput}" not found in "resolve.output": ${
        plugin.resolve!.output
      }`,
    );
  }
}

/**
 * Get the config base path, that all relative config values should resolve to. In order:
 *   - The directory of the config file path, if it exists.
 *   - The config.root value, if given.
 *   - Otherwise, the current working directory of the process.
 */
function getConfigBasePath(configFileLoc: string | undefined, configRoot: string | undefined) {
  return (
    (configFileLoc && path.dirname(configFileLoc)) ||
    (configRoot && path.resolve(process.cwd(), configRoot)) ||
    process.cwd()
  );
}

function resolveRelativeConfigAlias(
  aliasConfig: Record<string, string>,
  configBase: string,
): SnowpackUserConfig['alias'] {
  const cleanAliasConfig = {};
  for (const [target, replacement] of Object.entries(aliasConfig)) {
    const isDirectory = target.endsWith('/');
    if (isPathImport(replacement)) {
      cleanAliasConfig[target] = isDirectory
        ? addTrailingSlash(path.resolve(configBase, replacement))
        : removeTrailingSlash(path.resolve(configBase, replacement));
    } else {
      cleanAliasConfig[target] = replacement;
    }
  }
  return cleanAliasConfig;
}

function resolveRelativeConfigMount(
  mountConfig: Record<string, any>,
  configBase: string,
): SnowpackUserConfig['mount'] {
  const cleanMountConfig = {};
  for (const [target, replacement] of Object.entries(mountConfig)) {
    cleanMountConfig[path.resolve(configBase, target)] = replacement;
  }
  return cleanMountConfig;
}

function resolveRelativeConfig(config: SnowpackUserConfig, configBase: string): SnowpackUserConfig {
  if (config.root) {
    config.root = path.resolve(configBase, config.root);
  }
  if (config.workspaceRoot) {
    config.workspaceRoot = path.resolve(configBase, config.workspaceRoot);
  }
  if (config.buildOptions?.out) {
    config.buildOptions.out = path.resolve(configBase, config.buildOptions.out);
  }
  if (config.packageOptions?.source === 'remote' && config.packageOptions.cache) {
    config.packageOptions.cache = path.resolve(configBase, config.packageOptions.cache);
  }
  if (config.extends && /^[\.\/\\]/.test(config.extends)) {
    config.extends = path.resolve(configBase, config.extends);
  }
  if (config.plugins) {
    config.plugins = config.plugins.map((plugin) => {
      const name = Array.isArray(plugin) ? plugin[0] : plugin;
      const absName = path.isAbsolute(name) ? name : require.resolve(name, {paths: [configBase]});
      if (Array.isArray(plugin)) {
        plugin.splice(0, 1, absName);
        return plugin;
      }
      return absName;
    });
  }
  if (config.mount) {
    config.mount = resolveRelativeConfigMount(config.mount, configBase);
  }
  if (config.alias) {
    config.alias = resolveRelativeConfigAlias(config.alias, configBase);
  }
  return config;
}

class ConfigValidationError extends Error {
  constructor(errors: (Error | string)[]) {
    super(`Configuration Error:\n${errors.map((err) => `  - ${err.toString()}`).join(os.EOL)}`);
  }
}

function validateConfig(config: SnowpackConfig) {
  for (const mountDir of Object.keys(config.mount)) {
    if (!existsSync(mountDir)) {
      logger.warn(`config.mount[${mountDir}]: mounted directory does not exist.`);
    }
  }
}

export function createConfiguration(config: SnowpackUserConfig = {}): SnowpackConfig {
  // Validate the configuration object against our schema. Report any errors.
  const {errors: validationErrors} = validate(config, configSchema, {
    propertyName: CONFIG_NAME,
    allowUnknownAttributes: false,
  });
  if (validationErrors.length > 0) {
    throw new ConfigValidationError(validationErrors);
  }
  // Inherit any undefined values from the default configuration. If no config argument
  // was passed (or no configuration file found in loadConfiguration) then this function
  // will effectively return a copy of the DEFAULT_CONFIG object.
  const mergedConfig = merge<SnowpackUserConfig>(
    [
      DEFAULT_CONFIG,
      {
        packageOptions:
          config.packageOptions?.source === 'remote'
            ? DEFAULT_PACKAGES_REMOTE_CONFIG
            : DEFAULT_PACKAGES_LOCAL_CONFIG,
      },
      config,
    ],
    {
      isMergeableObject: (val) => isPlainObject(val) || Array.isArray(val),
    },
  );
  // Resolve relative config values. If using loadConfiguration, all config values should
  // already be resolved relative to the config file path so that this should be a no-op.
  // But, we still need to run it in case you called this function directly.
  const configBase = getConfigBasePath(undefined, config.root);
  resolveRelativeConfig(mergedConfig, configBase);
  const normalizedConfig = normalizeConfig(mergedConfig);
  validateConfig(normalizedConfig);
  return normalizedConfig;
}

async function loadConfigurationFile(
  filename: string,
  overrides: SnowpackUserConfig = {},
): Promise<{filepath: string | undefined; config: SnowpackUserConfig} | null> {
  const loc = path.resolve(overrides.root || process.cwd(), filename);
  if (!existsSync(loc)) return null;
  const config = await REQUIRE_OR_IMPORT(loc);
  return {filepath: loc, config};
}

export async function loadConfiguration(
  overrides: SnowpackUserConfig = {},
  configPath?: string,
): Promise<SnowpackConfig> {
  let result: Awaited<ReturnType<typeof loadConfigurationFile>> = null;
  // if user specified --config path, load that
  if (configPath) {
    result = await loadConfigurationFile(configPath, overrides);
    if (!result) {
      throw new Error(`Snowpack config file could not be found: ${configPath}`);
    }
  }

  const configs = [
    'snowpack.config.mjs',
    'snowpack.config.cjs',
    'snowpack.config.js',
    'snowpack.config.json',
  ];

  // If no config was found above, search for one.
  if (!result) {
    for (const potentialConfigurationFile of configs) {
      if (result) break;
      result = await loadConfigurationFile(potentialConfigurationFile, overrides);
    }
  }

  // Support package.json "snowpack" config
  if (!result) {
    const potentialPackageJsonConfig = await loadConfigurationFile('package.json', overrides);
    if (potentialPackageJsonConfig && (potentialPackageJsonConfig.config as any).snowpack) {
      result = {
        filepath: potentialPackageJsonConfig.filepath,
        config: (potentialPackageJsonConfig.config as any).snowpack,
      };
    }
  }

  if (!result) {
    logger.warn('Hint: run "snowpack init" to create a project config file. Using defaults...');
    result = {filepath: undefined, config: {}};
  }

  const {config, filepath} = result;
  const configBase = getConfigBasePath(filepath, config.root);
  valdiateDeprecatedConfig(config);
  valdiateDeprecatedConfig(overrides);
  resolveRelativeConfig(config, configBase);

  let extendConfig: SnowpackUserConfig = {} as SnowpackUserConfig;
  if (config.extends) {
    const extendConfigLoc = require.resolve(config.extends, {paths: [configBase]});
    const extendResult = await loadConfigurationFile(extendConfigLoc, {});
    if (!extendResult) {
      handleConfigError(`Could not locate "extends" config at ${extendConfigLoc}`);
      process.exit(1);
    }
    extendConfig = extendResult.config;
    const extendValidation = validate(extendConfig, configSchema, {
      allowUnknownAttributes: false,
      propertyName: CONFIG_NAME,
    });
    if (extendValidation.errors && extendValidation.errors.length > 0) {
      handleValidationErrors(extendConfigLoc, new ConfigValidationError(extendValidation.errors));
    }
    valdiateDeprecatedConfig(extendConfig);
    resolveRelativeConfig(extendConfig, configBase);
  }

  // if valid, apply config over defaults
  const mergedConfig = merge<SnowpackUserConfig>([extendConfig, config, overrides], {
    isMergeableObject: (val) => isPlainObject(val) || Array.isArray(val),
  });

  try {
    return createConfiguration(mergedConfig);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      handleValidationErrors(filepath!, err);
    }
    throw err;
  }
}
