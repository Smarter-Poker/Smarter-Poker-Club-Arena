/**
 * A SETTLED SATELLITE DOES NOT NEED ITS WATCHDOG SPAM KEPT OPEN (2026-09-23).
 *
 * Production Alerts board id=8, MoneyAlertsGoingUnread. PRs #5145 (CLASS 5)
 * and #5146 (CLASS 6) deliberately left Satellite.stuck_completing_unawarded
 * open, calling it "a different failure shape". This pins that follow-up,
 * CLASS 7.
 *
 * Read live before this fix: all 533 unresolved rows for this source name
 * only 9 distinct tournament_id values, every occurrence dated 2026-09-08
 * (the discovery-watchdog re-firing on the same 9 stuck satellites roughly
 * once a minute for eleven hours before its own cause was fixed). All 9
 * tournaments are proven settled: tournaments.status = 'COMPLETED',
 * tournament_escrow.closed_at set (2026-09-09), prize_balance = 0.00,
 * prize_out > 0 (95% of gross_in, the cash-value fallback - 0 rows in
 * tournament_satellite_awards for any of the 9). A sibling resolved alert row
 * for the same source names the settling migration
 * (a_finished_satellite_must_be_able_to_settle) and explicitly corrects this
 * alert's own context fields as wrong at the time it fired.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATION_PATH =
  '../supabase/migrations/20260923211500_a_settled_satellite_does_not_need_its_watchdog_spam_kept_open.sql';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const SQL = read(MIGRATION_PATH);

const classSevenBlock = () => {
  const match = SQL.match(
    /CLASS 7:[\s\S]*?v_stuck := COALESCE\(array_length\(v_stuck_ids, 1\), 0\);/
  );
  expect(match, 'CLASS 7 block not found in migration').toBeTruthy();
  return match![0];
};

describe('CLASS 7: a stuck-completing satellite alert resolves once its tournament escrow proves it was disbursed', () => {
  it('extends the existing resolver rather than creating a new function, cron, or table', () => {
    expect(SQL).toContain(
      "to_regprocedure('public.fn_resolve_settled_financial_alerts(boolean,integer)')"
    );
    expect(SQL).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_resolve_settled_financial_alerts(p_apply boolean DEFAULT false, p_limit integer DEFAULT 5000)'
    );
    expect(SQL).not.toMatch(/cron\.schedule/i);
    expect(SQL).not.toMatch(/CREATE\s+TABLE/i);
  });

  it('covers exactly Satellite.stuck_completing_unawarded, and only that source', () => {
    const block = classSevenBlock();
    expect(block).toContain("a.source = 'Satellite.stuck_completing_unawarded'");
    // The sibling satellite sources CLASS 6 already closed, and the
    // still-genuinely-different seat_origin/seat_outcome sources, stay untouched.
    expect(block).not.toContain('Tournament.atomic_satellite_finish_refused');
    expect(block).not.toContain('Satellite.seat_origin_unknown');
    expect(block).not.toContain('Satellite.seat_outcome_unconfirmed');
  });

  it('proves settlement from tournament_escrow being closed at zero with a real payout, not from tournament status or elapsed time', () => {
    const block = classSevenBlock();

    expect(block).toContain("a.context->>'tournament_id' IS NOT NULL");
    expect(block).toContain('JOIN public.tournament_escrow e ON');
    expect(block).toContain("e.tournament_id = (a.context->>'tournament_id')::uuid");
    expect(block).toContain('e.closed_at IS NOT NULL');
    expect(block).toContain('e.prize_balance = 0');
    expect(block).toContain(
      "(COALESCE(e.prize_out, 0) + COALESCE(e.refund_prize, 0)) > 0"
    );

    // Must not key off tournaments.status or elapsed time.
    expect(block).not.toMatch(/tournaments\.status/);
    expect(block).not.toMatch(/created_at\s*[<>]/);
  });

  it('restates CLASS 1 through 6 unmodified, so the migration is correct standalone regardless of merge order with PR #5146', () => {
    expect(SQL).toContain("a.source = 'fn_payout_guarantee_check'");
    expect(SQL).toContain("a.source = 'fn_tournament_payout_reconcile'");
    expect(SQL).toContain("a.source = 'ServerTableEngine.post_commit_obligations_pending'");
    expect(SQL).toContain(
      "a.source IN ('postHandTasks.hand_history_failed',\n                        'ServerTableEngine.authoritative_hand_semantic_refusal')"
    );
    expect(SQL).toContain(
      "a.source IN ('Tournament.atomic_finish_refused', 'Tournament.atomic_finish_outcome_unknown')"
    );
    expect(SQL).toContain(
      "a.source IN ('Tournament.atomic_satellite_finish_refused',\n                        'Tournament.atomic_satellite_finish_outcome_unknown')"
    );
  });

  it('only writes resolved rows when p_apply is true, and stamps a resolution carrying the escrow proof', () => {
    expect(SQL).toContain('IF p_apply THEN');
    const applyMatch = SQL.match(
      /UPDATE public\.financial_alerts a\s+SET resolved = true,\s+resolved_at = now\(\),\s+context = COALESCE\(a\.context, '\{\}'::jsonb\) \|\| jsonb_build_object\(\s+'resolution', 'this tournament''s escrow[\s\S]*?WHERE a\.id = ANY\(v_stuck_ids\);/
    );
    expect(applyMatch, 'CLASS 7 UPDATE block not found').toBeTruthy();
    expect(applyMatch![0]).toContain("'resolved_by_fn', 'fn_resolve_settled_financial_alerts'");
    expect(applyMatch![0]).toContain("'escrow_proof'");
  });

  it('reports stuck_completing_settled and folds it into the total, without disturbing the other six classes', () => {
    expect(SQL).toContain("'stuck_completing_settled', v_stuck");
    expect(SQL).toContain(
      'v_paid + v_overpaid + v_settled + v_released + v_finish + v_sat + v_stuck'
    );
  });

  it('restates the browser-exposure lock this SECURITY DEFINER function has carried since 20260903060000', () => {
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean, integer) FROM PUBLIC, anon, authenticated;'
    );
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean, integer) TO service_role;'
    );
  });

  it('asserts CLASS 7 landed, in the same migration, before the transaction can commit silently wrong', () => {
    expect(SQL).toContain("v_result ? 'stuck_completing_settled'");
    expect(SQL).toContain('RAISE EXCEPTION');
  });
});
