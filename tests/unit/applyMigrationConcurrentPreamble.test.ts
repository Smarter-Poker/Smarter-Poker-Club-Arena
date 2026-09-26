import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error - plain ESM helper shared with scripts/ci/apply-recorded-migration.mjs
import {
  splitConcurrentPreamble,
  minutesBeforeBreakWindow,
} from '../../scripts/ci/migration-concurrent-preamble.mjs';

// apply-recorded-migration.mjs (the Apply Merged Migration door) sends a file as
// one simple query so a migration is one transaction. CREATE INDEX CONCURRENTLY
// cannot run in any transaction block, so a file that builds a ledger index
// that way could not go through the door at all. The door now accepts exactly
// that shape - concurrent index builds, then ONE transaction - and nothing wider.

const TX =
  'BEGIN;\nCREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nCOMMIT;\n';

describe('the apply door accepts concurrent index builds before the transaction and nothing else', () => {
  it('splits eight concurrent builds from the transaction, in file order', () => {
    const file = readFileSync(
      join(
        'supabase/migrations',
        '20260925205938_the_weekly_rakeback_gate_stops_proving_every_tournament_one_.sql'
      ),
      'utf8'
    );
    const shape = splitConcurrentPreamble(file);
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;
    expect(shape.indexes.map((i: { name: string }) => i.name)).toEqual([
      'accounting_tournament_recognized_sources_event',
      'accounting_tournament_fee_sources_club_event',
      'accounting_tournament_fee_sources_coordinator_event',
      'accounting_tournament_fee_recognitions_week',
      'tournament_rake_settlements_settled_week',
      'tournament_terminal_settlements_settled_week',
      'tournament_refund_entitlements_club_event',
      'rake_attributions_club_record',
    ]);
    expect(shape.body.startsWith('BEGIN;')).toBe(true);
    expect(shape.body.trim().endsWith('COMMIT;')).toBe(true);
    // Everything that is not an index build is inside the transaction.
    expect(shape.body).toContain(
      'COMMENT ON INDEX public.accounting_tournament_recognized_sources_event'
    );
  });

  it('keeps every ordinary one-transaction migration exactly as it was', () => {
    const files = readdirSync('supabase/migrations').filter((f) =>
      /^202609(1[5-9]|2\d)\d{6}_[a-z0-9_]+\.sql$/.test(f)
    );
    let accepted = 0;
    for (const f of files) {
      const sql = readFileSync(join('supabase/migrations', f), 'utf8');
      const old = /^\s*BEGIN\s*;/im.test(sql) && /COMMIT\s*;\s*$/i.test(sql.trim());
      if (!old) continue;
      const shape = splitConcurrentPreamble(sql);
      expect(shape.ok, `${f}: ${shape.ok ? '' : shape.reason}`).toBe(true);
      accepted++;
    }
    expect(accepted).toBeGreaterThan(100);
  });

  it('accepts comments, including block comments and apostrophes, before BEGIN;', () => {
    const sql =
      "-- it's fine\n/* a /* nested */ note; with a semicolon */\nCREATE INDEX CONCURRENTLY IF NOT EXISTS a_b ON public.t (x) WHERE y IS NOT NULL;\n" +
      TX;
    const shape = splitConcurrentPreamble(sql);
    expect(shape.ok).toBe(true);
    if (shape.ok) expect(shape.indexes).toHaveLength(1);
  });

  it.each([
    [
      'a plain CREATE INDEX, which locks the table',
      'CREATE INDEX IF NOT EXISTS a_b ON public.t (x);\n',
    ],
    [
      'a build without IF NOT EXISTS, which cannot be re-dispatched',
      'CREATE INDEX CONCURRENTLY a_b ON public.t (x);\n',
    ],
    [
      'a COMMENT, which would autocommit and reload PostgREST',
      "COMMENT ON TABLE public.t IS 'x';\n",
    ],
    [
      'a function, which belongs in the transaction',
      'CREATE FUNCTION public.g() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n',
    ],
    ['a DROP', 'DROP INDEX CONCURRENTLY IF EXISTS public.a_b;\n'],
    ['an index outside public', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS a_b ON private.t (x);\n'],
    ['an unterminated statement', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS a_b ON public.t (x)\n'],
  ])('refuses %s before BEGIN;', (_label, preamble) => {
    expect(splitConcurrentPreamble(preamble + TX).ok).toBe(false);
  });

  it('refuses a file whose transaction is not the end of it', () => {
    expect(splitConcurrentPreamble(TX + '\nSELECT 1;\n').ok).toBe(false);
    expect(
      splitConcurrentPreamble('CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON public.t (x);\n').ok
    ).toBe(false);
  });

  it('refuses the same index twice', () => {
    const one = 'CREATE INDEX CONCURRENTLY IF NOT EXISTS a_b ON public.t (x);\n';
    expect(splitConcurrentPreamble(one + one + TX).ok).toBe(false);
  });

  it('counts the room left before the :50 break window, and none inside it', () => {
    expect(minutesBeforeBreakWindow(new Date('2026-09-26T03:10:00Z'))).toBe(40);
    expect(minutesBeforeBreakWindow(new Date('2026-09-26T03:45:00Z'))).toBe(5);
    expect(minutesBeforeBreakWindow(new Date('2026-09-26T03:50:00Z'))).toBe(0);
    expect(minutesBeforeBreakWindow(new Date('2026-09-26T04:02:59Z'))).toBe(0);
    expect(minutesBeforeBreakWindow(new Date('2026-09-26T04:03:00Z'))).toBe(47);
  });
});
