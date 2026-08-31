/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE MONEY GUARDS THAT WERE SHIPPED FORWARD-ONLY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Sibling of `money-rules-live-in-the-database` and pinned the same way: CI has
 * no database, so these assert on migration source. Each rule below was proved
 * against production read-only on 2026-08-31 and the measurements are quoted in
 * the migration headers. What these CAN prove is that nobody quietly removes a
 * guard, widens a bound, or re-adds a coercion.
 *
 * The shape of every one of these defects was the same: a derived money column
 * with several independent writers and nothing asserting they agree. That is
 * what buy_in_fee turned out to be, 9,357 rows late.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const RATES = read(
  'supabase/migrations/20260901100000_a_commission_rate_is_a_fraction_and_two_writers_must_agree.sql'
);
const POOL = read('supabase/migrations/20260901100100_a_bonus_pool_has_one_floor_and_it_is_zero.sql');
const TOURN = read(
  'supabase/migrations/20260901100200_the_tournament_pools_get_a_floor_and_an_alarm.sql'
);
const BOUNTY = read(
  'supabase/migrations/20260901100300_a_bounty_pool_pays_out_what_it_collected.sql'
);
const ROSTER = read(
  'supabase/migrations/20260901100400_the_roster_reads_the_real_lifetime_rake.sql'
);
const RAKE_ALARM_FIX = read(
  'supabase/migrations/20260831141042_the_reconcile_log_admits_a_rake_law_finding.sql'
);
const CLUBS_SERVICE = read('src/services/ClubsService.ts');

describe('a commission rate is a fraction', () => {
  /** The columns proved to be fraction-scaled and inside [0,1] on 2026-08-31. */
  const BOUNDED = [
    ['agents', 'commission_rate'],
    ['agents', 'player_rakeback_rate'],
    ['agents', 'rakeback_percentage'],
    ['agent_commissions', 'commission_rate'],
    ['club_members', 'commission_rate'],
    ['club_members', 'rakeback_rate'],
    ['club_members', 'player_rakeback_pct'],
    ['rakeback_periods', 'rakeback_rate'],
    ['clubs', 'club_commission_rate'],
    ['union_clubs', 'club_commission_rate'],
  ];

  it.each(BOUNDED)('bounds %s.%s to [0,1]', (tbl, col) => {
    expect(RATES).toContain(`('${tbl}',`);
    expect(RATES).toContain(`'${col}'`);
    // The constraint name is derived, so pin the derivation as well as the pair.
    expect(RATES).toContain(`${tbl}_${col}_is_a_fraction`);
  });

  it('adds the constraint NOT VALID and then validates it', () => {
    // A validated constraint that was never proved against live rows is how a
    // guard becomes an outage. The DO block counts violators first and raises.
    expect(RATES).toContain('NOT VALID');
    expect(RATES).toContain('VALIDATE CONSTRAINT');
    expect(RATES).toContain('IS NOT NULL AND (%I < 0 OR %I > 1)');
  });

  it('does NOT bound the columns that are genuinely percent-scaled', () => {
    /**
     * rakeback_period_payouts.rakeback_pct holds 5.00 .. 20.00 on all 1,014
     * live rows. Bounding it to 1 would have refused every rakeback payout.
     * The name says _pct on both scales; only the data says which.
     */
    expect(RATES).not.toContain("('rakeback_period_payouts',");
    expect(RATES).not.toContain("('sub_agents',");
    expect(RATES).not.toContain("('commission_records',");
    expect(RATES).toContain('rakeback_period_payouts.rakeback_pct');
    expect(RATES).toContain('NOT CONSTRAINED');
  });

  it('removes the >1-means-percent coercion instead of keeping it as a net', () => {
    expect(RATES).toContain('v_cur_rate / 100.0');            // the text it replaces
    expect(RATES).toContain('v_rate := COALESCE(v_cur_rate, 0);');
    expect(RATES).toContain('the percent coercion survived the rewrite');
  });

  it('makes both writers round money to two places', () => {
    expect(RATES).toContain('ROUND(v_remaining * v_rate, 2)');
    expect(RATES).toContain('the 4dp rounding survived the rewrite');
    // and the live writer must not have drifted off 2dp underneath us
    expect(RATES).toContain('ROUND(p_rake_credit * COALESCE(v_commission_rate, 0), 2)');
  });

  it('refuses to rewrite a function it did not read', () => {
    expect(RATES).toContain('exactly once');
    expect(RATES).toContain('Re-read it before rewriting');
  });
});

describe('a bonus pool has one floor, and it is zero', () => {
  it('drops the overdraft floor and keeps the zero floor', () => {
    expect(POOL).toContain('DROP CONSTRAINT IF EXISTS spin_bonus_pools_balance_check');
    expect(POOL).toContain('spin_bonus_pools_balance_non_negative');
    expect(POOL).toContain('the -500 overdraft CHECK is still attached');
  });

  it('stops spin_pool_draw computing a draw the table will refuse', () => {
    /**
     * The contradiction only bit through this function: it drew down to -500
     * and the 0 floor raised 23514 out of it, aborting the caller. Clamping at
     * the balance keeps its existing "return 0, never raise" contract.
     */
    expect(POOL).toContain('v_floor       numeric := 0;');
    expect(POOL).toContain('LEAST(p_amount, v_balance - v_floor)');
    expect(POOL).toContain('spin_pool_draw still carries the -500 overdraft');
  });

  it('keeps the draw out of every browser role', () => {
    expect(POOL).toContain(
      'REVOKE ALL ON FUNCTION public.spin_pool_draw(uuid, numeric) FROM PUBLIC, anon, authenticated'
    );
  });
});

describe('the tournament pools get a floor and an alarm', () => {
  it('blocks a negative pool on all four money columns', () => {
    expect(TOURN).toContain('tournaments_pools_are_not_negative');
    for (const col of ['prize_pool', 'total_rake', 'bounty_pool', 'bounty_pool_paid']) {
      expect(TOURN).toContain(`COALESCE(${col},0)`);
    }
    expect(TOURN).toContain('VALIDATE CONSTRAINT tournaments_pools_are_not_negative');
  });

  it('widens the reconcile log vocabulary in the migration that needs it', () => {
    /**
     * An alarm that files an unlisted entity_type raises 23514 instead of
     * filing - the same defect that stopped fn_rake_law_check's
     * board_not_recorded branch. Widen first, file second.
     */
    expect(TOURN).toContain("'tournament_pool_law','bounty_pool_law'");
    expect(TOURN).toContain('ledger_reconcile_log_entity_type_check');
    // and every pre-existing member of the vocabulary must survive the rewrite
    for (const kind of [
      'player_wallet',
      'club_treasury',
      'agent_wallet',
      'frozen_wallets_pool',
      'chip_circulation',
      'seat_stack_exit',
      'cashout_escrow_stuck',
      'negative_balance',
      'over_claimed_send',
      'insurance_bank',
      'insurance_offer_unresolved',
      'bomb_award_ledger_gap',
      'rake_law',
    ]) {
      expect(TOURN).toContain(`'${kind}'`);
    }
  });

  it('is forward-only and says where the line is', () => {
    expect(TOURN).toContain("TIMESTAMPTZ '2026-09-01 00:00:00+00'");
    expect(TOURN).toContain('FORWARD ONLY');
  });

  it('carves out every case where the identity is genuinely ambiguous', () => {
    // Rebuys and add-ons add chips; a guarantee tops the pool up; a Spin is
    // priced on a multiplier; a satellite pays seats. A guard that screamed at
    // any of those would be worse than no guard.
    expect(TOURN).toContain('COALESCE(t.is_rebuy, false)          = false');
    expect(TOURN).toContain('COALESCE(t.add_on_available, false)  = false');
    expect(TOURN).toContain('COALESCE(t.guaranteed_prize, 0)      = 0');
    expect(TOURN).toContain("lower(COALESCE(t.variant,''))       <> 'spin'");
    expect(TOURN).toContain('t.satellite_target    IS NULL');
    expect(TOURN).toContain("t.status = 'COMPLETED'");
  });

  it('is an alarm, not a trigger, and states why', () => {
    /**
     * The shipped tournament guard is BEFORE INSERT only because "a guard that
     * can refuse an update is a guard that can strand a running tournament".
     * prize_pool is only ever written by UPDATE, so the blocking form would
     * have to be exactly the thing that guard refuses to be.
     */
    expect(TOURN).toContain('is BEFORE INSERT only');
    expect(TOURN).toContain('strand a running tournament');
    expect(TOURN).not.toContain('CREATE TRIGGER');
    expect(TOURN).toContain('fn_tournament_pool_law_check');
  });

  it('files a finding at most once per tournament per kind', () => {
    expect(TOURN).toContain("l.entity_type = 'tournament_pool_law'");
    expect(TOURN).toContain("l.metadata->>'kind' = v.kind");
  });
});

describe('a bounty pool pays out what it collected', () => {
  it('asserts the equality on both funded exits of settlement', () => {
    expect(BOUNTY).toContain('fn_bounty_pool_law_assert');
    expect(BOUNTY).toContain('does not call the assertion on both funded exits');
  });

  it('records instead of raising, because it runs inside settlement', () => {
    /**
     * A RAISE here aborts the settling transaction and leaves the champion
     * unpaid over a reporting disagreement about money that already moved.
     */
    expect(BOUNTY).toContain('Never raises');
    expect(BOUNTY).not.toContain('RAISE EXCEPTION USING ERRCODE');
  });

  it('leaves the settlement legs it wrapped completely alone', () => {
    expect(BOUNTY).toContain('the residual payment leg did not survive the rewrite');
    expect(BOUNTY).toContain('the ledger read did not survive the rewrite');
  });

  it('backfills nothing and states the historical numbers instead', () => {
    expect(BOUNTY).toContain('NO BACKFILL');
    expect(BOUNTY).toContain('1,730.16');
    expect(BOUNTY).toContain('150.40');
    expect(BOUNTY).not.toMatch(/UPDATE\s+public\.tournaments\s+SET\s+bounty_pool/i);
  });

  it('sweeps forward only', () => {
    expect(BOUNTY).toContain("TIMESTAMPTZ '2026-09-01 00:00:00+00'");
  });
});

describe('the roster reads the real lifetime rake', () => {
  it('adds a read-only RPC over the rollup, not over the mirror', () => {
    expect(ROSTER).toContain('fn_club_member_lifetime_rake');
    expect(ROSTER).toContain('public.club_rake_daily_user');
    expect(ROSTER).toContain('STABLE');
  });

  it('does not trust its own argument', () => {
    // A definer function that answers for any club id is how a member once
    // rewrote a club's member_count.
    expect(ROSTER).toContain('auth.uid()');
    expect(ROSTER).toContain('FROM PUBLIC, anon');
    expect(ROSTER).toContain('TO authenticated, service_role');
  });

  it('moves no chips - the mirror is documented, not backfilled', () => {
    expect(ROSTER).toContain('ABANDONED MIRROR - DO NOT READ');
    expect(ROSTER).not.toMatch(/UPDATE\s+public\.club_members\s+SET/i);
  });

  it('leaves no reader of the abandoned column in ClubsService', () => {
    // The three selects that used to pull it are the point of the change.
    expect(CLUBS_SERVICE).not.toContain('chips_lost, total_rake_paid');
    expect(CLUBS_SERVICE).toContain('attachLifetimeRake');
    expect(CLUBS_SERVICE).toContain('fn_club_member_lifetime_rake');
  });

  it('degrades to zero rather than taking the member list down', () => {
    expect(CLUBS_SERVICE).toContain('Lifetime rake enrichment failed');
  });
});

describe('the rake alarm can actually file its quietest finding', () => {
  /**
   * fn_rake_law_check inserted severity 'warning' for board_not_recorded, and
   * ledger_reconcile_log_severity_check allows only ok/warn/critical - so that
   * branch raised 23514 instead of filing. One word.
   *
   * This was already corrected by 20260831141042 and production carries 'warn'
   * (verified read-only 2026-08-31). Pinned here so it cannot regress: the
   * whole point of the alarm is the finding nobody is watching.
   */
  it('files board_not_recorded at warn, a severity the log admits', () => {
    expect(RAKE_ALARM_FIX).toContain(
      "CASE WHEN v.kind = 'board_not_recorded' THEN 'warn' ELSE 'critical' END"
    );
    expect(RAKE_ALARM_FIX).not.toContain("THEN 'warning'");
  });

  it('records why, so the next author does not reinvent the vocabulary', () => {
    expect(RAKE_ALARM_FIX).toContain("('ok','warn','critical')");
  });
});
