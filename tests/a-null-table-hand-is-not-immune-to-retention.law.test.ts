/**
 * ===========================================================================
 *  LAW: A NULL-TABLE HAND IS NOT IMMUNE TO RETENTION
 * ===========================================================================
 *
 * public.sp_prune_hand_history's candidate set required
 * `EXISTS (SELECT 1 FROM public.tables tb WHERE tb.id = hh.table_id ...)`
 * before it would consider a has_human=false row for deletion. NULL never
 * equals NULL in SQL, so a row with table_id IS NULL could never satisfy
 * that EXISTS - it was silently excluded from every run of the job, forever,
 * with no age at which it would ever prune.
 *
 * tests/e2e/production-daily-missions.spec.ts certifies the settled-hand
 * daily-mission trigger against LIVE production by inserting exactly this
 * shape (table_id NULL, tournament_id NULL, has_human false, hand_number
 * reserved in 1,700,000,000-1,799,999,999) and deleting it in a try/finally.
 * When a certification run is cancelled or killed before that finally block
 * runs, the row is orphaned - and, because of this exclusion, permanently:
 * not eight days, not eighty, forever. Four such rows were found in
 * production on 2026-09-26 (board Smarter-Poker/Smarter-Poker-Club-Arena
 * #5070), the oldest already eleven days past the retention window it could
 * never reach. They tripped the cash-pot conservation monitor's
 * "no winner recorded" check, which reads any settled hand with an empty
 * `winners` array as a real hand that never paid.
 *
 * Measured against production before the fix: table_id IS NULL matches
 * exactly 4 rows in the whole of public.hand_history, all 4 are this exact
 * fixture signature, and the real hand_number domain tops out at 14.8
 * million - nowhere near the reserved range. A table_id-IS-NULL,
 * tournament_id-IS-NULL row can never be a live table's movement boundary,
 * because there is no table; smarter_private.f06_hand_cards_unresolved and
 * smarter_private.f06_movement_boundary_retained both already return false
 * for a NULL table_id. So admitting such a row on that basis alone, ahead
 * of the EXISTS check, changes nothing for any row that DOES reference a
 * table - the fix is additive, not a relaxation of the existing check.
 *
 * This is CLAUDE.md 10.11/10.12's shape: the fix lives in the existing
 * scheduled retention sweep (no new cron, no new timer), and it makes the
 * four already-leaked rows self-heal on the job's normal cadence as each
 * ages past hand_history_retention_policy.horse_retention_days, with no
 * direct DELETE against production in the fixing migration (CLAUDE.md 10.5:
 * the fleet does not hand-delete production rows).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sliceSqlStatement } from './helpers/sourceWindow';

const ROOT = path.resolve(__dirname, '..');
const MIG_DIR = path.join('supabase', 'migrations');

const MIGRATIONS = fs
  .readdirSync(path.join(ROOT, MIG_DIR))
  .filter((f) => f.endsWith('.sql'))
  .sort();

const BODY = new Map<string, string>(
  MIGRATIONS.map((f) => [f, fs.readFileSync(path.join(ROOT, MIG_DIR, f), 'utf8')])
);

/** The LAST migration (by version) that redefines the function is the live one. */
function currentDefiner(qualified: string): string {
  const [schema, name] = qualified.split('.');
  const re = new RegExp(
    String.raw`create\s+or\s+replace\s+function\s+(?:${schema}\s*\.\s*)?"?${name}"?\s*\(`,
    'i'
  );
  const definers = MIGRATIONS.filter((f) => re.test(BODY.get(f) as string));
  expect(definers.length, `${qualified} must be defined by a migration`).toBeGreaterThan(0);
  return definers[definers.length - 1];
}

function pruneJob(): { file: string; stmt: string } {
  const file = currentDefiner('public.sp_prune_hand_history');
  return {
    file,
    stmt: sliceSqlStatement(
      BODY.get(file) as string,
      'CREATE OR REPLACE FUNCTION public.sp_prune_hand_history'
    ),
  };
}

describe('a null-table hand is not immune to retention', () => {
  it('scans a real migration tree (an empty sweep must not read as a pass)', () => {
    // CLAUDE.md 10.86 rule 2.
    expect(MIGRATIONS.length).toBeGreaterThan(1000);
  });

  it('a candidate with no table and no tournament is admitted without the tables EXISTS check', () => {
    const { file, stmt } = pruneJob();
    expect(
      /hh\.table_id\s+is\s+null\s+and\s+hh\.tournament_id\s+is\s+null/i.test(stmt),
      `${file}: sp_prune_hand_history must treat (table_id IS NULL AND tournament_id IS NULL) ` +
        'as a candidate on its own - otherwise NULL never equals NULL in the tables EXISTS ' +
        'join below and such a row is excluded from every run, forever, at any age'
    ).toBe(true);
  });

  it('that admission sits ahead of the original tables/tournament EXISTS check, not in place of it', () => {
    const { file, stmt } = pruneJob();
    // The original clause must still be present verbatim as the OTHER arm of
    // the OR - a row that DOES reference a table is checked exactly as
    // before. This is what makes the fix additive rather than a relaxation.
    expect(
      /\(\s*hh\.table_id\s+is\s+null\s+and\s+hh\.tournament_id\s+is\s+null\s*\)\s*\n?\s*or\s+exists\s*\(\s*select\s+1\s+from\s+public\.tables\s+tb/i.test(
        stmt
      ),
      `${file}: the new admission must be OR'd ahead of "EXISTS (SELECT 1 FROM public.tables ` +
        'tb ...)", so a table-bearing row keeps requiring exactly the check it always did'
    ).toBe(true);
    expect(
      stmt.includes('tb.id=hh.table_id') || /tb\.id\s*=\s*hh\.table_id/i.test(stmt),
      `${file}: the original tb.id = hh.table_id join must survive unchanged for table-bearing rows`
    ).toBe(true);
  });

  it('the F06 guards this admission relies on being NULL-safe are unchanged and still consulted', () => {
    const { file, stmt } = pruneJob();
    expect(
      /and\s+not\s+smarter_private\s*\.\s*f06_hand_cards_unresolved\s*\(/i.test(stmt),
      `${file}: f06_hand_cards_unresolved must still gate every candidate, table_id NULL included`
    ).toBe(true);
    expect(
      /and\s+not\s+smarter_private\s*\.\s*f06_movement_boundary_retained\s*\(/i.test(stmt),
      `${file}: f06_movement_boundary_retained must still gate every candidate, table_id NULL included`
    ).toBe(true);
  });

  it("retention still reads the policy row, so eight days stays Dan's to change", () => {
    // CLAUDE.md 10.5: the retention window is a config row, not code.
    const { file, stmt } = pruneJob();
    expect(
      ['horse_retention_days', 'hand_history_retention_policy'].every((t) => stmt.includes(t)),
      `${file}: the window must come from hand_history_retention_policy.horse_retention_days`
    ).toBe(true);
  });

  it('retention still requires has_human is not true, so no real player hand is ever touched', () => {
    const { file, stmt } = pruneJob();
    expect(
      /hh\.has_human\s+is\s+distinct\s+from\s+true/i.test(stmt),
      `${file}: only has_human IS DISTINCT FROM true rows may be pruned - a real hand a human ` +
        'played must never become eligible through this change'
    ).toBe(true);
  });

  it('the migration that ships this never deletes a production row directly', () => {
    // CLAUDE.md 10.5: the fleet does not hand-delete production rows. The fix
    // is the sweep's own eligibility rule; leaked rows self-heal on its
    // normal cadence as each ages past the retention window.
    const file = currentDefiner('public.sp_prune_hand_history');
    const fullMigration = BODY.get(file) as string;
    expect(
      /delete\s+from\s+(?:public\s*\.\s*)?"?hand_history"?\s+where\s+id\s*=\s*any/i.test(
        sliceSqlStatement(fullMigration, 'CREATE OR REPLACE FUNCTION public.sp_prune_hand_history')
      ),
      `${file}: the only DELETE FROM hand_history must remain the one inside the function body, ` +
        'keyed on the batch it computed - never a literal id list against known leaked rows'
    ).toBe(true);
  });
});
