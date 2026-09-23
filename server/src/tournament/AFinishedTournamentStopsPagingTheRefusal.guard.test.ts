/**
 * A TOURNAMENT THAT FINISHED STOPS PAGING THE FINISH REFUSAL (2026-09-23).
 *
 * Production Alerts board id=8, MoneyAlertsGoingUnread: financial_alerts had
 * 46,366 unresolved critical rows, and the single largest source -
 * Tournament.atomic_finish_refused - accounted for 15,426 of them (33%) across
 * only 1,003 distinct tournaments. Read live before this fix: for every one of
 * those 1,003 tournaments (and 30 of 35 behind the outcome_unknown sibling), a
 * wallet_transactions row already credits the exact winner_id named in the
 * alert's own context, for that exact tournament_id, type=credit
 * category=prize. The manager's own retry (finishRetryDelayMs backoff in
 * TournamentManagerEliminations.ts, around line 5230-5335) landed; nothing
 * ever went back to close the alert rows the failed attempts left behind.
 *
 * fn_resolve_settled_financial_alerts already runs on cron
 * (ca-resolve-settled-alerts-20m, every 20 minutes) and already proves CLASS 1
 * exactly this way for fn_payout_guarantee_check's earner_not_paid alert. This
 * pins that the same proof was extended to the finish-refusal sources as
 * CLASS 5, not routed through a new sweep, new cron, or a compensating write -
 * per CLAUDE.md 10.11/10.12, the fix is in the existing resolver's own logic.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATION_PATH =
  '../supabase/migrations/20260923184855_a_tournament_that_finished_stops_paging_the_finish_refusal.sql';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const SQL = read(MIGRATION_PATH);

describe('CLASS 5: a tournament finish refusal resolves once the named winner is proven paid', () => {
  it('extends the existing resolver rather than creating a new function or sweep', () => {
    expect(SQL).toContain(
      "to_regprocedure('public.fn_resolve_settled_financial_alerts(boolean,integer)')"
    );
    expect(SQL).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_resolve_settled_financial_alerts(p_apply boolean DEFAULT false, p_limit integer DEFAULT 5000)'
    );
    // No new pg_cron job, no new alert source, no compensating-write table.
    expect(SQL).not.toMatch(/cron\.schedule/i);
    expect(SQL).not.toMatch(/CREATE\s+TABLE/i);
  });

  it('covers exactly the two non-satellite finish-refusal sources, and only those', () => {
    const classFiveMatch = SQL.match(
      /CLASS 5:[\s\S]*?v_finish := COALESCE\(array_length\(v_finish_ids, 1\), 0\);/
    );
    expect(classFiveMatch, 'CLASS 5 block not found in migration').toBeTruthy();
    const block = classFiveMatch![0];

    expect(block).toContain(
      "a.source IN ('Tournament.atomic_finish_refused', 'Tournament.atomic_finish_outcome_unknown')"
    );
    // Deliberately excluded (see migration header): unverified proof shape.
    expect(block).not.toContain('Tournament.atomic_satellite_finish_refused');
    expect(block).not.toContain('Satellite.stuck_completing_unawarded');
  });

  it('proves settlement from wallet_transactions keyed on this alert\'s own tournament_id and winner_id, not from tournament status or elapsed time', () => {
    const classFiveMatch = SQL.match(
      /CLASS 5:[\s\S]*?v_finish := COALESCE\(array_length\(v_finish_ids, 1\), 0\);/
    );
    const block = classFiveMatch![0];

    expect(block).toContain("a.context->>'tournament_id' IS NOT NULL");
    expect(block).toContain("a.context->>'winner_id' IS NOT NULL");
    expect(block).toContain('FROM public.wallet_transactions w');
    expect(block).toContain("w.related_entity_id = (a.context->>'tournament_id')::uuid");
    expect(block).toContain("w.user_id           = (a.context->>'winner_id')::uuid");
    expect(block).toContain("w.type = 'credit' AND w.category = 'prize'");

    // Must not key off tournaments.status or created_at/now() age - both were
    // considered and rejected (see migration header: tournament_finish_receipts
    // matched zero of the 1,084 affected tournaments, so status/receipts are
    // not trustworthy proof here; only the prize credit is).
    expect(block).not.toMatch(/tournaments\.status/);
    expect(block).not.toMatch(/created_at\s*[<>]/);
  });

  it('only writes resolved rows when p_apply is true, and stamps a resolution that names the mechanism', () => {
    expect(SQL).toContain('IF p_apply THEN');
    const applyMatch = SQL.match(
      /UPDATE public\.financial_alerts a\s+SET resolved = true,\s+resolved_at = now\(\),\s+context = COALESCE\(a\.context, '\{\}'::jsonb\) \|\| jsonb_build_object\(\s+'resolution', 'the named winner has since been credited[\s\S]*?WHERE a\.id = ANY\(v_finish_ids\);/
    );
    expect(applyMatch, 'CLASS 5 UPDATE block not found').toBeTruthy();
    expect(applyMatch![0]).toContain("'resolved_by_fn', 'fn_resolve_settled_financial_alerts'");
  });

  it('reports finish_refusal_settled and folds it into the total, without disturbing the other four classes', () => {
    expect(SQL).toContain("'finish_refusal_settled', v_finish");
    expect(SQL).toContain('v_paid + v_overpaid + v_settled + v_released + v_finish');
    // The other four classes' own WHERE clauses must be present unmodified.
    expect(SQL).toContain("a.source = 'fn_payout_guarantee_check'");
    expect(SQL).toContain("a.source = 'fn_tournament_payout_reconcile'");
    expect(SQL).toContain("a.source = 'ServerTableEngine.post_commit_obligations_pending'");
    expect(SQL).toContain(
      "a.source IN ('postHandTasks.hand_history_failed',\n                        'ServerTableEngine.authoritative_hand_semantic_refusal')"
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

  it('asserts CLASS 5 landed, in the same migration, before the transaction can commit silently wrong', () => {
    expect(SQL).toContain("v_result ? 'finish_refusal_settled'");
    expect(SQL).toContain('RAISE EXCEPTION');
  });
});
