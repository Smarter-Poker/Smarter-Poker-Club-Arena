/**
 * THE WEEKLY RAKEBACK CLOSE IS READY AT FOUR (2026-10-26).
 *
 * Pinned on migration 20261026131306_the_weekly_rakeback_close_is_ready_at_four.sql.
 *
 * On 2026-10-26 the 4:00 AM Chicago rakeback close paid nobody: the week's
 * inventory seal only started at 2:40 AM and finished at 6:43 AM, and after
 * the first 40 minutes past 4:00 AM job 272 called the close only at :40, so
 * Midway Union's first visit would have been 8:40 AM. The fix stages the
 * running week's seal layers during the week and keeps job 272 on every tick
 * until every active scope has had its first visit of the week.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261026131306_the_weekly_rakeback_close_is_ready_at_four.sql'
  ),
  'utf8'
);

const body = (name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf('$function$;', start);
  return sql.slice(start, end);
};

describe('the weekly rakeback close is ready at four', () => {
  it('is one transaction with live proofs and a periodic-work reason', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(3);
    expect(sql).toMatch(/^-- periodic-work: \S/m);
  });

  it('stages a layer only once its window has settled', () => {
    const settled = body('fn_union_pnl_inventory_layer_settled');
    expect(settled).toContain("p_end <= clock_timestamp() - interval '5 minutes'");
    expect(settled).toContain('a.backend_xid IS NOT NULL AND a.xact_start < p_end');
    expect(settled).toContain('x.prepared < p_end');
    const pre = body('fn_union_pnl_inventory_layer_precompute');
    expect(pre).toContain(
      "IF NOT public.fn_union_pnl_inventory_layer_settled(g.layer_end) THEN v_wait := 'next_window_not_settled'; EXIT; END IF;"
    );
  });

  it('never takes the running week book lock and never waits on the seal', () => {
    const pre = body('fn_union_pnl_inventory_layer_precompute');
    expect(pre).not.toMatch(/pg_advisory_xact_lock\(hashtextextended\('union-pnl-inventory:/);
    expect(pre).not.toMatch(/PERFORM pg_advisory_xact_lock\(/);
    expect(pre).toContain(
      "IF NOT pg_try_advisory_xact_lock(hashtextextended('union-pnl-inventory-checkpoint',0)) THEN"
    );
  });

  it('touches staging only once the week start is sealed, and never an unsealed week', () => {
    const pre = body('fn_union_pnl_inventory_layer_precompute');
    expect(pre).toContain(
      '(SELECT max(c.boundary) FROM public.union_pnl_inventory_checkpoints c) IS DISTINCT FROM v_base'
    );
    expect(pre).toContain(
      "RETURN jsonb_build_object('status','skipped','reason','unsealed_week_in_staging');"
    );
  });

  it('computes the seal windows with the seal layer function, in order, for the next boundary', () => {
    const pre = body('fn_union_pnl_inventory_layer_precompute');
    expect(pre).toContain(
      "generate_series(v_base, v_next - interval '1 microsecond', interval '6 hours') s ORDER BY 1 LOOP"
    );
    expect(pre).toContain(
      'public.fn_union_pnl_inventory_layer_state(v_base, v_next, g.layer_start, g.layer_end)'
    );
  });

  it('job 272 runs every tick until every active scope had its first visit', () => {
    expect(sql).toContain("' OR public.fn_weekly_close_first_visits_pending()' || v_anchor");
    expect(sql).toContain("IF md5(c) <> 'c74214f0f7e65064769601dbe867ec28' THEN");
    const pending = body('fn_weekly_close_first_visits_pending');
    expect(pending).toContain("clock_timestamp() < d.due + interval '12 hours'");
    expect(pending).toContain('v.last_visit_at < d.due');
    expect(pending).toContain("q.status = 'complete'");
  });

  it('the staging job runs hourly and moves no money', () => {
    expect(sql).toContain("cron.schedule('union-pnl-inventory-layer-precompute', '22 * * * *',");
    const pre = body('fn_union_pnl_inventory_layer_precompute');
    expect(pre).not.toMatch(
      /chip_balance|chip_ledger|fn_credit|fn_add_chips|union_accounting_runs/
    );
  });
});
