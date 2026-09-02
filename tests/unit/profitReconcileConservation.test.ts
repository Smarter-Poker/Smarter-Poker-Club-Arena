/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A CLUB'S PLAYERS CANNOT FINISH THE DAY UP WHILE PAYING RAKE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * club_member_daily_stats.profit drifts because the live trigger only counts a
 * stack delta when an "attributable" heuristic passes, and drops the row when
 * it does not. A rebuy looks like a gain, so the dropped rows skew toward
 * losses and the total drifts positive.
 *
 * The repair that was already built reads an "exact" ledger out of
 * player_stats_snapshots. Measured 2026-08-26, that ledger is NOT exact:
 * total_winnings is accumulated by an AFTER INSERT trigger on hand_history,
 * but total_losses is accumulated by promo_apply_playthrough -- a PROMO
 * function -- so losses are only as complete as the engine's calls to it.
 *
 *   (d_losses - d_winnings) / house_cut  should be exactly 1.0:
 *     2026-08-19 Midway   0.929     2026-08-23 Midway  -1.346
 *     2026-08-20 Midway   1.208     2026-08-24 Midway  -2.723
 *     2026-08-21 Midway   0.876     2026-08-25 Midway   0.916
 *     2026-08-22 Midway  -0.572
 *
 * A negative ratio is not imprecision, it is impossible. Reconciling 2026-08-21
 * from that basis would have moved the drift from 4,135.03 to 17,572.31, i.e.
 * further from zero, while reporting success.
 *
 * So the reconciler now has to prove chip conservation before it writes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const GUARD = read('supabase/migrations/20260826030000_profit_reconcile_must_conserve_chips.sql');

describe('The reconciler proves the number before it writes it', () => {
  it('checks SUM(profit) + rake + bbj against zero', () => {
    expect(GUARD).toContain('fn_club_profit_conservation');
    expect(GUARD).toContain("'conserves'");
    expect(GUARD).toContain('rake + bbj');
  });

  it('only writes a club whose basis conserves', () => {
    expect(GUARD).toMatch(/IF\s*\(v_check\s*->>\s*'conserves'\)::boolean\s*THEN/);
  });

  it('leaves the live estimate alone when it does not, rather than guessing', () => {
    expect(GUARD).toContain('fails_chip_conservation');
    expect(GUARD).toContain('v_skipped := v_skipped + 1');
  });

  it('refuses a club-day with no house cut to check against', () => {
    // With no rake row there is no invariant to test, so there is no evidence
    // the exact figure is right. Absence of evidence is not a pass.
    expect(GUARD).toContain('no_house_cut_row');
    expect(GUARD).toContain('has_house_row');
  });
});

describe('It decides per club, not per day', () => {
  it('loops clubs and checks each one separately', () => {
    // Club JAQK and SHARK CLUB reconcile to ~0.01% of the house cut while
    // Midway Union does not. A day-wide veto would throw away good repairs
    // because a different club on the same date is broken.
    expect(GUARD).toContain('FOR v_club IN');
    expect(GUARD).toContain('SELECT DISTINCT club_id FROM club_member_daily_stats');
    expect(GUARD).toContain('clubs_applied');
    expect(GUARD).toContain('clubs_skipped');
  });
});

describe('The guards that were already right are kept', () => {
  it('never touches a day that is still running', () => {
    expect(GUARD).toContain('day_not_complete');
    expect(GUARD).toContain('p_date >= CURRENT_DATE');
  });

  it('never touches a day before the ledger cutover', () => {
    // Earlier snapshots were backfilled from RAKED hands only and carry that
    // partial basis; reconciling across them moves one approximation onto
    // another.
    expect(GUARD).toContain('before_exact_ledger_cutover');
    expect(GUARD).toContain("DATE '2026-08-20'");
  });

  it('needs a snapshot on both sides of the day', () => {
    expect(GUARD).toContain('missing_boundary_snapshot');
  });

  it('recomputes rather than accumulating, so a second run is a no-op', () => {
    // SET profit = <computed>, never profit = profit + <computed>.
    expect(GUARD).toMatch(/SET profit = f\.share/);
    expect(GUARD).not.toMatch(/SET\s+profit\s*=\s*s\.profit\s*\+/);
  });
});

describe('Every decision is recorded', () => {
  it('logs the numbers behind each skip, not just the fact of it', () => {
    expect(GUARD).toContain('club_profit_reconcile_log');
    for (const col of ['exact_profit_sum', 'house_cut', 'exact_drift', 'tolerance', 'reason']) {
      expect(GUARD).toContain(col);
    }
  });

  it('names the engine-side defect it is deliberately NOT hiding', () => {
    expect(GUARD).toContain('promo_apply_playthrough');
    expect(GUARD).toContain('STILL OPEN');
  });

  it('carries a ROLLBACK section', () => {
    expect(GUARD).toContain('ROLLBACK');
  });
});
