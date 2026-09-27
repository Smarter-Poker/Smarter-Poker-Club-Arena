#!/usr/bin/env node
/**
 * ===========================================================================
 *  ONE MIGRATION, TWO NAMES: THE APPLY-TIME ALIAS
 * ===========================================================================
 *
 * WHY THIS EXISTS (2026-09-27)
 *
 * The Supabase MCP stamps its own version when it applies a migration, and an
 * agent often submits it under a shorter or revised name. So the SAME change
 * is routinely recorded in supabase_migrations.schema_migrations as, say,
 * `20260428204959 x2_001_audit_trail` while this repository carries it as
 * `20260428000001_audit_trail.sql`.
 *
 * Both gates match by name, and a name that differs is read twice, wrongly:
 *
 *   check-applied-migrations-are-recorded   "installed, and no file"
 *   check-migrations-are-live               "merged, and never installed"
 *
 * The 2026-09-27 reconciliation measured 52 such pairs. Backfilling the
 * applied SQL as a second file would put the same change into a rebuild
 * twice, so they are recorded here instead, in
 * scripts/ci/applied-migration-aliases.json, and both gates read it.
 *
 * A ROW IS A CLAIM, NOT A PARDON. It is honoured only when:
 *
 *   - `appliedVersion` is a 14-digit version and `file` is a path under
 *     supabase/migrations/ that exists in THIS tree;
 *   - no file in this tree already carries `appliedVersion` (then the alias is
 *     redundant, and a stale one would hide a real collision);
 *
 * and scripts/ci/check-recorded-migrations-evidence.mjs asks production that
 * `appliedVersion` exists with `appliedMd5`, inside the scheduled
 * `Applied Migrations Are Recorded` workflow, which files an issue when a
 * claim does not hold.
 *
 * THREE OUTCOMES (CLAUDE.md 10.86 rule 1). An unreadable or malformed file is
 * `error`, never an empty map read as "no aliases" by one caller and "all
 * recorded" by another. Callers treat `error` as COULD NOT TELL.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ALIASES_PATH = 'scripts/ci/applied-migration-aliases.json';
const DIR = 'supabase/migrations/';

function root(repo) {
  return repo || join(HERE, '..', '..');
}

/**
 * `{ byVersion: Map<appliedVersion,row>, byFile: Map<file,row[]>, rejected: string[], error }`.
 * `rejected` names rows that were read and refused, so a caller can say so.
 */
export function loadAliases(repo, { files } = {}) {
  const base = root(repo);
  const out = {
    byVersion: new Map(),
    byFile: new Map(),
    superseded: new Map(),
    rejected: [],
    error: null,
  };
  const path = join(base, ALIASES_PATH);
  if (!existsSync(path)) {
    out.error = `${ALIASES_PATH} not found`;
    return out;
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    out.error = `${ALIASES_PATH} is not valid JSON: ${err.message}`;
    return out;
  }
  if (!Array.isArray(raw?.aliases)) {
    out.error = `${ALIASES_PATH} has no \`aliases\` array`;
    return out;
  }
  let onDisk = files;
  if (!onDisk) {
    try {
      onDisk = readdirSync(join(base, DIR));
    } catch (err) {
      out.error = `${DIR} is unreadable: ${err.message}`;
      return out;
    }
  }
  const present = new Set(onDisk.map((f) => String(f).split('/').pop()));
  const ownedVersions = new Set(
    [...present].map((f) => /^(\d{14})_/.exec(f)?.[1]).filter(Boolean)
  );
  for (const row of raw.aliases) {
    const v = String(row?.appliedVersion ?? '');
    const file = String(row?.file ?? '');
    const label = `${v || '?'} -> ${file || '?'}`;
    if (!/^\d{14}$/.test(v) || !file.startsWith(DIR) || !file.endsWith('.sql')) {
      out.rejected.push(`${label}: malformed row`);
      continue;
    }
    const base = file.slice(DIR.length);
    if (!present.has(base)) {
      out.rejected.push(`${label}: the file is not in this tree`);
      continue;
    }
    if (ownedVersions.has(v)) {
      out.rejected.push(`${label}: ${v} already has a file of its own`);
      continue;
    }
    if (out.byVersion.has(v)) {
      out.rejected.push(`${label}: ${v} is aliased twice`);
      continue;
    }
    out.byVersion.set(v, row);
    if (!out.byFile.has(base)) out.byFile.set(base, []);
    out.byFile.get(base).push(row);
  }
  // A merged file that must never run, marked here because it is byte-pinned
  // and cannot carry its own "-- SUPERSEDED BY" line. Same terms as the header:
  // the superseding version must have a file in this tree, and a reason.
  for (const row of Array.isArray(raw.superseded) ? raw.superseded : []) {
    const file = String(row?.file ?? '');
    const by = String(row?.by ?? '');
    const label = `superseded ${file || '?'} by ${by || '?'}`;
    const base = file.startsWith(DIR) ? file.slice(DIR.length) : '';
    if (!base || !/^\d{14}$/.test(by) || String(row?.reason ?? '').length < 40) {
      out.rejected.push(`${label}: malformed row`);
      continue;
    }
    if (!present.has(base)) {
      out.rejected.push(`${label}: the file is not in this tree`);
      continue;
    }
    if (![...present].some((f) => f.startsWith(`${by}_`))) {
      out.rejected.push(`${label}: no file carries ${by}`);
      continue;
    }
    out.superseded.set(base, row);
  }
  return out;
}
