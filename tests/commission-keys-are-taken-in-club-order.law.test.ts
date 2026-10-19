/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A CASH BATCH TAKES EVERY COMMISSION KEY IN CLUB ORDER, AND THE
 *        OPEN-WEEK REFRESH READS ONLY WHAT HAS BEEN ACCRUED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-10-19 07:28:34 UTC, 40P01: the cash batch held SHARK CLUB's commission key
 * while waiting for Club JAQK's, and a tournament finish held JAQK's while waiting
 * for SHARK CLUB's. 20261001001000's try-and-stop walk took the free keys in club
 * order but, at the first busy key, left every later key to the rollup trigger,
 * item by item in page order. The refused item then sat below the settler's cursor
 * and fn_union_rake_basis_refresh, which assumed everything below the cursor was
 * accrued, raised union_cash_sources_do_not_match_bank every hour.
 *
 * Migration 20261019094914 (proved by scripts/qualification/chip-deadlocks.py and
 * refresh-horizon.py, results under docs/evidence/commission-keys-2026-10-19):
 *   - the batch and the retry take every key in club order before the first item,
 *     a busy one waited for at most 1 s in its own subtransaction, and run only an
 *     item whose keys are all held; any other item is DEFERRED - it writes nothing;
 *   - the settler resubmits a deferred source before its cursor may pass it;
 *   - the refresh stops before the first refused source of the union in the window.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_commission_keys_in_club_order_refresh_reads_accrued.sql'))
  .at(-1);
if (!NAME) throw new Error('the commission key order migration is missing');
const MIG = migrationText(NAME);
const SUBS = sliceBetween(MIG, 'DO $subs$', 'END $subs$;');
const BATCH = sliceBetween(MIG, '$batch$CREATE OR REPLACE FUNCTION', '$batch$)');
const RETRY = sliceBetween(MIG, '$retry$CREATE OR REPLACE FUNCTION', '$retry$)');
const REFRESH = sliceBetween(MIG, 'DO $refresh$', 'END $refresh$;');
const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const SETTLER = read('server/src/services/RakebackSettlerService.ts');
const RECEIPTS = read('server/src/services/cashSourceReceipts.ts');
const CHIP = read('scripts/qualification/chip-deadlocks.py');
const HORIZON = read('scripts/qualification/refresh-horizon.py');

const PINS: Array<[string, string, string]> = [
  [
    'fn_credit_agent_commissions_batch',
    'd4572f3e1efd9c85a0025cc2906c6fae',
    '33e0be86d6a2a88f18be4ec4e058cadd',
  ],
  [
    'fn_retry_cash_accounting_sources',
    '3788581d5e8f1953663b8929b4688d0a',
    '0a5daa862601baaf365972ac6b577e6a',
  ],
  [
    'fn_union_rake_basis_refresh',
    'c88e99cda4f091c9e48b0f6b173651a4',
    '9fdc0af3d23759ab843ce122ecaefb03',
  ],
];

describe('commission keys are taken in club order', () => {
  it('replaces production text only, and lands on the text the harness measured', () => {
    for (const [fn, before, after] of PINS) {
      expect(MIG).toContain(before);
      expect(MIG).toContain(
        `-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '${after}' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}')`
      );
    }
    expect(SUBS).toContain('IF md5(pg_get_functiondef(v_sig)) <> ALL (s.before_md5s) THEN');
    // Either install order with 20261019102410 (PR #7427): its retry postimage is
    // accepted too, and the one body installed keeps its fewest-refusals-first queue.
    expect(SUBS).toContain(
      "ARRAY['3788581d5e8f1953663b8929b4688d0a', '0ab1bf9282426f348c034785513724e0'], '0a5daa862601baaf365972ac6b577e6a',"
    );
    expect(RETRY).toContain(
      'ORDER BY s.attempts,s.next_attempt_at,s.rake_record_id LIMIT p_limit);'
    );
    expect(SUBS).toContain('IF md5(v_after) <> s.after_md5 THEN');
    expect(REFRESH).toContain("IF md5(v_def) <> 'c88e99cda4f091c9e48b0f6b173651a4' THEN");
    expect(REFRESH).toContain("IF md5(v_new) <> '9fdc0af3d23759ab843ce122ecaefb03' THEN");
    // Owner, grants and settings are asserted, not changed.
    expect(SUBS).toContain(
      "'postgres|{postgres=X/postgres,service_role=X/postgres}|{search_path=public,statement_timeout=300s}|v|t'"
    );
    // The only grant statements restate the engine-only grants production holds.
    const grants = MIG.replace(/--[^\n]*/g, ' ').match(/^(?:GRANT|REVOKE)[^\n]*$/gm);
    expect(grants).toEqual([
      'REVOKE ALL ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb) FROM PUBLIC, anon, authenticated;',
      'GRANT EXECUTE ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb) TO service_role;',
      'REVOKE ALL ON FUNCTION public.fn_retry_cash_accounting_sources(integer) FROM PUBLIC, anon, authenticated;',
      'GRANT EXECUTE ON FUNCTION public.fn_retry_cash_accounting_sources(integer) TO service_role;',
    ]);
    expect(MIG).toContain("RAISE EXCEPTION 'the cash source grants moved';");
    // One transaction, bounded locks (CLAUDE.md section 2).
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '5s';");
  });

  for (const [label, body] of [
    ['the batch', () => BATCH],
    ['the retry', () => RETRY],
  ] as const) {
    it(`${label} takes every key before its first item and never lets an item take one out of order`, () => {
      const b = body();
      expect(b).not.toContain('EXIT WHEN NOT pg_try_advisory_xact_lock');
      const walk = b.indexOf('FOREACH v_gate IN ARRAY v_need LOOP');
      const first = b.indexOf('fn_process_cash_accounting_source(');
      expect(walk).toBeGreaterThan(-1);
      expect(walk).toBeLessThan(first);
      // A busy key: at most 1 s, in its own subtransaction, holding only lower keys.
      expect(b).toContain("PERFORM set_config('lock_timeout','1s',true);");
      expect(b).toContain('EXCEPTION WHEN lock_not_available OR deadlock_detected THEN\n    EXIT;');
      expect(b).toContain('v_held:=v_held||v_gate;');
      // An item whose keys are not all held is deferred, never run and never refused.
      const check = b.indexOf('IF NOT v_clubs<@v_held THEN');
      expect(check).toBeGreaterThan(walk);
      expect(check).toBeLessThan(first);
      expect(b).toContain("'deferred',v_deferred");
      expect(b).toMatch(/v_need:=ARRAY\(SELECT DISTINCT [^;]*ORDER BY/);
    });
  }

  it('the refresh reads only through the first refused source of its union', () => {
    // The law tests of 20260926042119 / 20260926073120 still read the cursor line.
    expect(REFRESH).toContain("v_anchor := E'  v_through := LEAST(p_end, now(), v_accrued);\\n';");
    expect(REFRESH).toContain("E'    FROM public.accounting_cash_source_work w\\n'");
    expect(REFRESH).toContain(
      "E'    JOIN public.accounting_cash_bank_receipts c ON c.rake_record_id = w.rake_record_id\\n'"
    );
    expect(REFRESH).toContain(
      "E'   WHERE w.status = \\'blocked\\' AND c.union_id = p_union_id\\n'"
    );
    expect(REFRESH).toContain("E'     AND c.banked_at >= p_start AND c.banked_at < v_through;\\n'");
    expect(REFRESH).toContain("E'  v_through := LEAST(v_through, v_unaccrued);\\n'");
  });

  it('the settler submits a deferred source again before the cursor can pass it', () => {
    expect(SETTLER).toContain('readCashSourceBatchOutcome(data, pending)');
    expect(SETTLER).toContain('pending = pending.filter((id) => deferred.includes(id));');
    expect(SETTLER.indexOf('still deferred for a busy commission key')).toBeLessThan(
      SETTLER.indexOf('saveHighWaterMark(nextCursor)')
    );
    expect(RECEIPTS).toContain('deferred and not resubmitted');
  });

  it('is proved natively on production bodies, and the evidence says it passed', () => {
    expect(CHIP).toContain("SORTED_FIX = ROOT / ('supabase/migrations/'");
    expect(CHIP).toContain(`'${NAME}')`);
    expect(CHIP).toContain(
      "BUSY_KEY_CASES = ('batch-vs-finish-on-a-busy-key', 'retry-vs-finish-on-a-busy-key')"
    );
    expect(HORIZON).toContain("LIVE_MD5 = 'c88e99cda4f091c9e48b0f6b173651a4'");
    expect(existsSync(resolve(ROOT, 'scripts/qualification/refresh-horizon-live.sql'))).toBe(true);
    const chip = JSON.parse(
      read('docs/evidence/commission-keys-2026-10-19/chip-deadlocks-run.json')
    );
    const horizon = JSON.parse(
      read('docs/evidence/commission-keys-2026-10-19/refresh-horizon-run.json')
    );
    expect(chip.passed).toBe(true);
    expect(chip.busy_key_ok).toBe(true);
    expect(horizon.passed).toBe(true);
    const busy = chip.results.filter(
      (r: { case: string }) => r.case === 'batch-vs-finish-on-a-busy-key'
    );
    expect(busy.find((r: { state: string }) => r.state === 'after').deadlocks).toBeGreaterThan(0);
    expect(busy.find((r: { state: string }) => r.state === 'sorted').deadlocks).toBe(0);
    expect(horizon.after_pr7427_md5).toEqual(horizon.after_md5);
    expect(horizon.pr7427_first_md5.fn_retry_cash_accounting_sources).toBe(
      '0ab1bf9282426f348c034785513724e0'
    );
    expect(horizon.after_md5).toEqual(Object.fromEntries(PINS.map(([fn, , after]) => [fn, after])));
  });
});
