#!/usr/bin/env node
/**
 * Reserve a migration version that no other agent can already be holding.
 *
 * THE COLLISION THIS EXISTS TO PREVENT
 *
 * Migration files are named `<14-digit version>_<slug>.sql`, and
 * `tests/unit/migrationVersionUniqueness.test.ts` requires every version to be
 * unique. Agents pick the version by hand, reach for a round number, and two
 * of them land on the same one - `20260903020000` was taken twice on
 * 2026-09-03. Neither branch fails on its own, because each holds only one
 * file. The collision appears the moment the second branch takes main, and
 * then CI fails for work that was correct when it was written.
 *
 * It is not merely a CI annoyance. Supabase keys `schema_migrations` on the
 * version, so of two files sharing one version, the second is silently not
 * applied. A migration that never ran is worse than a red build.
 *
 * WHY A TIMESTAMP ALONE CANNOT FIX IT
 *
 * Using the real second instead of a round one narrows the window but does not
 * close it - twelve agents commit inside the same second often enough. The
 * only reliable answer is to ASK WHAT IS ALREADY TAKEN, including versions
 * that exist on branches nobody has merged yet, and step past them.
 *
 * Usage:  node scripts/new-migration.mjs "adds the thing"
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIR = join(ROOT, 'supabase', 'migrations');

const sh = (args, ok = '') => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return ok;
  }
};

/** Every version already spoken for: this tree, main, and every remote branch. */
function takenVersions() {
  const taken = new Set();
  const add = (name) => {
    const m = /(\d{14})_/.exec(name);
    if (m) taken.add(m[1]);
  };

  if (existsSync(DIR)) readdirSync(DIR).forEach(add);

  sh(['fetch', '-q', 'origin', 'main']);
  sh(['ls-tree', '-r', '--name-only', 'origin/main', 'supabase/migrations'])
    .split('\n').forEach(add);

  // The branches are the point. A version taken on an unmerged branch is
  // exactly the one a hand-picked timestamp collides with.
  sh(['ls-remote', '--heads', 'origin']).split('\n').forEach((line) => {
    const ref = line.split('\t')[1];
    if (!ref) return;
    sh(['ls-tree', '-r', '--name-only', ref.replace('refs/heads/', 'origin/'), 'supabase/migrations'])
      .split('\n').forEach(add);
  });

  return taken;
}

function stamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
         `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

const slug = (process.argv.slice(2).join(' ') || 'migration')
  .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);

const taken = takenVersions();
const now = new Date();
let version = stamp(now);
let bumped = 0;
while (taken.has(version)) {           // step forward a second at a time
  now.setUTCSeconds(now.getUTCSeconds() + 1);
  version = stamp(now);
  if (++bumped > 86400) { console.error('could not find a free version in a day of seconds'); process.exit(1); }
}

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
const file = join(DIR, `${version}_${slug}.sql`);
writeFileSync(file, `-- ${version}_${slug}.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- your change here

COMMIT;
`);

console.log(`reserved ${version}${bumped ? ` (stepped past ${bumped} taken version(s))` : ''}`);
console.log(file);
