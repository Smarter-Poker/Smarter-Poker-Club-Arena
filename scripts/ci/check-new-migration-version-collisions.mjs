#!/usr/bin/env node
/**
 * Reject a newly added migration when another file already owns its version.
 * Historical collisions remain visible history; this gate prevents adding to
 * that backlog without renaming deployed migrations or rewriting the ledger.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const migrationDir = 'supabase/migrations';

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function resolveBase() {
  const explicit = process.argv[2];
  if (explicit) return explicit;
  const branch = process.env.GITHUB_BASE_REF;
  for (const candidate of branch ? [`origin/${branch}`, branch] : ['origin/main', 'main']) {
    try {
      git(['rev-parse', '--verify', candidate]);
      return candidate;
    } catch {
      // Try the next locally available base reference.
    }
  }
  return 'HEAD^';
}

try {
  const base = resolveBase();
  const committedOrStaged = git([
    'diff',
    '--name-only',
    '--diff-filter=A',
    base,
    '--',
    migrationDir,
  ]).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', migrationDir]).split(
    '\n'
  );
  const added = [...new Set([...committedOrStaged, ...untracked])].filter((file) =>
    file.endsWith('.sql')
  );
  const all = readdirSync(migrationDir).filter((file) => file.endsWith('.sql'));
  const collisions = [];

  for (const path of added) {
    const file = path.slice(path.lastIndexOf('/') + 1);
    const version = file.split('_', 1)[0];
    const owners = all.filter((candidate) => candidate.split('_', 1)[0] === version).sort();
    if (owners.length > 1) collisions.push({ version, owners });
  }

  if (collisions.length > 0) {
    console.error('[migration-version-collisions] newly added migration version is not unique:');
    for (const { version, owners } of collisions) {
      console.error(`  ${version}: ${owners.join(', ')}`);
    }
    console.error('Assign a new, unique migration version before publishing.');
    process.exit(1);
  }

  console.log(
    `[migration-version-collisions] ${added.length} new migration(s) against ${base}; all versions are unique.`
  );
} catch (error) {
  console.error('[migration-version-collisions] script error:', error?.message || error);
  process.exit(2);
}
