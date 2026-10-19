/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A BUSY COMMISSION KEY NEVER HOLDS THE CASH QUEUE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-10-19 17:00 UTC: the head of the cash refusal queue became one Lightning
 * source and four Midway sources. 20261019094914's key walk ENDED at the first
 * busy key, Midway's keys are the lowest uuids, and the retry read exactly
 * p_limit (5) due sources, so whenever a Midway key was busy every one of the
 * five was deferred untouched, the same five came back first on the next call,
 * and the ~2,590 sources due behind them were never reached. The batch had the
 * same walk: an item needing only a free key was deferred for an unrelated busy
 * one.
 *
 * Migration 20261019171753 (proved by scripts/qualification/chip-deadlocks.py,
 * evidence under docs/evidence/cash-queue-head-2026-10-19):
 *   - a busy key is skipped, never the end of the walk; keys are still waited
 *     for only in club order, above every key held, within one 1 s budget;
 *   - the retry reads a window of LEAST(200, 8 x p_limit) due sources and runs
 *     up to p_limit of those whose keys it holds;
 *   - deferrals are reported within the caller's bound, so the engine's
 *     response contract is unchanged.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_busy_commission_key_never_holds_the_cash_queue.sql'))
  .at(-1);
if (!NAME) throw new Error('the cash queue head migration is missing');
const MIG = migrationText(NAME);
const SUBS = sliceBetween(MIG, 'DO $subs$', 'END $subs$;');
const BATCH = sliceBetween(MIG, '$batch$CREATE OR REPLACE FUNCTION', '$batch$)');
const RETRY = sliceBetween(MIG, '$retry$CREATE OR REPLACE FUNCTION', '$retry$)');
const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const CHIP = read('scripts/qualification/chip-deadlocks.py');
const EVIDENCE = 'docs/evidence/cash-queue-head-2026-10-19/';

const PINS: Array<[string, string, string]> = [
  [
    'fn_credit_agent_commissions_batch',
    '33e0be86d6a2a88f18be4ec4e058cadd',
    '1ae9eb0e32f8169ce0cdd6b730c859a6',
  ],
  [
    'fn_retry_cash_accounting_sources',
    '0a5daa862601baaf365972ac6b577e6a',
    '779590b67fc21e95504a9827f1289207',
  ],
];

describe('a busy commission key never holds the cash queue', () => {
  it('replaces the installed texts only and lands on what the harness measured', () => {
    for (const [fn, before, after] of PINS) {
      expect(SUBS).toContain(`'${before}', '${after}',`);
      expect(MIG).toContain(
        `-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '${after}' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}')`
      );
    }
    expect(SUBS).toContain('IF md5(pg_get_functiondef(v_sig)) <> s.before_md5 THEN');
    expect(SUBS).toContain('IF md5(v_after) <> s.after_md5 THEN');
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '5s';");
    const grants = MIG.replace(/--[^\n]*/g, ' ').match(/^(?:GRANT|REVOKE)[^\n]*$/gm);
    expect(grants).toEqual([
      'REVOKE ALL ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb) FROM PUBLIC, anon, authenticated;',
      'GRANT EXECUTE ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb) TO service_role;',
      'REVOKE ALL ON FUNCTION public.fn_retry_cash_accounting_sources(integer) FROM PUBLIC, anon, authenticated;',
      'GRANT EXECUTE ON FUNCTION public.fn_retry_cash_accounting_sources(integer) TO service_role;',
    ]);
  });

  for (const [label, body] of [
    ['the batch', () => BATCH],
    ['the retry', () => RETRY],
  ] as const) {
    it(`${label} skips a busy key and never ends its walk there`, () => {
      const b = body();
      const walk = sliceBetween(b, 'FOREACH v_gate IN ARRAY v_need LOOP', ' END LOOP;');
      expect(walk).not.toMatch(/\bEXIT\b/);
      expect(walk).toContain(
        "IF pg_try_advisory_xact_lock(hashtextextended('agent-commission:'||v_gate::text,0)) THEN"
      );
      expect(walk).toContain('ELSIF clock_timestamp()<v_wait_until THEN');
      expect(walk).toContain(
        'EXCEPTION WHEN lock_not_available OR deadlock_detected THEN\n    NULL;'
      );
      // One 1 s budget for every wait in the call, never a fresh second per key.
      expect(b).toContain("v_wait_until:=clock_timestamp()+interval '1 second';");
      expect(b.indexOf("v_wait_until:=clock_timestamp()+interval '1 second';")).toBeLessThan(
        b.indexOf('FOREACH v_gate IN ARRAY v_need LOOP')
      );
      // Still: every key before the first item, and an item runs only with all its keys.
      expect(b.indexOf('FOREACH v_gate IN ARRAY v_need LOOP')).toBeLessThan(
        b.indexOf('fn_process_cash_accounting_source(')
      );
      expect(b).toContain('IF NOT v_clubs<@v_held THEN');
    });
  }

  it('the retry reads past a deferred head and stays inside the caller bound', () => {
    expect(RETRY).toContain(
      'ORDER BY s.attempts,s.next_attempt_at,s.rake_record_id LIMIT LEAST(200,p_limit*8));'
    );
    expect(RETRY).toContain('EXIT WHEN v_ok+v_blocked+v_failed>=p_limit;');
    expect(RETRY).toContain('WHERE x.n<=p_limit-(v_ok+v_blocked+v_failed)');
    expect(RETRY).toContain("'deferred',v_deferred");
  });

  it('is proved natively: production text starves, this text does not', () => {
    expect(CHIP).toContain(`SKIP_FIX = ROOT / 'supabase/migrations/${NAME}'`);
    expect(CHIP).toContain('def case_retry_starvation(');
    expect(CHIP).toContain('def case_batch_skips_busy_key(');
    const run = JSON.parse(read(EVIDENCE + 'chip-deadlocks-run.json'));
    expect(run.passed).toBe(true);
    expect(run.skip_ok).toBe(true);
    const head = (state: string) =>
      run.results.find(
        (r: { case: string; state: string }) =>
          r.case === 'retry-queue-head-on-a-busy-key' && r.state === state
      );
    const none = { ok: 0, blocked: 0, deferred: 5 };
    expect(head('sorted').calls_while_m_busy).toEqual([none, none, none]);
    expect(head('skipping').calls_while_m_busy[0]).toEqual({ ok: 4, blocked: 0, deferred: 1 });
    const whole = JSON.parse(read(EVIDENCE + 'whole-file-run.json'));
    expect(whole.after_md5).toEqual(Object.fromEntries(PINS.map(([fn, , after]) => [fn, after])));
  });
});
