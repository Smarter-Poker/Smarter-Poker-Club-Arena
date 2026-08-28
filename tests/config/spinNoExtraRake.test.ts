/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SPIN CHARGES THE BUY-IN AND NOTHING ELSE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * src/config/spinSpec.ts states this in capitals, quoting Dan: "THEY ARE
 * STRAIGHT JUST 10 BUY IN... NO ADDITIONAL RAKE IS ADDED", and spells out the
 * cost of getting it wrong - "had the player been charged buy-in PLUS 8% on
 * top, the true edge would have been 14.7%, which is not what any room
 * advertises."
 *
 * Every layer BELIEVED that rule. None enforced it. And believing it was worse
 * than not knowing it, because the two things that watch the reserve were both
 * written to skip anything that broke it:
 *
 *   fn_spin_sweep_unbooked ... AND COALESCE(t.buy_in_fee, 0) = 0
 *   v_spin_reserve_health  ... AND COALESCE(t.buy_in_fee, 0) = 0   (unbooked_24h)
 *
 * So a Spin with a fee was double-raked AND invisible: the backstop would not
 * settle it, and the counter whose entire job is to notice unsettled games did
 * not count it. Measured on 2026-08-22: 7,120 of 9,603 spins carried a fee, and
 * 2,116 of them RAN and were never booked - 12,431.04 that should have entered
 * the reserve, 11,488.00 of prizes that never left it, and not one alert.
 *
 * The fee stopped at the spinSpec cutover on 2026-08-20 19:23 UTC. Nothing
 * stopped it coming back. Now something does.
 *
 * These read source rather than execute it, in the house style of
 * spinReserveOwnership and spinEngineWiring. The constraint's live behaviour is
 * proven against production in a rolled-back transaction, recorded under APPLY
 * HISTORY in the migration itself.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const sqlCode = (src: string) => src.replace(/^[ \t]*--.*$/gm, '');

const MIGRATION = 'supabase/migrations/20260822230000_spin_no_extra_rake.sql';
const migration = sqlCode(read(MIGRATION));
const spec = read('src/config/spinSpec.ts');

describe('the rule is still the rule', () => {
  it('spinSpec still says the buy-in is the whole charge', () => {
    // If this ever changes, the constraint below is enforcing a rule the
    // product no longer has, and it should be removed deliberately rather
    // than discovered by a failed insert.
    expect(spec).toMatch(/buy_in_fee` MUST be 0 on a Spin|buy_in_fee MUST be 0 on a Spin/);
  });

  it('the rake is the multiplier distribution, not a surcharge', () => {
    // Was SPIN_RAKE_BANDS. The bands were deleted on 2026-08-27 because one
    // multiplier table can only ever satisfy one rate; the flat constant and
    // the assertion below it are what the bands should have been.
    expect(spec).toMatch(/export const SPIN_RAKE_RATE = 0\.08;/);
    expect(spec).not.toMatch(/SPIN_RAKE_BANDS/);
    expect(spec).toMatch(/assertSpinRakeInvariant/);
    expect(spec).toMatch(/E\[multiplier\] = seats × \(1 − rake_rate\)/);
  });
});

describe('the constraint refuses the next one', () => {
  it('exists, and is keyed on buy_in_fee', () => {
    expect(migration).toMatch(/ADD CONSTRAINT tournaments_spin_no_extra_rake/);
    expect(migration).toMatch(/COALESCE\(buy_in_fee, 0\) = 0/);
  });

  it('catches a spin identified by EITHER column', () => {
    // src/utils/spinReveal.ts checks variant AND tournament_type on purpose;
    // the union-reserve audit records that reading only one "is how it quietly
    // returns false for half the Spins in the system".
    expect(migration).toMatch(/variant IS DISTINCT FROM 'spin'/);
    expect(migration).toMatch(/upper\(coalesce\(tournament_type, ''\)\) <> 'SPIN'/);
  });

  it('is NOT VALID, so the 7,120 historical rows are left as they are', () => {
    const stmt = migration.slice(
      migration.indexOf('ADD CONSTRAINT tournaments_spin_no_extra_rake'),
      migration.indexOf(';', migration.indexOf('ADD CONSTRAINT tournaments_spin_no_extra_rake'))
    );
    expect(stmt).toMatch(/NOT VALID/);
    // VALIDATE would scan and fail on history, turning a guard into an outage.
    expect(migration).not.toMatch(/VALIDATE CONSTRAINT tournaments_spin_no_extra_rake/);
  });

  it('refuses to install itself if the writer is still creating fee-bearing spins', () => {
    // A constraint today's writers would immediately violate is a broken
    // deploy, not a guard.
    expect(migration).toMatch(/created_at > now\(\) - interval '24 hours'/);
    expect(migration).toMatch(/fix the writer before adding the constraint/);
  });
});

describe('the alarm can see what the backstop refuses to touch', () => {
  const view = migration.slice(
    migration.indexOf('CREATE VIEW public.v_spin_reserve_health AS'),
    migration.indexOf('COMMENT ON VIEW')
  );

  it('publishes fee_violations_24h', () => {
    expect(view).toMatch(/AS fee_violations_24h/);
    expect(view).toMatch(/COALESCE\(t\.buy_in_fee, 0::numeric\) <> 0::numeric/);
  });

  it('keeps unbooked_24h excluding fee-bearing spins, deliberately', () => {
    // The exclusion is correct - settling a game against economics it does not
    // match would be worse than leaving it. What was wrong was that the
    // exclusion was SILENT. Both conditions must be present: one counter that
    // skips them, one that counts them.
    expect(view).toMatch(
      /COALESCE\(t\.buy_in_fee, 0::numeric\) = 0::numeric[\s\S]*AS unbooked_24h/
    );
  });

  it('keeps every column the deployed cron already selects', () => {
    for (const col of [
      'club_id',
      'club_name',
      'balance',
      'highest_stake',
      'can_draw_100x',
      'is_thin',
      'shortfall_events',
      'unbooked_24h',
      'null_multiplier_24h',
    ]) {
      expect(view, `v_spin_reserve_health would lose ${col}`).toContain(col);
    }
  });

  it('does not resurrect the retired 500x columns', () => {
    for (const col of ['top_jackpot', 'need_for_500x', 'can_draw_500x']) {
      expect(view).not.toContain(col);
    }
  });

  it('does not become client-readable by being recreated', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON public\.v_spin_reserve_health FROM anon, authenticated/
    );
    expect(migration).toMatch(/GRANT SELECT ON public\.v_spin_reserve_health TO service_role/);
  });

  it('asserts its own outcome rather than trusting the apply', () => {
    expect(migration).toMatch(/fee_violations_24h was not added/);
    expect(migration).toMatch(/which \/api\/cron\/spin-sweep selects/);
  });
});
