/**
 * A SECURITY DEFINER FUNCTION RUNS WITH ITS OWNER'S PRIVILEGES.
 *
 * The set of them a logged-out visitor may EXECUTE is the anonymous attack
 * surface of this database, and on 2026-09-18 nobody had a list of it: 2,571
 * definer functions in `public`, 35 reachable by `anon`, 772 by
 * `authenticated`. Thirteen of the 35 grants did nothing and were revoked by
 * migration 20260918121836.
 *
 * The live comparison is scripts/ci/check-anon-definer-grants.mjs, which needs
 * a database. This law holds the half that does not: the manifest must stay a
 * list somebody can be held to - every entry reasoned, none of them a trigger
 * function, no duplicates, never empty.
 *
 * `trgfn_*` has its own assertion because that was the measured finding: a
 * trigger function is reachable only by the trigger mechanism, and firing does
 * not check the triggering role's EXECUTE - proven with a throwaway temp table
 * and the privilege explicitly revoked, where the INSERT still succeeded. So a
 * trigger function on this list is always a grant nobody needs.
 */
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  readManifest,
  allowedSignatures,
  compare,
} from '../scripts/ci/check-anon-definer-grants.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'docs/security/anon-executable-definers.json');

describe('anon executes only what this repository accounts for', () => {
  const doc = readManifest(MANIFEST);

  it('is not empty - an empty allowlist is a broken scan, not a clean one', () => {
    expect(doc.allowed.length).toBeGreaterThan(0);
  });

  it('gives every entry a reason drawn from the declared set', () => {
    const reasons = Object.keys(doc._reasons ?? {});
    expect(reasons.length).toBeGreaterThan(0);
    const unreasoned = doc.allowed.filter((e: any) => !reasons.includes(e.reason));
    expect(
      unreasoned.map((e: any) => `${e.fn} -> ${e.reason}`),
      'every anon-executable definer function must say why a logged-out visitor may run it'
    ).toEqual([]);
  });

  it('never lists a trigger function, which can never need the grant', () => {
    const triggers = doc.allowed.filter((e: any) => /^trgfn_/.test(e.fn));
    expect(
      triggers.map((e: any) => e.fn),
      'a trigger function is reached only by the trigger mechanism, and firing does not check the triggering role EXECUTE'
    ).toEqual([]);
  });

  it('lists each signature once', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of doc.allowed as any[]) {
      if (seen.has(e.fn)) dupes.push(e.fn);
      seen.add(e.fn);
    }
    expect(dupes).toEqual([]);
  });

  it('carries the two overloads of legacy_transition_eligible separately', () => {
    // Both are named by policies anon evaluates. Collapsing them to a bare name
    // would let one lose its entry without the list noticing.
    const sigs = allowedSignatures(doc);
    expect([...sigs].filter((s) => s.startsWith('legacy_transition_eligible(')).length).toBe(2);
  });

  it('flags a live grant the manifest does not account for, and never punishes tightening', () => {
    const allowed = new Set(['a()', 'b()']);
    const live = new Set(['a()', 'c()']);
    const { unaccounted, tightened } = compare(live, allowed);
    expect(unaccounted).toEqual(['c()']);
    expect(tightened).toEqual(['b()']);
  });

  it('the revocation migration exists and leaves authenticated alone', () => {
    const sql = readFileSync(
      join(ROOT, 'supabase/migrations/20260918121836_anon_executes_only_what_it_needs.sql'),
      'utf8'
    );
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.is_admin\(\)\s+FROM anon;/);
    expect(sql).not.toMatch(/REVOKE[^\n]*FROM authenticated/);
    // it must check its own work rather than assume the REVOKEs landed
    expect(sql).toMatch(/RAISE EXCEPTION 'anon still executes/);
    expect(sql).toMatch(/authenticated lost EXECUTE/);
  });
});
