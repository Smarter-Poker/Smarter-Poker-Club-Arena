import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadSchemaManifest } from '../../scripts/ci/schema-manifest.mjs';

/**
 * A MANIFEST FRAGMENT IS A PROMISE, NOT AN OBSERVATION
 *
 * `scripts/ci/supabase-schema-manifest.json` is generated FROM the live schema,
 * so a name in it was seen in production. A file in
 * `scripts/ci/schema-manifest.d/` is a line the branch author typed. The loader
 * unions them, which is the right answer for "may this branch reference that
 * name" and the wrong answer for "did the migration run".
 *
 * `check-migrations-applied.mjs` asked the second question and read the union.
 * On 2026-09-22 it printed, about
 * `20260922143541_club_and_union_diamond_commerce.sql`:
 *
 *     3 changed migration(s); 0 unapplied object(s).
 *     OK - every object these migrations declare exists in the live schema.
 *
 * Fourteen tables and thirty-five functions later, production had none of them.
 * The fragment's own `_owner` field said "Applied as 20260922143541"; it had
 * not been. The merge landed, `Every merged migration is live` went red on
 * main, and `Prove The Exact Engine Has Every Production Door` correctly
 * refused every engine release from that point - three of those functions are
 * called by server/src/services/CommerceRenewalConsumer.ts.
 *
 * CLAUDE.md 10.86 rule 2: an answer that could not be read must never be
 * coerced into a good one. So the loader now keeps the fragment-only names
 * separate, and the gate reports them as PROMISED - by name, with the file that
 * promised them - instead of describing them as live.
 *
 * WHY PROMISED DOES NOT BLOCK. The fragment mechanism exists so a branch can
 * reference an object it HAS applied before the nightly base regenerates, and
 * that state is normal and common. A gate that refused it would wedge every
 * migration author on this estate, which is worse than the staleness it reports
 * - the same ruling CLAUDE.md 10.87 makes about the freshness guard. What the
 * change removes is the CLAIM, not anyone's ability to ship.
 */

const GATE = readFileSync('scripts/ci/check-migrations-applied.mjs', 'utf8');

describe('a fragment is a promise, not an observation', () => {
  it('the loader reports fragment-only names separately from the live snapshot', () => {
    const m = loadSchemaManifest(process.cwd()) as {
      tables: string[];
      functions: string[];
      promisedTables: string[];
      promisedFunctions: string[];
    };
    expect(Array.isArray(m.promisedTables)).toBe(true);
    expect(Array.isArray(m.promisedFunctions)).toBe(true);

    const base = JSON.parse(readFileSync('scripts/ci/supabase-schema-manifest.json', 'utf8')) as {
      tables?: string[];
      functions?: string[];
    };
    const baseTables = new Set(base.tables ?? []);
    const baseFns = new Set(base.functions ?? []);

    // A promised name is by definition one the live snapshot has never seen.
    for (const t of m.promisedTables) expect(baseTables.has(t)).toBe(false);
    for (const f of m.promisedFunctions) expect(baseFns.has(f)).toBe(false);

    // ...and it is still in the effective union, or the fragment would do nothing.
    const effTables = new Set(m.tables);
    const effFns = new Set(m.functions);
    for (const t of m.promisedTables) expect(effTables.has(t)).toBe(true);
    for (const f of m.promisedFunctions) expect(effFns.has(f)).toBe(true);
  });

  it('the gate never calls a fragment-only object live, and says who has not been asked', () => {
    expect(GATE).toMatch(/promisedFunctions/);
    expect(GATE).toMatch(/promisedTables/);
    expect(GATE).toMatch(/NOTHING HAS ASKED PRODUCTION/);
    // The unconditional claim is what produced the wrong outcome. It may only
    // be printed when there was no promise to qualify it.
    expect(GATE).toMatch(
      /promises\.length\s*\n?\s*\?\s*"OK — nothing this branch declares is missing/
    );
  });

  it('keeps "could not tell" as its own exit code, distinct from clean and from unapplied', () => {
    // 0 clean, 1 unapplied, 2 could-not-tell. A credential that is present but
    // unreadable must never render as green (CLAUDE.md 10.86 rule 1).
    expect(GATE).toMatch(/COULD NOT ASK THE DATABASE/);
    expect(GATE).toMatch(/This is not a pass\./);
    expect(GATE).toMatch(/0 clean · 1 an unapplied object · 2 script error or could-not-tell/);
  });

  it('never carries a credential of its own', () => {
    // It may READ one from the environment and must never contain one.
    expect(GATE).toMatch(/process\.env\.SUPABASE_DB_URL \|\| process\.env\.DATABASE_URL/);
    expect(GATE).not.toMatch(/postgres(ql)?:\/\/[^\s'"`]*:[^\s'"`@]+@/);
  });
});
