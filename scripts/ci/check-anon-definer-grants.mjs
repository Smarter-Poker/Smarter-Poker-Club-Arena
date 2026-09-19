#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ANON EXECUTES ONLY WHAT THE REPOSITORY SAYS IT MAY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A SECURITY DEFINER function runs with its owner's privileges. The set of
 * them a logged-out visitor may EXECUTE is therefore the anonymous attack
 * surface of this database, and on 2026-09-18 nobody had a list of it.
 *
 * Measured that day: 2,571 SECURITY DEFINER functions in `public`, 35 of them
 * anon-executable, 772 authenticated-executable. The good news first, because
 * it is the part that matters: 2 of the 2,571 leave `search_path` mutable and
 * neither is anon-executable, so definer + anonymous + mutable path - the
 * combination that is actually exploitable - was empty. Thirteen of the 35
 * grants did nothing at all and were revoked by migration 20260918121836.
 *
 * This compares the live grants to docs/security/anon-executable-definers.json
 * and fails on any function the repository has not accounted for. It does not
 * fail on a function in the list that has LOST the grant: that direction is
 * somebody tightening, and a guard that punishes tightening teaches people to
 * skip it. It reports the difference either way.
 *
 * A grant appears when somebody writes `GRANT EXECUTE ... TO anon`, and also
 * when a new function is created under a default privilege. The second is the
 * one nobody notices, which is the reason this exists.
 *
 * CREDENTIALS: this reads a connection string from the environment and refuses
 * without one. It never contains, derives or writes a credential - 10.84.
 *
 * Usage:
 *   SUPABASE_DB_URL=... node scripts/ci/check-anon-definer-grants.mjs
 *   SUPABASE_DB_URL=... node scripts/ci/check-anon-definer-grants.mjs --write
 *
 * Exit: 0 the live set matches · 1 an unaccounted grant · 2 could not ask
 *       (NEVER silently green)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = join(ROOT, 'docs/security/anon-executable-definers.json');

const QUERY = `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY 1;`;

export function readManifest(path = MANIFEST) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(doc.allowed) || doc.allowed.length === 0) {
    throw new Error('manifest has no allowed[] entries - an empty allowlist is a broken scan, not a clean one');
  }
  return doc;
}

/** The signatures anon may execute, according to the repository. */
export function allowedSignatures(doc) {
  return new Set(doc.allowed.map((e) => e.fn));
}

function liveSignatures() {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('[anon-definers] COULD NOT ASK THE DATABASE.');
    console.error('   Set SUPABASE_DB_URL (or DATABASE_URL) from the secret store this estate');
    console.error('   already uses for psql. This script never carries one itself.');
    console.error('   This is not a pass.');
    process.exit(2);
  }
  let out;
  try {
    out = execFileSync('psql', [url, '-At', '-c', QUERY], { encoding: 'utf8', timeout: 60_000 });
  } catch (err) {
    console.error('[anon-definers] COULD NOT ASK THE DATABASE.');
    console.error(`   ${err?.message || err}`);
    console.error('   This is not a pass.');
    process.exit(2);
  }
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
}

export function compare(live, allowed) {
  const unaccounted = [...live].filter((s) => !allowed.has(s)).sort();
  const tightened = [...allowed].filter((s) => !live.has(s)).sort();
  return { unaccounted, tightened };
}

export function main() {
  const doc = readManifest();
  const allowed = allowedSignatures(doc);
  const live = liveSignatures();
  const { unaccounted, tightened } = compare(live, allowed);

  if (process.argv.includes('--write')) {
    const kept = doc.allowed.filter((e) => live.has(e.fn));
    const added = unaccounted.map((fn) => ({ fn, reason: 'UNREVIEWED - say why anon may execute this, or revoke it' }));
    writeFileSync(MANIFEST, JSON.stringify({ ...doc, allowed: [...kept, ...added] }, null, 2) + '\n');
    console.log(`[anon-definers] manifest rewritten: ${kept.length} kept, ${added.length} added as UNREVIEWED.`);
    process.exit(0);
  }

  if (tightened.length) {
    console.log(`[anon-definers] ${tightened.length} listed grant(s) are no longer live - somebody tightened:`);
    for (const s of tightened) console.log(`   - ${s}`);
    console.log('   Not a failure. Drop them from the manifest when convenient.');
  }

  if (unaccounted.length) {
    console.error('');
    console.error(`ANON MAY EXECUTE ${unaccounted.length} DEFINER FUNCTION(S) THIS REPOSITORY HAS NOT ACCOUNTED FOR:`);
    for (const s of unaccounted) console.error(`   ${s}`);
    console.error('');
    console.error('  A SECURITY DEFINER function runs with its owner privileges, so this is');
    console.error('  the surface a logged-out stranger reaches. Add an entry with a reason to');
    console.error('  docs/security/anon-executable-definers.json, or revoke the grant.');
    process.exit(1);
  }

  console.log(`[anon-definers] OK - anon executes ${live.size} definer function(s), every one accounted for.`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
