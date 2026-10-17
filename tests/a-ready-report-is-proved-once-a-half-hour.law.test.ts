/**
 * A READY REPORT IS PROVED ONCE A HALF HOUR, NOT ONCE A TICK (2026-10-17)
 *
 * The chunked weekly close kept a ready union P&L evidence report only in a
 * per-attempt memo, so every 5-minute attempt proved it again cold, met its
 * deadline before round 2, and was rolled back. The receipt keeps a READY
 * report for at most 30 minutes, under the same original inventory
 * generation, and only inside a chunked attempt. This law keeps those limits.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261017131056_a_ready_report_is_proved_once_a_half_hour.sql',
  'utf8'
);

describe('a ready report is proved once a half hour', () => {
  it('seeds only a ready receipt of the same generation under 30 minutes old', () => {
    expect(sql).toContain("r.computed_at>clock_timestamp()-interval '30 minutes'");
    expect(sql).toContain("r.generation=COALESCE(k.generation,'')");
    expect(sql).toContain('r.computed_at>=p_end');
    expect(sql).toContain("p_report->>'status'='ready'");
    expect(sql).toContain("p_report->'basis_certified'='true'::jsonb");
    expect(sql).toContain("p_report->'issues'='[]'::jsonb");
  });

  it('acts only inside a chunked attempt with the close memo on', () => {
    const chunkedGates = sql.match(
      /current_setting\('app\.weekly_accounting_chunked',true\),''\)<>'on'/g
    );
    expect(chunkedGates?.length).toBe(2);
    expect(sql).toContain('v_report_seeded := v_chunked AND public.fn_accounting_close_report_seed(');
    expect(sql).toContain('IF v_chunked AND NOT v_report_seeded THEN');
  });

  it('a seeded attempt never refreshes the receipt, so the report is re-proved', () => {
    expect(sql).toContain('IF v_chunked AND NOT v_report_seeded THEN');
    expect(sql).not.toMatch(/fn_accounting_close_report_keep\([^)]*\);\s*v_report_seeded/);
  });

  it('pins the scope preimage and postimage and keeps the receipts private', () => {
    expect(sql).toContain("'6bd020f058339c34e51a88717cf4fbd6'");
    expect(sql).toContain("'9d5ede8aa77afecfb993e305a755175a'");
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public.accounting_close_report_receipts FROM PUBLIC, anon, authenticated;'
    );
    expect(sql).toContain('fn_ca_break_window_refuses_migrations(now())');
  });
});
