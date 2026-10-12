/**
 * THE WEEKLY CLOSE NEVER HOLDS REPLICATION (2026-10-12).
 *
 * Pinned on migration 20261012134146_the_weekly_close_never_holds_replication.sql.
 *
 * Supabase Realtime shuts its replication connection down when the slot lags
 * more than 1.5 GB (50% of max_slot_wal_keep_size). This database writes about
 * 240-280 MB of WAL a minute, and the slot cannot pass the first record of the
 * oldest open writing transaction, so any transaction that stays open for about
 * 5.3 minutes takes DB broadcasts down for every player. Job 272 gave itself up
 * to 60 minutes (3600 s, 50 minute scope budget) and 12 otherwise; on
 * 2026-10-12 its 13-24 minute ticks caused four Realtime shutdowns, and on
 * 2026-10-06 its ordinary 5-12 minute ticks caused three more.
 *
 * If you are here because you want job 272 to have a larger budget again: the
 * budget is the replication bound, not a tuning knob. A step that does not fit
 * the tick raises a critical alert naming it; split that step instead.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261012134146_the_weekly_close_never_holds_replication.sql'
  ),
  'utf8'
);

// The new first statement of job 272, exactly as the migration installs it.
const newHead = sql.match(/command_after:=\$r\$(.*?)\$r\$\|\|split_part/s)?.[1] ?? '';

describe('the weekly close never holds replication', () => {
  it('is one transaction with a live proof and pinned pre and post images', () => {
    expect(sql.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(1);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    // live preimages (2026-10-12) and the postimages the live proof checks
    for (const md5 of [
      'ac28cf989d8d145aa0cfb2232fbf4041', // evidence report before
      '929cc88e98cd027e821f871f8adbe935', // evidence report after
      '3cb890191c1da58d621f108934d1116e', // scheduler before
      '01288c36118e1e26e7673fc71f155bf6', // scheduler after
      'a532167f5019f181dd10e48102e40cfc', // job 272 command before
      'b8be947fc591eeac63d2c194932fac66', // job 272 command after
    ]) {
      expect(sql).toContain(md5);
    }
    expect(sql).toContain('cron.alter_job(before_job.jobid,command:=command_after)');
  });

  it('gives job 272 one bounded budget and no larger fallback', () => {
    expect(newHead).toContain("set_config('statement_timeout','240s',false)");
    expect(newHead).toContain("set_config('app.weekly_accounting_scope_budget','3 minutes',false)");
    expect(newHead).toContain("set_config('app.weekly_accounting_chunked','on',false)");
    expect(newHead).not.toMatch(/x\.big|3600s|50 minutes|720s|9 minutes/);
    // The bound itself: 240 s at the measured 280 MB a minute stays under the
    // 1.5 GB slot cutoff with room for the WAL other writers add.
    const seconds = Number(newHead.match(/'statement_timeout','(\d+)s'/)?.[1]);
    expect(seconds).toBeGreaterThan(0);
    expect((seconds / 60) * 280).toBeLessThan(1536 * 0.75);
  });

  it('proves the plan windows before any step that can be re-proved', () => {
    const replacement = sql.slice(sql.indexOf("'report advance moved out'"));
    const windowsFirst = replacement.indexOf('-- THE WINDOWS GO FIRST (20261012)');
    const advance = replacement.indexOf(
      'fn_accounting_union_earned_plan_advance(p_union_id,p_start,p_end) IS FALSE',
      windowsFirst
    );
    const closing = replacement.indexOf("'report closing boundary'");
    expect(windowsFirst).toBeGreaterThan(0);
    expect(advance).toBeGreaterThan(windowsFirst);
    expect(advance).toBeLessThan(closing);
  });

  it('keeps a step that found a problem for one hour, never as a certificate', () => {
    expect(sql).toContain(
      "AND c.kind=p_kind||'_problem' AND c.union_id=p_union_id AND c.period_start=p_start AND c.period_end=p_end"
    );
    expect(sql).toContain(
      "AND c.certified_at>=p_end AND c.certified_at>clock_timestamp()-interval '1 hour'"
    );
    for (const kind of ['pnl_boundary', 'pnl_flows', 'pnl_touched', 'pnl_clubs']) {
      expect(sql).toContain(`'${kind}_problem'`);
      // a kept problem is read only after the clean certificate
      expect(sql).toContain(`public.fn_accounting_close_problem('${kind}',`);
    }
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.fn_accounting_close_problem');
  });

  it('seals inside the bounded tick, and a failed or oversized seal step ends it loudly', () => {
    expect(sql).toContain(
      "IF (v_tick_budget_large OR v_chunked) AND to_regprocedure('public.fn_union_pnl_inventory_checkpoint_due()') IS NOT NULL"
    );
    expect(sql).toContain("'error','inventory_checkpoint_seal_failed'");
    expect(sql).toContain("'A weekly inventory seal step did not fit the bounded close tick'");
    expect(sql).toContain("AND (v_scope_outcome='error' OR v_tick_budget_large OR v_chunked) THEN");
  });
});
