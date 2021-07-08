import * as colors from 'kleur/colors';
import util from 'util';
import yargs from 'yargs-parser';
import {addCommand, rmCommand} from './commands/add-rm';
import {command as initCommand} from './commands/init';
import {command as prepareCommand} from './commands/prepare';
import {command as buildCommand} from './commands/build';
import {command as devCommand} from './commands/dev';
import {clearCache, getPackageSource} from './sources/util';
import {logger} from './logger';
import {loadConfiguration, expandCliFlags} from './config';
import {CLIFlags, CommandOptions, SnowpackConfig} from './types';
import {readLockfile} from './util.js';
import {getUrlsForFile} from './build/file-urls';
export * from './types';

// Stable API
export {startServer, NotFoundError, isHttp2RequestData} from './commands/dev';
export {build} from './commands/build';
export {loadConfiguration, createConfiguration} from './config.js';
export {readLockfile as loadLockfile} from './util.js';
export {clearCache} from './sources/util';
export {logger} from './logger';

// Helper API
export function getUrlForFile(fileLoc: string, config: SnowpackConfig) {
  const result = getUrlsForFile(fileLoc, config);
  return result ? result[0] : result;
}
export function preparePackages({config}: CommandOptions) {
  const pkgSource = getPackageSource(config);
  return pkgSource.prepare();
}

// Deprecated API
export function startDevServer() {
  throw new Error('startDevServer() was been renamed to startServer().');
}
export function buildProject() {
  throw new Error('buildProject() was been renamed to build().');
}
export function loadAndValidateConfig() {
  throw new Error(
    'loadAndValidateConfig() has been deprecated in favor of loadConfiguration() and createConfiguration().',
  );
}

function printHelp() {
  logger.info(
    `
${colors.bold(`snowpack`)} - A faster build system for the modern web.

  Snowpack is best configured via config file.
  But, most configuration can also be passed via CLI flags.
  📖 ${colors.dim('https://www.snowpack.dev/reference/configuration')}

${colors.bold('Commands:')}
  snowpack init          Create a new project config file.
  snowpack prepare       Prepare your project for development (optional).
  snowpack dev           Develop your project locally.
  snowpack build         Build your project for production.
  snowpack add [package] Add a package to your project.
  snowpack rm [package]  Remove a package from your project.

${colors.bold('Flags:')}
  --config [path]        Set the location of your project config file.
  --help                 Show this help message.
  --version              Show the current version.
  --reload               Clear the local cache (useful for troubleshooting).
  --cache-dir-path       Specify a custom cache directory.
  --verbose              Enable verbose log messages.
  --quiet                Enable minimal log messages.
    `.trim(),
  );
}

export async function cli(args: string[]) {
  // parse CLI flags
  const cliFlags = yargs(args, {
    array: ['install', 'env', 'exclude', 'external'],
  }) as CLIFlags;

  if (cliFlags.verbose) {
    logger.level = 'debug';
  }
  if (cliFlags.quiet) {
    logger.level = 'silent';
  }
  if (cliFlags.help) {
    printHelp();
    process.exit(0);
  }
  if (cliFlags.version) {
    logger.info(require('../package.json').version);
    process.exit(0);
  }
  if (cliFlags.reload) {
    logger.info(colors.yellow('! clearing cache...'));
    await clearCache();
  }

  const cmd = cliFlags['_'][2];
  logger.debug(`run command: ${cmd}`);
  if (!cmd) {
    printHelp();
    process.exit(1);
  }

  // Set this early -- before config loading -- so that plugins see it.
  if (cmd === 'build') {
    process.env.NODE_ENV = process.env.NODE_ENV || 'production';
  }
  if (cmd === 'dev') {
    process.env.NODE_ENV = process.env.NODE_ENV || 'development';
  }

  const cliConfig = expandCliFlags(cliFlags);
  const config = await loadConfiguration(cliConfig, cliFlags.config);
  logger.debug(`config loaded: ${util.format(config)}`);
  const lockfile = await readLockfile(config.root);
  logger.debug(`lockfile ${lockfile ? 'loaded.' : 'not loaded'}`);
  const commandOptions: CommandOptions = {
    config,
    lockfile,
  };

  if (cmd === 'add') {
    await addCommand(cliFlags['_'][3], commandOptions);
    return process.exit(0);
  }
  if (cmd === 'rm') {
    await rmCommand(cliFlags['_'][3], commandOptions);
    return process.exit(0);
  }

  if (cliFlags['_'].length > 3) {
    logger.error(`Unexpected multiple commands`);
    process.exit(1);
  }

  if (cmd === 'prepare') {
    await prepareCommand(commandOptions);
    return process.exit(0);
  }
  if (cmd === 'init') {
    await initCommand(commandOptions);
    return process.exit(0);
  }
  if (cmd === 'build') {
    await buildCommand(commandOptions);
    return process.exit(0);
  }
  if (cmd === 'dev') {
    await devCommand(commandOptions);
    return process.exit(0);
  }

  logger.error(`Unrecognized command: ${cmd}`);
  process.exit(1);
}
