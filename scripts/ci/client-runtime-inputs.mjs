import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';
import { validateFontInputs } from './client-runtime-font-inputs.mjs';

const SHA = /^[0-9a-f]{40}$/;
const safePath = (path) =>
  typeof path === 'string' &&
  path &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !path.split('/').some((part) => !part || part === '.' || part === '..');
// Build inputs are conservative whole scopes. These exclusions are separately
// delivered verification/database/engine components, never client inputs by
// assumption: actual Rollup module/watch reads override EVERY exclusion.
export function conservativeClientInput(path) {
  if (!safePath(path)) throw new Error('Invalid input path.');
  if (
    /(?:^|\/)(?:package(?:-lock)?\.json|[^/]*lock[^/]*\.(?:json|yaml)|tsconfig[^/]*\.json)$/.test(
      path
    )
  )
    return true;
  if (
    !path.includes('/') ||
    path.startsWith('src/') ||
    path.startsWith('public/') ||
    path.startsWith('docs/agent-policy/')
  )
    return true;
  if (
    [
      '.github/workflows/publish-club-arena.yml',
      '.github/workflows/post-deploy-e2e.yml',
      'tests/protected-features.json',
    ].includes(path)
  )
    return true;
  if (path.startsWith('scripts/')) {
    return !/^(?:scripts\/verification-harness\/|scripts\/qualification\/|scripts\/ci\/schema-manifest\.d\/|scripts\/ci\/test[^/]*\.py$)/.test(
      path
    );
  }
  return false;
}
export function separateComponentPath(path) {
  return (
    safePath(path) &&
    /^(?:docs\/|tests\/|server\/|supabase\/|scripts\/|\.github\/workflows\/)/.test(path)
  );
}

// Includes lazy modules and every plugin watch input, not just the entry chunk.
// Directories are recorded as addition/deletion scopes. Files outside the
// checked repository/dependency store make the inventory unqualified.
export function runtimeInputPlugin(label, root = process.cwd()) {
  let config;
  return {
    name: `client-runtime-inputs-${label}`,
    configResolved(value) {
      config = value;
    },
    writeBundle(_options, bundle) {
      const files = new Set();
      const directories = new Set();
      const unknown = [];
      let lock;
      try {
        lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
      } catch {
        unknown.push('missing-locked-dependency-authority');
      }
      const locked = (name) => {
        const entry = lock?.packages?.[`node_modules/${name}`];
        return (
          entry &&
          typeof entry.version === 'string' &&
          typeof entry.integrity === 'string' &&
          entry.link !== true
        );
      };
      const dependencyRoot = resolve(root, 'node_modules') + '/';
      const require = createRequire(resolve(root, 'package.json'));
      const dependency = (clean) => {
        if (!clean.startsWith(dependencyRoot)) return false;
        let real;
        try {
          real = realpathSync(clean);
        } catch {
          return false;
        }
        if (!real.startsWith(dependencyRoot)) return false;
        const rel = relative(root, clean).replace(/\\/g, '/');
        const packagePath = Object.keys(lock?.packages || {})
          .filter((path) => path.startsWith('node_modules/') && rel.startsWith(path + '/'))
          .sort((a, b) => b.length - a.length)[0];
        const entry = lock?.packages?.[packagePath];
        if (!entry || entry.link === true || typeof entry.integrity !== 'string') return false;
        try {
          return (
            JSON.parse(readFileSync(resolve(root, packagePath, 'package.json'), 'utf8')).version ===
            entry.version
          );
        } catch {
          return false;
        }
      };
      for (const raw of new Set([...this.getModuleIds(), ...this.getWatchFiles()])) {
        if (raw.includes('\0')) {
          // Known Vite/Rollup CommonJS virtual producers are qualified by the
          // original immutable build, unchanged root configs/build sources and
          // their exact locked packages. Unknown plugin IDs cannot disappear.
          if (/^\0vite\//.test(raw) && locked('vite')) continue;
          if (
            /^\0commonjs(?:Helpers\.js|-dynamic-modules)$/.test(raw) &&
            (locked('@rollup/plugin-commonjs') || locked('vite'))
          )
            continue;
          if (
            raw.startsWith('\0') &&
            /\?commonjs-(?:proxy|external|es-import|entry|exports|module)$/.test(raw) &&
            (locked('@rollup/plugin-commonjs') || locked('vite'))
          ) {
            const underlying = raw.slice(1).split('?')[0];
            if (isAbsolute(underlying) && dependency(underlying)) continue;
          }
          unknown.push(`unsupported-virtual-input:${raw.replace(/\0/g, '<nul>')}`);
          continue;
        }
        // Vite's CSS producer reports its emitted aggregate as a watch input
        // (defaultCssBundleName/originalFileName in locked Vite), not a source
        // file. Admit only the actual non-split SSR asset and its observed CSS
        // sources; an absent or custom producer remains unknown.
        if (
          raw === 'style.css' &&
          !existsSync(resolve(root, raw)) &&
          locked('vite') &&
          config?.build.ssr &&
          config.build.cssCodeSplit === false &&
          Object.values(bundle).some(
            (asset) => asset.type === 'asset' && asset.originalFileNames?.includes('style.css')
          )
        )
          continue;
        let clean = raw.split('?')[0];
        if (!isAbsolute(clean)) {
          if (isBuiltin(clean)) continue;
          // Vite also reports root-relative watch files (HTML and media),
          // whose actual source blob must remain in the sealed inventory.
          if (safePath(clean) && existsSync(resolve(root, clean))) {
            clean = resolve(root, clean);
          } else
            try {
              clean = require.resolve(clean);
            } catch {
              unknown.push(`unsupported-module-input:${raw}`);
              continue;
            }
          if (!isAbsolute(clean)) {
            unknown.push(`unsupported-module-input:${raw}`);
            continue;
          }
        }
        if (clean.includes('/node_modules/')) {
          if (!dependency(clean)) unknown.push('unqualified-or-external-dependency-input');
          continue;
        }
        const path = relative(root, clean).replace(/\\/g, '/');
        if (!safePath(path)) {
          unknown.push('external-build-input');
          continue;
        }
        if (!existsSync(clean)) {
          unknown.push(path);
          continue;
        }
        if (statSync(clean).isDirectory()) directories.add(path + '/');
        else files.add(path);
      }
      const sourceSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
      const cleanSource =
        execFileSync('git', ['-C', root, 'status', '--porcelain']).toString() === '';
      writeFileSync(
        resolve(root, `.client-runtime-${label}.json`),
        JSON.stringify({
          schema: 1,
          build: label,
          sourceSha,
          cleanSource,
          files: [...files].sort(),
          directories: [...directories].sort(),
          unknown: [...new Set(unknown)].sort(),
        }) + '\n'
      );
    },
  };
}
function treeEntries(sha, cwd) {
  const raw = execFileSync('git', ['-C', cwd, 'ls-tree', '-rz', sha], {
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!raw.equals(Buffer.from(raw.toString('utf8')))) throw new Error('Non-UTF-8 Git tree.');
  const entries = new Map();
  for (const record of raw.toString().split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40})\t(.+)$/.exec(record);
    if (!match || !safePath(match[4]) || entries.has(match[4]))
      throw new Error('Incomplete or malformed source tree.');
    entries.set(match[4], { mode: match[1], oid: match[3] });
  }
  return entries;
}
export function makeRuntimeInputs(sourceSha, observations, cwd = process.cwd()) {
  if (!SHA.test(sourceSha) || observations.length !== 3)
    throw new Error('All three actual build graphs are required.');
  const tree = treeEntries(sourceSha, cwd);
  const files = new Set([...tree.keys()].filter(conservativeClientInput));
  const directories = new Set();
  const unknown = [];
  if (
    JSON.stringify(observations.map((entry) => entry?.build).sort()) !==
    JSON.stringify(['app', 'diamond', 'prerender'])
  )
    throw new Error('Distinct actual app, Diamond and prerender graphs are required.');
  for (const observation of observations) {
    if (
      observation?.schema !== 1 ||
      observation.sourceSha !== sourceSha ||
      observation.cleanSource !== true ||
      !Array.isArray(observation.files) ||
      !Array.isArray(observation.directories) ||
      !Array.isArray(observation.unknown)
    )
      throw new Error('Malformed build graph.');
    unknown.push(...observation.unknown);
    for (const path of observation.files) {
      if (!safePath(path)) throw new Error('Malformed build file.');
      files.add(path);
      if (!tree.has(path)) unknown.push(path);
    }
    for (const prefix of observation.directories) {
      if (typeof prefix !== 'string' || !prefix.endsWith('/') || !safePath(prefix.slice(0, -1)))
        throw new Error('Malformed build directory.');
      directories.add(prefix);
      for (const path of tree.keys()) if (path.startsWith(prefix)) files.add(path);
    }
  }
  // Literal Vite globs are addition/deletion dependencies even for files
  // absent from the old module list. Unknown glob syntax cannot qualify.
  for (const path of [...files]) {
    if (!tree.has(path) || !/\.(?:ts|tsx|mjs|js)$/.test(path)) continue;
    const text = execFileSync('git', ['-C', cwd, 'show', `${sourceSha}:${path}`], {
      maxBuffer: 8 * 1024 * 1024,
    }).toString();
    const calls = [
      ...text.matchAll(/import\.meta\.glob(?:<[^>]*>)?\s*\(\s*(\[[^\]]*\]|['"][^'"\n]*['"])/g),
    ];
    const count = [...text.matchAll(/import\.meta\.glob(?:<[^>]*>)?\s*\(/g)].length;
    if (calls.length !== count) unknown.push(`unresolved-glob:${path}`);
    for (const call of calls) {
      const patterns = [...call[1].matchAll(/['"]([^'"\n]*)['"]/g)].map((entry) => entry[1]);
      if (!patterns.length || /\\/.test(call[1])) {
        unknown.push(`unresolved-glob:${path}`);
        continue;
      }
      for (const pattern of patterns) {
        if (pattern.startsWith('!')) continue;
        let absolute;
        if (pattern.startsWith('./') || pattern.startsWith('../'))
          absolute = resolve(cwd, path, '..', pattern);
        else if (pattern.startsWith('/')) absolute = resolve(cwd, pattern.slice(1));
        else if (pattern.startsWith('@/')) absolute = resolve(cwd, 'src', pattern.slice(2));
        else {
          unknown.push(`unresolved-glob:${path}`);
          continue;
        }
        const relativePattern = relative(cwd, absolute).replace(/\\/g, '/');
        const wildcard = relativePattern.search(/[\*?{[(!]/);
        const literal = wildcard < 0 ? relativePattern : relativePattern.slice(0, wildcard);
        const prefix = literal.slice(0, literal.lastIndexOf('/') + 1);
        if (!prefix || !safePath(prefix.slice(0, -1))) {
          unknown.push(`unbounded-glob:${path}`);
          continue;
        }
        directories.add(prefix);
        for (const entry of tree.keys()) if (entry.startsWith(prefix)) files.add(entry);
      }
    }
  }
  const entries = [...files]
    .sort()
    .filter((path) => tree.has(path))
    .map((path) => ({ path, ...tree.get(path) }));
  if (entries.some((entry) => !['100644', '100755'].includes(entry.mode)))
    unknown.push('non-regular-build-input');
  return {
    schema: 1,
    sourceSha,
    complete: unknown.length === 0,
    files: entries,
    directories: [...directories].sort(),
    unknown: [...new Set(unknown)].sort(),
  };
}
export function qualifiesRuntimeInputs(
  inventory,
  baseline,
  target,
  changedPaths,
  cwd = process.cwd()
) {
  if (
    !inventory ||
    inventory.schema !== 1 ||
    inventory.sourceSha !== baseline ||
    inventory.complete !== true ||
    !SHA.test(baseline) ||
    !SHA.test(target) ||
    !Array.isArray(inventory.files) ||
    !Array.isArray(inventory.directories) ||
    !Array.isArray(inventory.unknown) ||
    inventory.unknown.length
  )
    throw new Error('No complete original build-input inventory.');
  const base = treeEntries(baseline, cwd);
  const current = treeEntries(target, cwd);
  const seen = new Set();
  for (const entry of inventory.files) {
    if (
      !safePath(entry?.path) ||
      seen.has(entry.path) ||
      !['100644', '100755'].includes(entry.mode) ||
      !SHA.test(entry.oid)
    )
      throw new Error('Invalid or duplicate build-input record.');
    seen.add(entry.path);
    if (
      JSON.stringify(base.get(entry.path)) !== JSON.stringify({ mode: entry.mode, oid: entry.oid })
    )
      throw new Error('Inventory input does not match the actual original source tree.');
    if (JSON.stringify(current.get(entry.path)) !== JSON.stringify(base.get(entry.path)))
      return false;
  }
  // Complete conservative scopes must actually be represented in the seal.
  for (const path of base.keys())
    if (conservativeClientInput(path) && !seen.has(path))
      throw new Error('Original inventory omitted a conservative build input.');
  for (const prefix of inventory.directories) {
    if (typeof prefix !== 'string' || !prefix.endsWith('/') || !safePath(prefix.slice(0, -1)))
      throw new Error('Malformed watched directory.');
    for (const path of base.keys())
      if (path.startsWith(prefix) && !seen.has(path))
        throw new Error('Original inventory omitted a watched input.');
  }
  for (const path of changedPaths) {
    if (
      !safePath(path) ||
      conservativeClientInput(path) ||
      inventory.directories.some((prefix) => path.startsWith(prefix)) ||
      seen.has(path) ||
      !separateComponentPath(path)
    )
      return false;
    // An added unobserved shared module could expand a dynamic module graph.
    if (
      path.startsWith('server/') &&
      !base.has(path) &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
    )
      return false;
  }
  return true;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
  const observations = ['app', 'diamond', 'prerender'].map((label) =>
    JSON.parse(readFileSync(`.client-runtime-${label}.json`, 'utf8'))
  );
  const inventory = makeRuntimeInputs(sourceSha, observations);
  try {
    inventory.fontInputs = validateFontInputs(
      JSON.parse(
        readFileSync(
          resolve(process.env.CA_DIST || 'dist', 'client-runtime-font-inputs.json'),
          'utf8'
        )
      )
    );
  } catch {
    inventory.unknown.push('missing-or-incomplete-external-font-inputs');
    inventory.complete = false;
  }
  writeFileSync(
    resolve(process.env.CA_DIST || 'dist', 'client-runtime-inputs.json'),
    JSON.stringify(inventory, null, 2) + '\n'
  );
  console.log(
    `Client runtime input inventory: ${inventory.files.length} files; complete=${inventory.complete}.`
  );
}
