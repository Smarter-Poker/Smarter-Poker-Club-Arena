import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Read only. A Mac with a partial dependency set uses the required Linux CI gates. */
export function localDependencyPolicy(root, platform = process.platform) {
  if (platform !== 'darwin') return { mode: 'local', missing: [] };
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
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
      return typeof installed.version !== 'string' || installed.version.length === 0;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return true;
      throw error;
    }
  });
  return { mode: missing.length ? 'ci' : 'local', missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: local-dependency-policy.mjs PACKAGE_ROOT');
  const result = localDependencyPolicy(resolve(process.argv[2]));
  if (result.mode === 'ci') {
    console.error(
      `[local dependencies] ${result.missing.length} declared packages are unavailable on this Mac. Required CI owns dependency checks; no install or copy will run.`
    );
  }
  console.log(result.mode);
}
