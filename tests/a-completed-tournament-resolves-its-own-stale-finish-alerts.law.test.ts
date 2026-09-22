/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A COMPLETED TOURNAMENT RESOLVES ITS OWN STALE FINISH ALERTS (law, 2026-09-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 15,909 unresolved critical financial_alerts rows from the four
 * Tournament.atomic_finish_* / atomic_satellite_finish_* sources named a
 * tournament that had, in every single case measured on production, already
 * reached COMPLETED - some as long as 13 days earlier. Nothing re-read the
 * tournament's live status and told the alert its condition had cleared.
 *
 * migration 20260922150500 adds an AFTER UPDATE OF status trigger on
 * public.tournaments that closes those alerts the instant a tournament
 * transitions RUNNING -> COMPLETED, plus a one-time backfill for the rows
 * stranded before the trigger existed. This is a text-level law, in the style
 * of the-break-clocks-agree.law.test.ts: it reads the governing migration
 * (the newest one that defines the trigger function, so a later migration
 * that legitimately redefines it is still checked) and pins the shape that
 * makes the fix correct and safe, rather than exercising a live tournaments
 * fixture through the table's ~40 other guard triggers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const MIGRATIONS_DIR = resolve(__dirname, '..', 'supabase/migrations');

/** The newest migration containing `marker` - the one Postgres ends up with. */
const governing = (marker: string): string => {
  const all = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8').includes(marker));
  expect(all.length, `no migration contains ${marker}`).toBeGreaterThan(0);
  return readFileSync(resolve(MIGRATIONS_DIR, all[all.length - 1]), 'utf8');
};

const FUNCTION_SQL = governing(
  'CREATE OR REPLACE FUNCTION public.fn_ca_tournament_finish_resolves_stale_alerts'
);
const TRIGGER_SQL = governing('CREATE TRIGGER trg_tournament_finish_resolves_stale_alerts');

const SOURCES = [
  'Tournament.atomic_finish_refused',
  'Tournament.atomic_finish_outcome_unknown',
  'Tournament.atomic_satellite_finish_refused',
  'Tournament.atomic_satellite_finish_outcome_unknown',
];

describe('the trigger fires only on a genuine RUNNING -> COMPLETED transition', () => {
  it('is AFTER UPDATE OF status, gated on the exact old/new pair', () => {
    expect(TRIGGER_SQL).toMatch(/AFTER UPDATE OF status ON public\.tournaments/);
    expect(TRIGGER_SQL).toMatch(
      /WHEN \(NEW\.status = 'COMPLETED' AND OLD\.status = 'RUNNING'\)/
    );
  });

  it('never fires from any other prior status (REGISTERING, CANCELLED, ...)', () => {
    // A transition into COMPLETED from anything but RUNNING is not the event
    // this law is about - the WHEN clause above is the only gate, and it must
    // name RUNNING specifically, not a wildcard.
    expect(TRIGGER_SQL).not.toMatch(/OLD\.status IS DISTINCT FROM NEW\.status/);
    expect(TRIGGER_SQL).not.toMatch(/OLD\.status <> 'COMPLETED'/);
  });

  it('is FOR EACH ROW, so one UPDATE of many tournaments checks each one', () => {
    expect(TRIGGER_SQL).toMatch(/FOR EACH ROW/);
  });
});

describe('the function closes exactly the four finish-refusal sources, exactly once', () => {
  it('names all four sources and no others', () => {
    for (const s of SOURCES) {
      expect(FUNCTION_SQL).toContain(`'${s}'`);
    }
    // Guard against silent scope creep: the IN-list literal should contain
    // exactly these four quoted source strings and nothing else.
    const listMatch = FUNCTION_SQL.match(/f\.source IN \(([^)]*)\)/s);
    expect(listMatch, 'could not find the source IN-list').not.toBeNull();
    const quoted = listMatch![1].match(/'[^']+'/g) ?? [];
    expect(quoted.map((q) => q.slice(1, -1)).sort()).toEqual([...SOURCES].sort());
  });

  it('never touches an already-resolved row', () => {
    expect(FUNCTION_SQL).toMatch(/NOT COALESCE\(f\.resolved,\s*false\)/);
  });

  it('correlates on the exact tournament id, not a fuzzy or partial match', () => {
    expect(FUNCTION_SQL).toMatch(
      /\(f\.context->>'tournament_id'\)::uuid = NEW\.id/
    );
  });

  it('guards the uuid cast against a malformed context value', () => {
    expect(FUNCTION_SQL).toMatch(
      /\(f\.context->>'tournament_id'\) ~ '\^\[0-9a-fA-F\]\{8\}-/
    );
  });

  it('records genuine re-measured evidence, never borrowing the word "verified" for silence', () => {
    // Distinguishes this closure from the escalation tick's silence-based
    // aged_out_unverified retirement (20260920183008): this one re-reads the
    // tournament's live status, so 'verified:' is the correct, earned prefix.
    expect(FUNCTION_SQL).toMatch(/'verified: tournament '/);
    expect(FUNCTION_SQL).not.toMatch(/not seen again for/);
  });

  it('never fails the triggering finish: a resolver defect cannot block a real transition', () => {
    expect(FUNCTION_SQL).toMatch(/EXCEPTION WHEN OTHERS THEN/);
    expect(FUNCTION_SQL).toMatch(/RETURN NEW;\s*END;/s);
  });
});

describe('the one-time backfill re-reads live status rather than trusting the migration header', () => {
  const BACKFILL_SQL = governing(
    "resolution  = COALESCE(NULLIF(f.resolution,'') || ' | ', '')\n           || 'verified: tournament '"
  );

  it('only closes a row whose tournament is COMPLETED at apply time, not by count or date', () => {
    expect(BACKFILL_SQL).toMatch(
      /EXISTS \(\s*SELECT 1 FROM public\.tournaments t\s*\n\s*WHERE t\.id = \(f\.context->>'tournament_id'\)::uuid AND t\.status = 'COMPLETED'\)/
    );
  });

  it('is wrapped in a single transaction with a post-check that aborts on disagreement', () => {
    expect(BACKFILL_SQL).toMatch(/^BEGIN;/m);
    expect(BACKFILL_SQL).toMatch(/^COMMIT;/m);
    expect(BACKFILL_SQL).toMatch(/ABORT: % alert\(s\) still unresolved against a COMPLETED tournament/);
  });
});
