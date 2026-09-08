/**
 * ===========================================================================
 *  A SATELLITE SEAT IS A PAYOUT, AND AN UNKNOWN ORIGIN IS NOT A "NO"
 *  (2026-08-31, MTT Phase 5)
 * ===========================================================================
 *
 * Every FAILURE path in processSatelliteAwards pays cash through
 * fn_credit_and_log, so Phase 3's payout record already evidences it. The
 * SUCCESS path - a player actually receiving a seat - moves real value and
 * left no record at all. 19 seats were awarded that way.
 *
 * And when a winner already holds the target seat, the caller has to choose
 * between paying nothing (this satellite seated them, recovery re-drive) and
 * paying the ticket value (a different satellite seated them). The flag that
 * decides it, source_satellite_id, has only been written since 2026-08-30, so
 * all 19 earlier seats have it NULL - and the old expression collapsed NULL to
 * FALSE, which is the answer that MOVES MONEY.
 *
 * These pins keep both properties.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', '..', '..', 'supabase', 'migrations');
const SRC = join(__dirname, '..', '..', 'src');

const migration = (needle: string): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(needle));
  if (!file) throw new Error(`no migration matching "${needle}" - was it renamed?`);
  return readFileSync(join(MIGRATIONS, file), 'utf8');
};

/** Executable SQL only - `--` comment lines stripped. */
const executable = (sql: string): string =>
  sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

const AWARD = () => executable(migration('a_satellite_seat_is_a_payout'));
const ATOMIC_FINISH = () =>
  executable(migration('a_satellite_finish_pays_one_frozen_entitlement_plan'));
const MANAGER = () => readFileSync(join(SRC, 'tournament', 'TournamentManager.ts'), 'utf8');

describe('the seat itself is recorded', () => {
  it('writes a tournament_payouts row inside the awarding transaction', () => {
    const sql = AWARD();
    expect(sql).toContain('INSERT INTO public.tournament_payouts');
    expect(sql).toContain("'satellite_seat'");
  });

  it('records it under a key, so a re-drive writes nothing new', () => {
    expect(AWARD()).toMatch(/':seat:'/);
    expect(AWARD()).toContain('ON CONFLICT (idempotency_key)');
  });

  it('names the target it was awarded into', () => {
    const sql = AWARD();
    expect(sql).toContain("'satellite_target_id'");
    expect(sql).toContain("'registration_id'");
  });

  it('never lets a failed record unseat a player', () => {
    // The seat is the thing of value. A bookkeeping failure is raised as money,
    // never allowed to abort the award.
    const sql = AWARD();
    expect(sql).toContain('EXCEPTION WHEN OTHERS THEN');
    expect(sql).toContain("'satellite_seat_record'");
    expect(sql).toContain('financial_alerts');
  });

  it('is NOT a source the structure reconciler counts', () => {
    // A seat is funded by the satellite's pool buying a ticket, not by the
    // satellite's prize_pool paying a place. Counting it as structure cash
    // would make every satellite read as a massive overpay.
    const reconciler = executable(migration('the_reconciler_counts_payouts_not_ledger_rows'));
    const inList = (reconciler.match(/AND tpo\.source IN \(([\s\S]*?)\)/) ?? [])[1] ?? '';
    expect(inList.length).toBeGreaterThan(0);
    expect(inList).not.toContain('satellite_seat');
  });
});

describe('an unknown origin is not a "no"', () => {
  it('returns NULL, not false, when it cannot tell who seated them', () => {
    const sql = AWARD();
    expect(sql).toMatch(/v_seated := CASE WHEN v_existing IS NULL THEN NULL/);
    expect(sql).toContain("'origin_unknown'");
  });

  it('no longer collapses NULL to false', () => {
    // The old expression was
    //   (v_existing IS NOT NULL AND v_existing = p_satellite_id)
    // which answers "a different satellite seated them" for an unknown.
    expect(AWARD()).not.toMatch(/v_existing IS NOT NULL AND v_existing = p_satellite_id/);
  });

  it('the atomic adopter refuses ambiguous or incompletely-backed legacy seats', () => {
    const sql = ATOMIC_FINISH();
    expect(sql).toContain('existing target satellite seat has ambiguous origin');
    expect(sql).toContain('existing target seat has no exact fully-backed payout event');
    expect(sql).toContain("l.metadata->>'unbacked'");
  });

  it('one database RPC owns every seat/cash outcome and completion', () => {
    const manager = MANAGER();
    expect(manager).toContain("supabase.rpc('fn_settle_satellite_finish_atomic'");
    expect(manager).not.toContain("supabase.rpc('fn_award_satellite_seat'");
    expect(manager).not.toContain('settleTournamentObligation(supabase');
  });

  it('passes the finishing place, so the record can name it', () => {
    expect(ATOMIC_FINISH()).toMatch(
      /fn_deliver_satellite_ticket_exact\([\s\S]*?p_tournament_id,[\s\S]*?e\.position,e\.ticket_value/
    );
  });
});

describe('the overload trap stays shut', () => {
  it('drops the four-argument form, which PostgREST could not disambiguate', () => {
    const drop = executable(migration('drop_the_four_argument_satellite_seat_overload'));
    expect(drop).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_award_satellite_seat\(uuid, uuid, uuid, text\)/
    );
  });

  it('the five-argument form is service_role only', () => {
    const sql = AWARD();
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.fn_award_satellite_seat');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('TO service_role');
  });
});

describe('the spin unpaid view stays narrow on purpose', () => {
  const view = () => executable(migration('the_spin_unpaid_view_stays_narrow'));

  it('keeps the INNER join on the reserve draw', () => {
    // Widening it made fn_backpay_spin_unpaid_winners stop completing inside
    // 60s, to close a gap measured at 0.00 chips owed. If someone widens it
    // again, they must fix the cost first.
    expect(view()).toMatch(/FROM draw d\s*\n\s*JOIN tournaments t/);
  });

  it('does not fall back to prize_pool', () => {
    // That fallback makes 4,590 CANCELLED spins read as 21,329 chips short and
    // raises one critical alert each.
    expect(view()).not.toMatch(/COALESCE\(d\.prize_drawn, t\.prize_pool\)/);
  });
});
