import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Read only. Applicable checks require the owned tree's exact locked direct dependencies. */
export function localDependencyPolicy(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  if (!lock.packages || !lock.packages['']) throw new Error('A complete npm lockfile is required');
  const required = { ...manifest.dependencies, ...manifest.devDependencies };
  const optional = manifest.optionalDependencies ?? {};
  const missing = Object.keys(required).filter((name) => {
    if (Object.hasOwn(optional, name)) return false;
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) {
      throw new Error('Invalid dependency name in package.json');
    }
    try {
      const installed = JSON.parse(
        readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')
      );
      const locked = lock.packages[`node_modules/${name}`];
      const requested =
        lock.packages[''].dependencies?.[name] ?? lock.packages[''].devDependencies?.[name];
      return (
        requested !== required[name] ||
        typeof locked?.version !== 'string' ||
        installed.version !== locked.version
      );
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return true;
      throw error;
    }
  });
  return { mode: missing.length ? 'blocked' : 'local', missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: local-dependency-policy.mjs PACKAGE_ROOT');
  const result = localDependencyPolicy(resolve(process.argv[2]));
  if (result.mode === 'blocked') {
    console.error(
      `[local dependencies] ${result.missing.length} direct dependencies are missing or differ from package-lock.json. Applicable local checks must run before push. This read-only probe never installs or copies dependencies.`
    );
  }
  console.log(result.mode);
}
