/**
 * A SATELLITE THAT DELIVERED ITS SEAT OR WAS CASH SETTLED STOPS PAGING THE
 * FINISH REFUSAL (2026-09-23).
 *
 * Production Alerts board id=8, MoneyAlertsGoingUnread. The prior migration
 * (20260923184855, PR #5145) added CLASS 5 for the two non-satellite
 * finish-refusal sources and deliberately left the satellite sources
 * untouched pending a check of the satellite award path on its own terms.
 * This pins that follow-up, CLASS 6.
 *
 * Read live before this fix: Tournament.atomic_satellite_finish_refused (469
 * unresolved rows, 39 distinct tournament/winner pairs) and its sibling
 * Tournament.atomic_satellite_finish_outcome_unknown (8 rows) are each fully
 * covered, per row, by one of two proofs - tournament_satellite_awards
 * carries the delivered seat/ticket (467 + 8 of 477), or an identical
 * (source, tournament_id, winner_id) alert is already resolved=true because
 * the satellite was terminal-settled as CASH when it had no exact target club
 * (2 of 477, e.g. satellite 9fee70de-c692-48fb-a423-98d730ab02bc, resolved
 * 2026-09-10 via fn_settle_satellite_finish_atomic, migration
 * 20260910023919). Neither the tournament's own status nor elapsed time is
 * accepted as proof.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATION_PATH =
  '../supabase/migrations/20260923195015_a_satellite_that_delivered_its_seat_or_was_cash_settled_stop.sql';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const SQL = read(MIGRATION_PATH);

const classSixBlock = () => {
  const match = SQL.match(
    /CLASS 6:[\s\S]*?v_sat := COALESCE\(array_length\(v_sat_ids, 1\), 0\);/
  );
  expect(match, 'CLASS 6 block not found in migration').toBeTruthy();
  return match![0];
};

describe('CLASS 6: a satellite finish refusal resolves once the delivered seat or cash settlement is proven', () => {
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

  it('covers exactly the two satellite finish-refusal sources, and only those', () => {
    const block = classSixBlock();
    expect(block).toContain(
      "a.source IN ('Tournament.atomic_satellite_finish_refused',\n                        'Tournament.atomic_satellite_finish_outcome_unknown')"
    );
    // The unresolved, different-shaped satellite failure sources stay untouched.
    expect(block).not.toContain('Satellite.seat_origin_unknown');
    expect(block).not.toContain('Satellite.seat_outcome_unconfirmed');
    expect(block).not.toContain('Satellite.stuck_completing_unawarded');
  });

  it('proves settlement from tournament_satellite_awards OR a resolved identical sibling alert, keyed on this alert\'s own tournament_id and winner_id', () => {
    const block = classSixBlock();

    expect(block).toContain("a.context->>'tournament_id' IS NOT NULL");
    expect(block).toContain("a.context->>'winner_id' IS NOT NULL");

    // Proof (a): the delivered seat/ticket.
    expect(block).toContain('FROM public.tournament_satellite_awards sa');
    expect(block).toContain("sa.tournament_id = (a.context->>'tournament_id')::uuid");
    expect(block).toContain("sa.user_id       = (a.context->>'winner_id')::uuid");

    // Proof (b): an identical alert already resolved (e.g. the cash-settlement path).
    expect(block).toContain('FROM public.financial_alerts sib');
    expect(block).toContain('sib.resolved = true');
    expect(block).toContain('sib.source = a.source');
    expect(block).toContain("sib.context->>'tournament_id' = a.context->>'tournament_id'");
    expect(block).toContain("sib.context->>'winner_id'      = a.context->>'winner_id'");
    expect(block).toContain('sib.id <> a.id');

    // Must not key off tournaments.status or elapsed time - neither is
    // independent of the manager's own retries (see migration header).
    expect(block).not.toMatch(/tournaments\.status/);
    expect(block).not.toMatch(/created_at\s*[<>]/);
  });

  it('restates CLASS 1 through 5 unmodified, so the migration is correct standalone regardless of merge order with PR #5145', () => {
    expect(SQL).toContain("a.source = 'fn_payout_guarantee_check'");
    expect(SQL).toContain("a.source = 'fn_tournament_payout_reconcile'");
    expect(SQL).toContain("a.source = 'ServerTableEngine.post_commit_obligations_pending'");
    expect(SQL).toContain(
      "a.source IN ('postHandTasks.hand_history_failed',\n                        'ServerTableEngine.authoritative_hand_semantic_refusal')"
    );
    expect(SQL).toContain(
      "a.source IN ('Tournament.atomic_finish_refused', 'Tournament.atomic_finish_outcome_unknown')"
    );
  });

  it('only writes resolved rows when p_apply is true, and stamps a resolution that names the mechanism', () => {
    expect(SQL).toContain('IF p_apply THEN');
    const applyMatch = SQL.match(
      /UPDATE public\.financial_alerts a\s+SET resolved = true,\s+resolved_at = now\(\),\s+context = COALESCE\(a\.context, '\{\}'::jsonb\) \|\| jsonb_build_object\(\s+'resolution', 'the named winner''s satellite outcome[\s\S]*?WHERE a\.id = ANY\(v_sat_ids\);/
    );
    expect(applyMatch, 'CLASS 6 UPDATE block not found').toBeTruthy();
    expect(applyMatch![0]).toContain("'resolved_by_fn', 'fn_resolve_settled_financial_alerts'");
  });

  it('reports satellite_finish_settled and folds it into the total, without disturbing the other five classes', () => {
    expect(SQL).toContain("'satellite_finish_settled', v_sat");
    expect(SQL).toContain('v_paid + v_overpaid + v_settled + v_released + v_finish + v_sat');
  });

  it('restates the browser-exposure lock this SECURITY DEFINER function has carried since 20260903060000', () => {
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean, integer) FROM PUBLIC, anon, authenticated;'
    );
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean, integer) TO service_role;'
    );
  });

  it('asserts CLASS 6 landed, in the same migration, before the transaction can commit silently wrong', () => {
    expect(SQL).toContain("v_result ? 'satellite_finish_settled'");
    expect(SQL).toContain('RAISE EXCEPTION');
  });
});
