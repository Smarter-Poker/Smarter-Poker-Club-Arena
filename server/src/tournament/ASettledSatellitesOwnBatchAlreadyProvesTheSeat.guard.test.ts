/**
 * A SETTLED SATELLITE'S OWN BATCH ALREADY PROVES THE SEAT (2026-09-24).
 *
 * Production Alerts board id=8, MoneyAlertsGoingUnread. A sibling row of this
 * exact source (3ed87bba) was already resolved by hand, naming the
 * 2026-09-09 22-satellite settlement and stating plainly that this alert's
 * own "permission denied" / "FOUR TABLE LIMIT" / "deadlock detected" context
 * is what a pre-fix transient failure looked like, not what actually
 * happened. This pins the fix that closes the remaining 5 rows of the same
 * settlement nobody individually marked resolved.
 *
 * Read live before this fix: all 5 named source tournaments
 * (fe8dc50c, ed78a8ac, 024d0796, 903e9d3c, 54832de2) already carry a settled
 * tournament_satellite_settlement_batches row (settled_at 2026-09-09
 * 06:14:28-37 UTC). Cross-checked against chip_ledger: three winners were
 * credited exactly their ticket_value (20.00 or 200.00) as a
 * 'tournament_prize' at that same timestamp via a paid
 * tournament_obligations row; the fourth (a619dd26) was delivered a real
 * seat - tournament_players id bb1abd4e, status eliminated, position 39, in
 * the named target tournament.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATION_PATH =
  '../supabase/migrations/20260924012500_a_settled_satellites_own_batch_already_proves_the_seat.sql';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const SQL = read(MIGRATION_PATH);

const classFiveBlock = () => {
  const match = SQL.match(
    /CLASS 5:[\s\S]*?v_seat_outcome := COALESCE\(array_length\(v_seat_ids, 1\), 0\);/
  );
  expect(match, 'CLASS 5 block not found in migration').toBeTruthy();
  return match![0];
};

describe("CLASS 5: a satellite seat-outcome alert resolves once its named tournament's own settlement batch proves delivery", () => {
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

  it('covers exactly Satellite.seat_outcome_unconfirmed, and never seat_origin_unknown', () => {
    const block = classFiveBlock();
    expect(block).toContain("a.source = 'Satellite.seat_outcome_unconfirmed'");
    expect(block).not.toContain('Satellite.seat_origin_unknown');
    expect(block).not.toContain('Satellite.stuck_completing_unawarded');
  });

  it("proves delivery from the settlement batch's own settled_at, not from tournament status or elapsed time", () => {
    const block = classFiveBlock();

    expect(block).toContain("a.context->>'tournament_id' IS NOT NULL");
    expect(block).toContain('JOIN public.tournament_satellite_settlement_batches b');
    expect(block).toContain("b.tournament_id = (a.context->>'tournament_id')::uuid");
    expect(block).toContain('b.settled_at IS NOT NULL');

    expect(block).not.toMatch(/tournaments\.status/);
    expect(block).not.toMatch(/created_at\s*[<>]/);
  });

  it('restates CLASS 1 through 4 unmodified, so the migration is correct standalone regardless of merge order with any sibling resolver PR', () => {
    expect(SQL).toContain("a.source = 'fn_payout_guarantee_check'");
    expect(SQL).toContain("a.source = 'fn_tournament_payout_reconcile'");
    expect(SQL).toContain("a.source = 'ServerTableEngine.post_commit_obligations_pending'");
    expect(SQL).toContain(
      "a.source IN ('postHandTasks.hand_history_failed',\n                        'ServerTableEngine.authoritative_hand_semantic_refusal')"
    );
  });

  it('only writes resolved rows when p_apply is true, and stamps a resolution carrying the batch proof', () => {
    expect(SQL).toContain('IF p_apply THEN');
    const applyMatch = SQL.match(
      /UPDATE public\.financial_alerts a\s+SET resolved = true,\s+resolved_at = now\(\),\s+resolution = 'The named satellite tournament[\s\S]*?WHERE a\.id = ANY\(v_seat_ids\);/
    );
    expect(applyMatch, 'CLASS 5 UPDATE block not found').toBeTruthy();
    expect(applyMatch![0]).toContain("'resolved_by_fn', 'fn_resolve_settled_financial_alerts'");
    expect(applyMatch![0]).toContain("'batch_outcomes'");
  });

  it('reports satellite_seat_outcome_settled and folds it into the total, without disturbing the other four classes', () => {
    expect(SQL).toContain("'satellite_seat_outcome_settled', v_seat_outcome");
    expect(SQL).toContain('v_paid + v_overpaid + v_settled + v_released + v_seat_outcome');
  });

  it('restates the browser-exposure lock this SECURITY DEFINER function has carried since 20260903060000', () => {
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean, integer) FROM PUBLIC, anon, authenticated;'
    );
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean, integer) TO service_role;'
    );
  });

  it('asserts CLASS 5 landed, in the same migration, before the transaction can commit silently wrong', () => {
    expect(SQL).toContain("v_result ? 'satellite_seat_outcome_settled'");
    expect(SQL).toContain('RAISE EXCEPTION');
  });
});
