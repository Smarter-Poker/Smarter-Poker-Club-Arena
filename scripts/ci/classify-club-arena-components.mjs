import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEngineRelease, engineControlFiles } from './classify-engine-release.mjs';

export const controlRoot = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
);
export const controlClosure = Object.freeze([
  'scripts/ci/classify-club-arena-components.mjs',
  'scripts/ci/classify-engine-release.mjs',
  'scripts/ci/prove-retained-frontend.mjs',
  'scripts/ci/read-native-frontend.py',
]);
// Deliberately only the six reviewed engine controls. In particular, neither
// server/** nor tests/** is excluded: both contain actual frontend inputs.
export const nonFrontendControls = engineControlFiles;
const sha = /^[0-9a-f]{40}$/;
export function isolatedGitEnvironment(environment = process.env) {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => !/^GIT_/i.test(key))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
}
export function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    env: isolatedGitEnvironment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
}
export function requireControlSource(expected, root = controlRoot) {
  if (!sha.test(expected) || git(root, ['rev-parse', 'HEAD']).trim() !== expected) {
    throw new Error('Exact control checkout required.');
  }
  for (const file of controlClosure) {
    const committed = git(root, ['show', `${expected}:${file}`]);
    if (
      committed !== readFileSync(path.join(controlRoot, file), 'utf8') ||
      committed !== readFileSync(path.join(root, file), 'utf8')
    ) {
      throw new Error('Control closure differs from the executing source.');
    }
  }
}
export function classifyClubArenaComponents({
  sourceRoot,
  beforeSha,
  targetSha,
  controlSha,
  trustedRoot = controlRoot,
}) {
  requireControlSource(controlSha, trustedRoot);
  if (
    !sha.test(targetSha) ||
    /^0+$/.test(targetSha) ||
    git(sourceRoot, ['rev-parse', 'HEAD']).trim() !== targetSha
  ) {
    throw new Error('Exact target checkout required.');
  }
  // The shared classifier is the sole authority for runtime/control semantics.
  const engine = classifyEngineRelease({ cwd: sourceRoot, beforeSha, afterSha: targetSha });
  if (!engine.beforeKnown) return { retained: false, reason: 'history-unproven', engine };
  const records = git(sourceRoot, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--raw',
    '-z',
    beforeSha,
    targetSha,
    '--',
  ]).split('\0');
  const changed = [];
  for (let i = 0; i < records.length - 1; i += 2) {
    const record = records[i],
      file = records[i + 1];
    // Retention permits ordinary content edits only. Additions, deletions,
    // mode changes, submodules and symlinks require normal publication.
    if (
      !/^:100644 100644 [0-9a-f]+ [0-9a-f]+ M$/.test(record) ||
      !nonFrontendControls.includes(file)
    ) {
      return { retained: false, reason: 'frontend-or-unclassified-input', engine };
    }
    changed.push(file);
  }
  return {
    retained: changed.length > 0,
    reason: changed.length ? 'reviewed-engine-controls-only' : 'no-control-delta',
    changed,
    engine,
  };
}
