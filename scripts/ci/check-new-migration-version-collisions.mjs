#!/usr/bin/env node
/**
 * Reject a newly added migration when another file already owns its version.
 * Historical collisions remain visible history; this gate prevents adding to
 * that backlog without renaming deployed migrations or rewriting the ledger.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

const migrationDir = 'supabase/migrations';

/**
 * A FILE WITH NO EXECUTABLE SQL CANNOT ADD TO THE BACKLOG (2026-09-23).
 *
 * The gate above says it plainly: historical collisions remain visible history,
 * and this exists to stop anyone ADDING to that backlog. A retired migration -
 * every line of it a comment, its DDL preserved inert for the record - cannot
 * be added to anything, because Supabase can never apply it. It is
 * documentation that happens to live under this directory.
 *
 * `20260312002_bulk_update_position_stats.sql` is the case that forced this.
 * It is a tombstone: it shares its version with
 * `20260312002_tournament_flights.sql`, and the whole POINT of the file is to
 * say so, because Supabase keys schema_migrations on the version and silently
 * never applies the second of a pair. Refusing it would mean the only way to
 * keep that warning in the tree is to give it a UNIQUE version - which is to
 * say, to make a file that must never run look exactly like one that should.
 *
 * This is not an allowlist and it names no file. The moment executable SQL
 * reappears in a tombstone it collides again, which is the same regression
 * `tests/a-position-stat-has-a-live-writer.law.test.ts` independently pins.
 */
function isInert(path) {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .every((line) => line.trim() === '' || line.trimStart().startsWith('--'));
  } catch {
    // Unreadable is not inert. Let the collision rule speak.
    return false;
  }
}

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
    if (isInert(path)) continue;
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
