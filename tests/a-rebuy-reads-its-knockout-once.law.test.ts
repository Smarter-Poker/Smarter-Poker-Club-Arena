/**
 * A REBUY READS ITS KNOCKOUT ONCE.
 *
 * process_tournament_rebuy reads its knockout generation as
 *   WHERE c.id = public.fn_ca_latest_committed_knockout_candidate(...)
 * While that function was VOLATILE the planner could not use it as an index
 * key: it sequentially scanned ~402,000 tournament_knockout_candidates rows
 * and called the function once per row, so a rebuy held its MTT's settlement
 * lane for 18-29 s and ~240 per-hand calls of that MTT timed out in ten
 * minutes (production, 2026-10-03 16:40-16:50 UTC).
 *
 * The function only reads and raises, so it is STABLE. A later
 * CREATE OR REPLACE that omits STABLE makes it VOLATILE again without anyone
 * noticing; this law refuses that.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const ALL = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const NAME = ALL.filter((f) => f.endsWith('_a_rebuy_reads_its_knockout_once.sql')).at(-1);
if (!NAME) throw new Error('the rebuy knockout migration is missing');
const code = (file: string): string =>
  readFileSync(join(MIGRATIONS, file), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

describe('a rebuy reads its knockout once', () => {
  it('marks fn_ca_latest_committed_knockout_candidate STABLE in one transaction and asserts it', () => {
    const sql = code(NAME);
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
    expect(sql).toMatch(
      /ALTER FUNCTION public\.fn_ca_latest_committed_knockout_candidate\(uuid, uuid\) STABLE;/
    );
    expect(sql).toMatch(/provolatile[\s\S]*IS DISTINCT FROM 's'/);
    // The fix is the volatility only: no body, grant or owner change rides along.
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/\b(GRANT|REVOKE)\b/);
  });

  it('no later migration redefines the function without STABLE', () => {
    const later = ALL.slice(ALL.indexOf(NAME) + 1);
    for (const file of later) {
      const sql = code(file);
      const re =
        /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_ca_latest_committed_knockout_candidate\s*\(([\s\S]*?)\$(\w*)\$/gi;
      for (const m of sql.matchAll(re)) {
        // Everything between the signature and the body's opening quote holds
        // the function's attributes.
        expect(m[1], `${file} redefines the knockout reader without STABLE`).toMatch(
          /\bSTABLE\b/i
        );
      }
      expect(
        sql,
        `${file} makes the knockout reader VOLATILE again`
      ).not.toMatch(
        /ALTER\s+FUNCTION\s+public\.fn_ca_latest_committed_knockout_candidate[\s\S]{0,80}?\bVOLATILE\b/i
      );
    }
  });
});
