import {PackageSource, SnowpackConfig} from '../types';
import {PackageSourceLocal} from './local';
import {PackageSourceRemote} from './remote';
import path from 'path';
import rimraf from 'rimraf';
import globalCacheDir from 'cachedir';

export const GLOBAL_CACHE_DIR = globalCacheDir('snowpack');

export async function clearCache() {
  return Promise.all([
    PackageSourceRemote.clearCache(),
    // NOTE(v4.0): This function is called before config has been created.
    // But, when `packageOptions.source="remote-next"` the ".snowpack" cache
    // directory lives in the config.root directory. We fake it here,
    // and can revisit this API (probably add config as an arg) in v4.0.
    rimraf.sync(path.join(process.cwd(), '.snowpack')),
    rimraf.sync(path.join(process.cwd(), 'node_modules', '.cache', 'snowpack')),
  ]);
}

const remoteSourceCache = new WeakMap<SnowpackConfig, PackageSource>();
const localSourceCache = new WeakMap<SnowpackConfig, PackageSource>();

export function getPackageSource(config: SnowpackConfig): PackageSource {
  if (config.packageOptions.source === 'remote') {
    if (remoteSourceCache.has(config)) {
      return remoteSourceCache.get(config)!;
    }

    const source = new PackageSourceRemote(config);
    remoteSourceCache.set(config, source);
    return source;
  }

  if (localSourceCache.has(config)) {
    return localSourceCache.get(config)!;
  }

  const source = new PackageSourceLocal(config);
  localSourceCache.set(config, source);
  return source;
}
