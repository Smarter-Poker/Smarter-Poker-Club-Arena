/**
 * A UNION BOOK THE SCHEDULER ALREADY CLOSED IS NOT RE-PROVED EVERY TICK
 *
 * After Midway's 2026-09-21 close, every idle tick of cron job 272 spent about
 * 18 minutes recomputing that paid book's P&L evidence only to skip it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SQL = readFileSync(resolve(__dirname, '..', 'supabase/migrations/20261002014425_a_union_book_the_scheduler_already_closed_is_not_reproved_ev.sql'), 'utf8');

describe('the weekly scheduler and a closed union book', () => {
  it('is patched only from the exact live version, in one transaction', () => {
    expect(SQL).toContain("IF md5(d)<>'36424fcc7345881172d24a1d3d2bf910' THEN RAISE EXCEPTION");
    expect(SQL).toMatch(/^BEGIN;$/m);
    expect(SQL).toMatch(/^COMMIT;$/m);
    expect(SQL).toMatch(/^-- @live-proof: /m);
  });

  it('skips the evidence recomputation only for a run the close marked complete', () => {
    expect(SQL).toContain("AND q.status='complete')");
    expect(SQL).toContain("ELSE public.fn_union_pnl_close_quality(v_union.id,v_from,v_end)->>'status'='ready' END) THEN");
  });

  it('records cron job 272 as production runs it', () => {
    expect(SQL).toContain("schedule:='40 * * * *'");
    expect(SQL).toContain("SET statement_timeout=''6600s''; SET app.weekly_accounting_attempt_budget=''1''; SET app.weekly_accounting_scope_budget=''100 minutes''");
  });
});
