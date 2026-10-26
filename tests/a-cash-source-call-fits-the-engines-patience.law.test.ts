/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A CASH SOURCE CALL FITS THE ENGINE'S PATIENCE, AND A HALTED PAGE
 *        COMES BACK ON THE NEXT SHORT TICK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-10-19 17:02 UTC: one fn_credit_agent_commissions_batch call of five
 * cash sources ran 16.1 s. Two items each waited the engine role's whole 8 s
 * lock_timeout for a profiles row another transaction held (the agents
 * foreign-key check in fn_post_accounting_commission_source), and nothing
 * bounded the call as a whole. The engine's client gave up at 15 s, the page
 * halted, and because the cycle had made no progress before it the settler
 * waited its full 30-minute interval: the cursor sat at 16:23:59 until the
 * next tick at 17:29:59. Cash accrual stood still for half an hour behind one
 * slow call.
 *
 * Two root fixes, one per half:
 *   - Migration 20261019214727 (it replaces 20261019190103, merged in #7485 and
 *     refused at install because 20261019194410 had replaced the batch; it keeps
 *     194410's player key walk): each item waits at most 2 s for a lock, no item
 *     starts after 8 s, an item the call has no time for is deferred (no
 *     receipt, no attempt), and the session lock_timeout is restored. 8 s sits
 *     inside BATCH_BUDGET_FRACTION of the client's 15 s.
 *   - RakebackSettlerService: every halt re-arms the catch-up; halts in a row
 *     with no acknowledged page back off 60 s, 120 s, ... up to the interval;
 *     an acknowledged page resets it. A deferral resubmission that settled
 *     something does not count toward the halt.
 *   - RakebackSettlerService: the durable-refusal retry drains what is due.
 *     One call of CASH_RETRY_LIMIT a run retried 12,135 due Midway sources at
 *     about 40 an hour (19:48-20:20); a run now keeps calling while each call
 *     is full and settled something, for up to CASH_RETRY_DRAIN_BUDGET_MS.
 *
 * Proved natively by scripts/qualification/chip-deadlocks.py (stage
 * 'budgeted'), evidence under docs/evidence/settler-pacing-2026-10-19.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';
import {
  BATCH_BUDGET_FRACTION,
  CASH_SOURCE_CALL_SERVER_BUDGET_MS,
  DEFAULT_CLIENT_TIMEOUT_MS,
} from '../server/src/services/cashAccountingBatchBudget';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_cash_source_call_fits_the_engines_patience.sql'))
  .at(-1);
if (!NAME) throw new Error('the cash source call budget migration is missing');
const MIG = migrationText(NAME);
const SUBS = sliceBetween(MIG, 'DO $subs$', 'END $subs$;');
const BATCH = sliceBetween(MIG, '$batch$CREATE OR REPLACE FUNCTION', '$batch$)');
const BATCH_ONLY = sliceBetween(MIG, '$batchonly$CREATE OR REPLACE FUNCTION', '$batchonly$)');
const RETRY = sliceBetween(MIG, '$retry$CREATE OR REPLACE FUNCTION', '$retry$)');
const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const CHIP = read('scripts/qualification/chip-deadlocks.py');
const SETTLER = read('server/src/services/RakebackSettlerService.ts');
const SETTLER_CODE = SETTLER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const EVIDENCE = 'docs/evidence/settler-pacing-2026-10-19/';

/** Installed in production (20261019194410's batch, 20261019171753's retry) -> this migration. */
const PINS: Array<[string, string, string]> = [
  [
    'fn_credit_agent_commissions_batch',
    '9befae963f3b9cda25b357f60a9b53d7',
    '1c9d9ff9cfb2803f05223c703f61f09b',
  ],
  [
    'fn_retry_cash_accounting_sources',
    '779590b67fc21e95504a9827f1289207',
    'df10ba64229df0c99918dad77f39aec7',
  ],
];
/** The other accepted batch preimage, 20261019171753's, lands on the budget alone. */
const BATCH_171753: [string, string] = [
  '1ae9eb0e32f8169ce0cdd6b730c859a6',
  '6c9a388585158521f0ac36300d5124fd',
];

describe('a cash source call fits the engine patience', () => {
  it('replaces only the installed texts and lands on what the harness measured', () => {
    expect(SUBS).toContain(`'${BATCH_171753[0]}', '${BATCH_171753[1]}',`);
    for (const [fn, before, after] of PINS) {
      expect(SUBS).toContain(`'${before}', '${after}',`);
      expect(MIG).toContain(
        `-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '${after}' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}')`
      );
    }
    // Exactly one accepted preimage per function must be installed, or nothing changes.
    expect(SUBS).toContain(
      'WHERE x.signature = v_one AND x.before_md5 = md5(pg_get_functiondef(v_sig))) <> 1 THEN'
    );
    expect(SUBS).toContain('IF v_after <> s.new_def OR md5(v_after) <> s.after_md5 THEN');
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

  it("keeps 20261019194410's player key walk in the batch it builds on", () => {
    expect(BATCH).toContain('IF NOT v_clubs<@v_held OR NOT v_users<@v_held_users THEN');
    expect(BATCH).toContain(
      "pg_try_advisory_xact_lock(hashtextextended('player-stats-user:'||v_user::text,0))"
    );
    expect(SUBS).toContain("20261019194410''s player key walk was lost");
    const fresh = MIG.replace(/--[^\n]*/g, ' ');
    expect(fresh).not.toMatch(/CREATE\s+(?:TEMP|TEMPORARY)?\s*TABLE/i);
  });

  for (const [label, body] of [
    ['the batch', () => BATCH],
    ['the batch on 20261019171753', () => BATCH_ONLY],
    ['the retry', () => RETRY],
  ] as const) {
    it(`${label} bounds the whole call, not only the key walk`, () => {
      const b = body();
      const seconds = CASH_SOURCE_CALL_SERVER_BUDGET_MS / 1000;
      expect(b).toContain(`v_call_deadline:=clock_timestamp()+interval '${seconds} seconds';`);
      // Set before the key walk, so the walk's 1 s is inside the call's budget.
      expect(b.indexOf('v_call_deadline:=clock_timestamp()')).toBeLessThan(
        b.indexOf('FOREACH v_gate IN ARRAY v_need LOOP')
      );
      // Checked per item, after the key check and before any work.
      const check = b.indexOf('IF clock_timestamp()>=v_call_deadline THEN');
      expect(b.indexOf('IF NOT v_clubs<@v_held')).toBeGreaterThan(0);
      expect(check).toBeGreaterThan(b.indexOf('IF NOT v_clubs<@v_held'));
      expect(check).toBeLessThan(b.indexOf('r:=public.fn_process_cash_accounting_source('));
      // An item's lock wait never reaches past the deadline, and never past 2 s.
      expect(b).toContain(
        'LEAST(2000,ceil(extract(epoch FROM v_session_lock_timeout::interval)*1000)::bigint) ELSE 2000 END;'
      );
      expect(b).toContain(
        "GREATEST(1,ceil(extract(epoch FROM v_call_deadline-clock_timestamp())*1000)::bigint))::text||'ms',true);"
      );
      // And the caller's session gets its own lock_timeout back.
      expect(b).toContain("PERFORM set_config('lock_timeout',v_session_lock_timeout,true);");
      expect(b).toContain("'deferred',v_deferred");
    });
  }

  it("the server budget sits inside the engine client's budget", () => {
    expect(CASH_SOURCE_CALL_SERVER_BUDGET_MS).toBeLessThanOrEqual(
      DEFAULT_CLIENT_TIMEOUT_MS * BATCH_BUDGET_FRACTION
    );
  });

  it('a halted page is retried on the next short tick, never the interval by default', () => {
    expect(SETTLER_CODE).not.toContain('stalledPageRetryAvailable');
    expect(SETTLER_CODE).toContain(
      'export function haltedPageRetryDelayMs(consecutiveStalls: number)'
    );
    const run = sliceBetween(
      SETTLER_CODE,
      'async runSettlement(): Promise<void> {',
      'this.scheduleCatchUp(backlogRemains, generation);'
    );
    expect(run).toMatch(/if \(result === 'halted'\) \{\s*backlogRemains = true;/);
    expect(SETTLER_CODE).toContain('}, haltedPageRetryDelayMs(this.consecutiveStalls));');
    expect(SETTLER_CODE).toContain(
      'if (pagesAcknowledged > 0 || !backlogRemains) this.consecutiveStalls = 0;'
    );
  });

  it('only resubmissions in a row that settled nothing hold the cursor', () => {
    expect(SETTLER_CODE).toContain(
      'submission > 0 && receipts.length === 0 ? fruitlessResubmissions + 1 : 0'
    );
    expect(SETTLER_CODE).toContain('if (fruitlessResubmissions >= CASH_DEFERRAL_RESUBMITS)');
  });

  it('the retry drains what is due, not one call a run', () => {
    const drain = sliceBetween(
      SETTLER_CODE,
      'private async drainCashSourceRetries(): Promise<{',
      'private async _runSettlementInner(): Promise<CycleResult> {'
    );
    expect(drain).toMatch(/p_limit:\s*CASH_RETRY_LIMIT\s*,/);
    expect(drain).toContain('const deadline = Date.now() + CASH_RETRY_DRAIN_BUDGET_MS;');
    // 2026-10-25: progress is an ACCRUAL, not any receipt. A call that refused
    // every source again (55000 accounting_terms_not_observed, 61,354 due) proves
    // the next call would too, so it ends the drain and the queue rests
    // (retryRestMs); the fixture backlog below accrues on every call, so the
    // native evidence of the budgeted drain is unchanged.
    expect(drain).toContain('if (!lastCallFull || accrued === 0) break;');
    expect(drain).toContain(
      'if (Date.now() < this.retryRestUntilMs) return { receipts, lastCallFull: false };'
    );
    expect(drain).toContain(
      'if (Date.now() >= deadline || isMaintenanceFrozen() || !this.acceptingSettlements) break;'
    );
    expect(drain).toContain('if (call === 0) throw error;');
    expect(SETTLER_CODE).toContain('const drained = await this.drainCashSourceRetries();');
    expect(SETTLER_CODE).toContain('export const CASH_RETRY_DRAIN_BUDGET_MS = 30_000;');
    expect(CHIP).toContain('RETRY_DRAIN_BUDGET_S = 30.0');
    expect(CHIP).toContain('def case_retry_backlog_drain(');
    const run = JSON.parse(read(EVIDENCE + 'chip-deadlocks-run.json'));
    expect(run.drain_ok).toBe(true);
    const rb = run.results.find(
      (r: { case: string; state: string }) =>
        r.case === 'retry-backlog-drain' && r.state === 'budgeted'
    );
    expect(rb.one_call_a_run.accrued).toBe(15);
    expect(rb.drain.accrued).toBe(rb.n - 15);
    expect(rb.work_after).toBe(`accrued:${rb.n}`);
    expect(rb.drain.longest_call_seconds).toBeLessThan(8);
  });

  it('is proved natively: production text outlasts the client, this text does not', () => {
    expect(CHIP).toContain(`BUDGET_FIX = ROOT / 'supabase/migrations/${NAME}'`);
    expect(CHIP).toContain('def case_items_behind_held_rows(');
    const run = JSON.parse(read(EVIDENCE + 'chip-deadlocks-run.json'));
    expect(run.passed).toBe(true);
    expect(run.budget_ok).toBe(true);
    const at = (c: string, state: string) =>
      run.results.find((r: { case: string; state: string }) => r.case === c && r.state === state);
    expect(at('batch-items-behind-held-rows', 'skipping').call_seconds).toBeGreaterThan(15);
    expect(at('batch-items-behind-held-rows', 'keyed').call_seconds).toBeGreaterThan(15);
    expect(run.either_order_ok).toBe(true);
    expect(run.budget_on_171753_text.batch_inside).toBe(BATCH_171753[1]);
    expect(at('batch-items-behind-held-rows', 'budgeted').call_seconds).toBeLessThan(9.5);
    expect(at('batch-items-behind-held-rows', 'budgeted').lock_timeout_after).toBe('8s');
    const out = at('batch-runs-out-of-budget', 'budgeted');
    expect(out.call_seconds).toBeLessThan(9.5);
    expect(out.batch.deferred).toBeGreaterThan(0);
    expect(out.resubmitted.deferred).toBe(0);
    const whole = JSON.parse(read(EVIDENCE + 'whole-file-run.json'));
    expect(whole.before_md5).toEqual(Object.fromEntries(PINS.map(([fn, before]) => [fn, before])));
    expect(whole.after_md5).toEqual(Object.fromEntries(PINS.map(([fn, , after]) => [fn, after])));
    expect(whole.replay).toMatch(/^refused: /);
    const replayHarness = JSON.parse(
      read(EVIDENCE + 'replay-locks-and-player-stats-keys-run.json')
    );
    expect(replayHarness.ok).toBe(true);
    expect(replayHarness.budgeted_batch).toBe(PINS[0][2]);
  });
});
