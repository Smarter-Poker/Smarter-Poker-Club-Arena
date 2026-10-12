/**
 * FOUR AUDITS READ ONLY WHAT THEIR VERDICT NEEDS (2026-10-03).
 *
 * Pinned on migration 20261003025434. The ratchet watch, the Spin unpaid
 * check, the settlement correctness check and the stats witness audit were
 * cancelled by statement timeout more often than they finished. Each body is
 * edited by exact substitution against a pinned preimage and a derived
 * postimage; the verdicts are unchanged, only the reading is cheaper.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261003025434_four_audits_read_only_what_their_verdict_needs.sql'
  ),
  'utf8'
);

describe('four audits read only what their verdict needs', () => {
  it('is one transaction whose helper refuses anything but the pinned text', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/^-- @live-proof: /m);
    expect(sql).toMatch(/CREATE FUNCTION pg_temp\.ca_audit_subst\(/);
    expect(sql).toMatch(/is not the pinned text/);
    expect(sql).toMatch(/expected exactly 1/);
    expect(sql).toMatch(/is not the derived postimage/);
    expect(sql).toMatch(/owner, security, settings or grants moved/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\./);
  });

  it('pins every preimage and postimage', () => {
    for (const [sig, before, after] of [
      [
        'public.fn_ca_ratchet_watch()',
        '420c3f077b89c7a1aef11d17d265636e',
        '0a39cfd46d44e3bb0863d4049a3a1924',
      ],
      [
        'public.fn_spin_unpaid_check(integer)',
        '9c04b99ae4b10e7e58a7df8d91050c19',
        '483f09fc67a627b961e20a273249269d',
      ],
      [
        'public.fn_ca_settlement_correctness_check()',
        '331dfe59b157b733bc1efc99bbf193d0',
        'a58c53d6d111fe2d9a9b966a2144e769',
      ],
      [
        'public.ca_stats_witness_audit(integer,integer)',
        'a7738fa961dccb1ae5229c1825adb3c3',
        'fbea24b80e755d047b6177b0c1f1fd56',
      ],
    ]) {
      expect(sql).toContain(`'${sig}',\n  '${before}', '${after}',`);
    }
  });

  it('counts the one ratchet kind directly with the rule fn_rake_law_violations uses', () => {
    expect(sql).toMatch(/FROM public\.fn_rake_law_violations\('2 hours'::interval\)/);
    expect(sql).toMatch(/AND hh\.showdown IS NULL/);
    expect(sql).toMatch(/\+ COALESCE\(rr\.bbj_contribution, hh\.bbj_amount, 0\) > 0\.005;/);
    expect(sql).toMatch(/AND hh\.created_at < now\(\) - interval '5 minutes'/);
  });

  it('reads the Spin view once and the seat columns per alerted tournament', () => {
    expect(sql).toMatch(/ORDER BY v\.chips_short DESC\n  LOOP/);
    expect(sql).toMatch(/WHERE s\.tournament_id = v_row\.tournament_id;/);
    expect(sql).toMatch(/'seat_shape',    v_shape,/);
  });

  it('reads the day only when the hour accuses, and declares the guard', () => {
    expect(sql).toMatch(
      /WHERE h\.created_at>now\(\)-interval '60 minutes';\n    IF v_hands_1h >= 20 AND v_claims_1h < \(v_hands_1h \* 9\) \/ 10 THEN\n      WITH recent AS MATERIALIZED/
    );
    expect(sql).toMatch(
      /fn_ca_declare_guard_redefinition\('fn_ca_settlement_correctness_check', 'migration 20261003025434_four_audits_read_only_what_their_verdict_needs'\)/
    );
  });

  it('fetches index rows by hand and judges each all-in seat in one pass', () => {
    expect(sql).toMatch(
      /WHERE i\.hand_id = ANY \(ARRAY\(SELECT DISTINCT s\.hand_id FROM seat s\)\)/
    );
    expect(sql).toMatch(/CASE WHEN f\.all_in_equity IS NULL THEN/);
    expect(sql).toMatch(/    OFFSET 0\n  \) x;/);
  });
});
