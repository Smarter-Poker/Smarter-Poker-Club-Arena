/**
 * THE FELT KEEPS WHAT LANDED ON IT (chip standard, 2026-09-04).
 *
 * Measured before this law: the felt lost 1,300 to 2,700 chips every hour,
 * every hour, from 2026-08-31 20:30 UTC. fn_ca_trial_balance named the two
 * accounts (table_stack and tournament_liability); reconciling every same-
 * player pair of consecutive cash hands against the seat credits journalled
 * between them named the two defects:
 *
 *   A. A mid-hand add-on was debited from the wallet at request time and
 *      applied to table_seats.stack by resolve_pending_addon at settlement
 *      step 8e - AFTER the dealing loop had reloaded seats from the database,
 *      because the settlement barrier handleHandCompleteEvent assigned
 *      overwrote the one settleCompletedHand had set to include
 *      postHandTasks. The next hand was dealt from the pre-credit stack and
 *      the hand write, an ABSOLUTE overwrite of the row, erased the credit.
 *      64 add-ons / 7,685.70 chips in three hours; ~15% of all mid-hand
 *      add-ons; every one a wallet debit with nothing on the felt.
 *
 *   B. A standalone club's tournament rake was journalled as leaving
 *      table_stack (credit_club_rake_to_treasury ignored the prize_liability
 *      the caller declared): 1,178.96 an hour the felt never paid, masking
 *      most of A on the meter.
 *
 * The law, in four parts:
 *
 *   1. THE BARRIER COVERS THE CHAIN. handleHandCompleteEvent chains onto
 *      whatever settleCompletedHand assigned; it never replaces it. The
 *      dealing loop re-reads the barrier after every wait and only clears
 *      the promise it actually awaited. (Behavioural test on the shipped
 *      prototype + source pins.)
 *   2. THE HAND WRITE IS A DIFFERENCE. Every seat carries stack_before (the
 *      stack it was dealt from) and rake/BBJ are declared; the database
 *      applies stack - stack_before to the row and asserts the identity.
 *      There is exactly one stack write per hand and no absolute re-sync.
 *   3. THERE IS NO ABSOLUTE FALLBACK. A refusal is final; transport failure
 *      is retried, bounded, then named with the payload.
 *   4. THE DATABASE SIDE (migration text): delta mode with stack_before, the
 *      no-op trigger is not a failure, rebases are recorded, the declared
 *      rake counterparty is honoured, and the restoration door is keyed.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(HERE, rel), 'utf8');
/** Strip comments so a pin cannot be satisfied by prose. */
const code = (src: string): string =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

vi.mock('../services/supabase.js', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
  loadTable: vi.fn(),
  syncStacks: vi.fn(),
  updateTableStatus: vi.fn(),
  autoRebuyHorse: vi.fn(),
  markSeatAsLeft: vi.fn(),
  processLeavePending: vi.fn(),
  logBBJCollection: vi.fn(),
  logInsuranceSettlement: vi.fn(),
  logHandHistory: vi.fn(),
  processBBJPayout: vi.fn(),
  completeHandSnapshot: vi.fn(),
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const { ServerTableEngineSettlement } = await import('./ServerTableEngineSettlement.js');

const deferred = <T = void>() => {
  let resolveFn!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolveFn = r));
  return { promise, resolve: resolveFn };
};
const settled = async (p: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true)
  );
  // A macrotask turn flushes every pending microtask, so a promise that is
  // already settled reads as settled and one that is not, does not.
  await new Promise((r) => setTimeout(r, 0));
  return done;
};

describe('LAW 1: the settlement barrier covers postHandTasks', () => {
  it('the common path: the body sets the chain synchronously, and the wrapper KEEPS it', async () => {
    const postTasks = deferred();
    const engine = Object.create(ServerTableEngineSettlement.prototype) as Record<string, unknown>;
    engine.postHandTasksPromise = null;
    // What settleCompletedHand does on the common path: no await before it
    // fires postHandTasks and chains it onto the field, then returns.
    engine.settleCompletedHand = async function (this: Record<string, unknown>) {
      const prior = this.postHandTasksPromise as Promise<void> | null;
      this.postHandTasksPromise = prior
        ? Promise.all([prior, postTasks.promise]).then(() => undefined)
        : postTasks.promise;
    };
    const handle = engine.handleHandCompleteEvent as (e: unknown, p: unknown[]) => Promise<void>;
    await handle.call(engine, { type: 'HAND_COMPLETE' }, []);

    const barrier = engine.postHandTasksPromise as Promise<void>;
    expect(barrier).toBeTruthy();
    // The barrier must NOT be settled while postHandTasks is still running.
    expect(await settled(barrier)).toBe(false);
    postTasks.resolve();
    await barrier;
    expect(await settled(barrier)).toBe(true);
  });

  it('the rare path: the body awaits first; the wrapper assigns, the body chains onto it', async () => {
    const postTasks = deferred();
    const gate = deferred();
    const engine = Object.create(ServerTableEngineSettlement.prototype) as Record<string, unknown>;
    engine.postHandTasksPromise = null;
    engine.settleCompletedHand = async function (this: Record<string, unknown>) {
      await gate.promise; // e.g. an insurance-shortfall alert
      const prior = this.postHandTasksPromise as Promise<void> | null;
      this.postHandTasksPromise = prior
        ? Promise.all([prior, postTasks.promise]).then(() => undefined)
        : postTasks.promise;
    };
    const handle = engine.handleHandCompleteEvent as (e: unknown, p: unknown[]) => Promise<void>;
    const whole = handle.call(engine, { type: 'HAND_COMPLETE' }, []);
    const firstBarrier = engine.postHandTasksPromise as Promise<void>;
    expect(firstBarrier).toBeTruthy();
    gate.resolve();
    await whole;
    // The body reassigned the field to include postTasks; a loop that re-reads
    // the field (LAW 1b) now waits on it.
    const second = engine.postHandTasksPromise as Promise<void>;
    expect(second).not.toBe(firstBarrier);
    expect(await settled(second)).toBe(false);
    postTasks.resolve();
    await second;
  });

  it('the wrapper never overwrites the field with its own promise', () => {
    const src = read('./ServerTableEngineSettlement.ts');
    const wrapper = code(
      src.slice(
        src.indexOf('protected async handleHandCompleteEvent'),
        src.indexOf('private async settleCompletedHand')
      )
    );
    expect(wrapper).not.toMatch(/this\.postHandTasksPromise\s*=\s*wholeSettlement/);
    expect(wrapper).toContain('const assignedByBody = this.postHandTasksPromise');
    expect(wrapper).toMatch(/Promise\.all\(\[assignedByBody, guarded\]\)/);
  });

  it('the dealing loop re-reads the barrier after every wait and clears only what it awaited', () => {
    const src = code(read('./ServerTableEngineDealing.ts'));
    expect(src).toContain('while (this.postHandTasksPromise) {');
    expect(src).toContain(
      'if (this.postHandTasksPromise === pending) this.postHandTasksPromise = null;'
    );
    expect(src).not.toMatch(
      /if \(this\.postHandTasksPromise\) \{\s*\n\s*this\.setLoopPhase\('await_post_hand_tasks'\)/
    );
  });
});

describe('LAW 2: the hand write is a difference, declared, and written once', () => {
  const settle = read('./ServerTableEngineSettlement.ts');
  const settleCode = code(settle);

  it('every seat carries the stack it was dealt from', () => {
    const step = settleCode.slice(
      settleCode.indexOf("await runStep('sync_stacks'"),
      settleCode.indexOf("await runStep('hand_history'")
    );
    expect(step).toMatch(/stack_before:\s*snap\.dealtStacks\.get\(p\.user_id\)\s*\?\?\s*p\.stack/);
  });

  it('rake and BBJ are declared to the write', () => {
    const step = settleCode.slice(
      settleCode.indexOf("await runStep('sync_stacks'"),
      settleCode.indexOf("await runStep('hand_history'")
    );
    expect(step).toMatch(/rake:\s*this\.isTournamentTable\(\)\s*\?\s*0\s*:\s*snap\.rake/);
    expect(step).toMatch(/bbj:\s*this\.isTournamentTable\(\)\s*\?\s*0\s*:\s*snap\.bbjFee/);
    // Insurance payouts and premiums move chips between the bank and the
    // seats before the write; the net is declared as inflow or every insured
    // hand fails the identity.
    expect(step).toMatch(/inflow:\s*snap\.insuranceNet/);
    expect(settleCode).toMatch(
      /this\.currentHandInsuranceNet = Math\.round\(insuranceNet \* 100\) \/ 100;/
    );
  });

  it('there is exactly one stack write per hand - no absolute re-sync after the BBJ payout', () => {
    const calls = settleCode.match(/await syncStacks\(/g) ?? [];
    expect(calls.length).toBe(1);
    const bbj = settleCode.slice(
      settleCode.indexOf("await runStep('bbj_payout'"),
      settleCode.indexOf("await runStep('tournament_chip_sync'")
    );
    expect(bbj).not.toMatch(/syncStacks\(/);
  });

  it('the dealt stacks are captured for every table, cash included', () => {
    const dealing = code(read('./ServerTableEngineDealing.ts'));
    const at = dealing.indexOf('this.currentHandDealtStacks = new Map(');
    expect(at).toBeGreaterThan(-1);
    // Not gated on isTournamentTable: the cash felt is what was leaking.
    const before = dealing.slice(Math.max(0, at - 400), at);
    expect(before).not.toMatch(/isTournamentTable\(\)\)\s*\{\s*$/);
  });
});

describe('LAW 3: the write is atomic, in delta mode, with no absolute fallback', () => {
  const tables = read('../services/supabase/tables.ts');
  const fn = code(tables.slice(tables.indexOf('export async function syncStacks(')));

  it('delta mode is all-or-nothing and declares rake, bbj, ref and inflow', () => {
    expect(fn).toMatch(/const deltaMode = players\.every\(/);
    expect(fn).toMatch(/stack_before:\s*rounded\(p\.stack_before as number\)/);
    for (const key of ['p_rake', 'p_bbj', 'p_ref', 'p_inflow']) expect(fn).toContain(`${key}:`);
  });

  it('a refusal is final and a transport failure is retried, bounded, then named', () => {
    expect(fn).toContain("'DB.settle_hand_stacks_conservation_refused'");
    expect(fn).toContain("'DB.settle_hand_stacks_declined'");
    expect(fn).toContain("'DB.settle_hand_stacks_unreachable'");
    expect(fn).toMatch(/attempt <= STACK_WRITE_ATTEMPTS/);
    expect(fn).toMatch(/JSON\.stringify\(payload\)/);
  });

  it('nothing in syncStacks writes a stack outside the RPC', () => {
    expect(fn).not.toMatch(/\.update\(\s*\{\s*stack/);
    expect(fn).not.toMatch(/updatePayload/);
    expect(fn).not.toContain("'DB.settle_hand_stacks_fallback'");
    // A write with no hand number is refused, not routed to a per-seat loop.
    expect(fn).toContain("'DB.sync_stacks_without_hand'");
  });

  it('a tournament hand requires the same transaction to prove its standings mirror', () => {
    expect(fn).toContain('const expectedTournamentId = options.expectedTournamentId ?? null;');
    expect(fn).toContain('tournamentStackProofIsExact(');
    expect(fn).toContain("'DB.settle_hand_stacks_tournament_proof_invalid'");
    const settlement = code(read('./ServerTableEngineSettlement.ts'));
    const write = settlement.slice(
      settlement.indexOf("await runStep('sync_stacks'"),
      settlement.indexOf("await runStep('hand_history'")
    );
    expect(write).toMatch(
      /expectedTournamentId:\s*this\.isTournamentTable\(\)\s*\?\s*\(this\.tableInfo\?\.tournament_id\s*\?\?\s*null\)\s*:\s*null/
    );
    expect(settlement).not.toContain('syncTournamentChips');
    expect(tables).not.toContain('export async function syncTournamentChips');
  });
});

describe('LAW 4: the database applies the difference and honours the declaration', () => {
  const migrationsDir = resolve(HERE, '../../../supabase/migrations');
  const file = readdirSync(migrationsDir).find((f) =>
    /^\d{14}_felt_erasure_delta_settlement\.sql$/.test(f)
  );
  const sql = file ? readFileSync(resolve(migrationsDir, file), 'utf8') : '';

  it('the migration is mirrored in the repo', () => {
    expect(file).toBeTruthy();
  });

  it('delta mode: every element must carry stack_before, the row gets old + (stack - stack_before)', () => {
    expect(sql).toMatch(/bool_and\(x \? 'stack_before'/);
    expect(sql).toMatch(/v_target := round\(v_old \+ \(v_new - v_before\), 2\);/);
    expect(sql).toMatch(/negative stack for %/);
  });

  it('the identity is asserted on every write in delta mode: sum(delta) = inflow - rake - bbj', () => {
    expect(sql).toMatch(
      /v_expected := COALESCE\(p_inflow, 0\) - COALESCE\(p_rake, 0\) - COALESCE\(p_bbj, 0\);/
    );
    expect(sql).toMatch(/IF round\(v_delta_sum - v_expected, 2\) <> 0 THEN/);
  });

  it('a no-op suppressed by the trigger is not a failed write', () => {
    expect(sql).toMatch(/AND ts\.left_at IS NULL AND ts\.stack = v_target\)/);
    expect(sql).toMatch(/aaa_skip_noop_update/);
  });

  it('a credit the engine never saw is preserved and recorded', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.ca_seat_stack_rebases/);
    expect(sql).toMatch(/INSERT INTO public\.ca_seat_stack_rebases/);
  });

  it('credit_club_rake_to_treasury honours the declared counterparty', () => {
    const fn = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.credit_club_rake_to_treasury'),
      sql.indexOf('-- 2. The rebase register')
    );
    expect(fn).toMatch(/current_setting\('app\.ledger_counterparty', true\)/);
    expect(fn).toMatch(/v_from_type\s+text := 'table_stack';/);
  });

  it('the restoration door is keyed, issues from the reserve, and refuses a replay', () => {
    const fn = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_restore_erased_seat_credit(')
    );
    expect(fn).toMatch(/INSERT INTO public\.wallet_credit_idempotency \(key, user_id, amount\)/);
    expect(fn).toMatch(/'already_restored'/);
    expect(fn).toMatch(/fn_ca_declare_ledger\('refund', 'issuance_reserve'/);
    expect(fn).toMatch(/INSERT INTO public\.ca_mint_ledger/);
  });

  it('the restoration repays the wallet that was debited, and the deploy-gap sweep retires itself', () => {
    const files = readdirSync(migrationsDir);
    const restore = files.find((f) => /^\d{14}_restore_erased_seat_credits\.sql$/.test(f));
    const sweep = files.find((f) => /^\d{14}_erased_seat_credit_sweep_self_retiring\.sql$/.test(f));
    expect(restore).toBeTruthy();
    expect(sweep).toBeTruthy();
    const r = readFileSync(resolve(migrationsDir, restore as string), 'utf8');
    // The wallet is the club on the add-on's own ledger leg, never the seat's club first.
    expect(r).toMatch(/AS debited_club/);
    expect(r).toMatch(/COALESCE\(c\.debited_club,/);
    // The numbers are asserted before a chip moves and re-checked after.
    expect(r).toMatch(/restoration list does not match the probe/);
    expect(r).toMatch(/left no journal or register row/);
    const w = readFileSync(resolve(migrationsDir, sweep as string), 'utf8');
    expect(w).toMatch(/cron\.unschedule\('ca-erased-seat-credit-sweep'\)/);
    expect(w).toMatch(/v_absolute_hands = 0/);
    expect(w).toMatch(
      /SET statement_timeout = '840s'; SELECT public\.fn_ca_erased_seat_credit_sweep\(\);/
    );
  });

  it('a seat that left during the hand is settled against its wallet, keyed, never refused whole', () => {
    const file = readdirSync(migrationsDir).find((f) =>
      /^\d{14}_a_seat_that_left_mid_hand_is_settled_not_refused\.sql$/.test(f)
    );
    expect(file).toBeTruthy();
    const m = readFileSync(resolve(migrationsDir, file as string), 'utf8');
    expect(m).toMatch(/'late_seat_settle:' \|\| v_hand::text \|\| ':' \|\| v_dep\.user_id::text/);
    expect(m).toMatch(
      /fn_ca_declare_ledger\('settlement', 'table_stack', p_table_id, v_ca_id, v_dep_key, NULL\)/
    );
    expect(m).toMatch(/COALESCE\(m\.chip_balance, 0\) \+ v_dep\.delta >= 0/);
    // Absolute mode (no stack_before) still refuses a missing seat.
    expect(m).toMatch(
      /RAISE EXCEPTION 'seat missing or left for % - hand write rejected whole', v_uid;/
    );
    // CASH TABLES ONLY. Tournament chips are play chips: the guard landed in
    // 20260904130701 after the first ten minutes of delta mode debited 230
    // tournament chips from a real wallet. The live definition is what the
    // engine calls, so the pin reads the latest re-creation of the function.
    const latest = readdirSync(migrationsDir)
      .filter((f) => /^\d{14}_.*\.sql$/.test(f))
      .sort()
      .reverse()
      .find((f) =>
        /CREATE (OR REPLACE )?FUNCTION public\.fn_ca_settle_hand_stacks_absolute\(/.test(
          readFileSync(resolve(migrationsDir, f), 'utf8')
        )
      );
    const live = readFileSync(resolve(migrationsDir, latest as string), 'utf8');
    expect(live).toMatch(
      /IF v_delta_mode AND NOT EXISTS \(SELECT 1 FROM public\.tables tb WHERE tb\.id = p_table_id AND tb\.tournament_id IS NOT NULL\) THEN/
    );
  });

  it('the detector is conservative: same players, felt moved by exactly -rake-bbj, one credit, no other movement', () => {
    const fn = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_find_erased_seat_credits(')
    );
    expect(fn).toMatch(/p\.same_players AND p\.prev_felt IS NOT NULL/);
    expect(fn).toMatch(/round\(p\.felt - p\.prev_felt \+ p\.rake_amount \+ p\.bbj, 2\) = 0/);
    expect(fn).toMatch(/exactly one credit in the window/);
    expect(fn).toMatch(/no other seat movement on the table between the hands/);
  });

  it('the detector never reports a boundary settled in delta mode: the delta write preserves what memory missed', () => {
    // 2026-09-04 15:20-18:20 UTC: the sweep restored 15 credits (3,867.99) that
    // delta mode had already preserved, because hand_history shows the engine's
    // memory, not the row. The correction excludes any boundary whose hand has a
    // delta-mode settlement row, and the sweep is gone: no cron where a
    // structural guarantee exists.
    const file = readdirSync(migrationsDir).find((f) =>
      /^\d{14}_the_erasure_detector_knows_delta_mode_and_the_sweep_retires\.sql$/.test(f)
    );
    expect(file).toBeTruthy();
    const m = readFileSync(resolve(migrationsDir, file as string), 'utf8');
    expect(m).toMatch(
      /s\.hand_id = md5\('ca-hand:' \|\| p\.table_id::text \|\| ':' \|\| p\.hand_number::text\)::uuid\s+AND s\.totals->>'mode' = 'delta'/
    );
    expect(m).toMatch(/DROP FUNCTION IF EXISTS public\.fn_ca_erased_seat_credit_sweep\(\);/);
    expect(m).toMatch(/IF v_n <> 15 OR v_sum <> 3867\.99 THEN/);
    expect(m).toMatch(/10\.9 rule 3/);
  });
});
