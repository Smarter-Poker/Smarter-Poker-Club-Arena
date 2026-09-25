/** Actual current-source nested runtime probes. Fake transport and clock; no server boot. */
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import ts from 'typescript';
import { LifecycleDiagnostics } from '../services/LifecycleDiagnostics.ts';
import { leavePendingTerminalReason } from '../observability/LeavePendingDiagnostic.ts';
import { handStackBefore, requireHandSeatGeneration } from './handSeatGeneration.ts';
import { KillPotSchedule } from './KillPot.ts';
const readCurrent = (file) => fs.readFileSync(resolve(process.cwd(), 'src', file), 'utf8');
const base = readCurrent('engine/ServerTableEngineBase.ts'),
  settlement = readCurrent('engine/ServerTableEngineSettlement.ts');
function method(src, name) {
  const a = ts.createSourceFile('source.ts', src, ts.ScriptTarget.Latest, true);
  for (const c of a.statements.filter(ts.isClassDeclaration)) {
    const m = c.members.find((x) => x.name?.getText(a) === name);
    if (m) return m.getText(a);
  }
  throw Error(name);
}
const methods = [
  'isTransientDbError',
  'isRolledBackSerializationRefusal',
  'lifecycleCanMutate',
  'recordLeavePendingGuard',
  'recordLifecycleDiagnostic',
  'killForRestart',
  'fenceTerminalEngine',
].map((n) => method(base, n));
const uuid = 'abcdef00-0000-4000-8000-000000000001';
function harness(sequence, { rootB = false, onSleep, onRpc, retainSequence } = {}) {
  const calls = [],
    alerts = [],
    sleeps = [],
    phases = [],
    finish = [],
    references = [],
    retainedRequests = [],
    order = [];
  let probe;
  const post = method(settlement, 'postHandTasks');
  const hh = readCurrent('services/supabase/handHistory.ts');
  const ha = ts.createSourceFile('hh.ts', hh, ts.ScriptTarget.Latest, true);
  const hfunctions = ['logHandHistory', 'insertHandHistoryRow', 'tournamentStackProofIsExact'].map(
    (n) =>
      ha.statements
        .find((x) => ts.isFunctionDeclaration(x) && x.name?.text === n)
        .getText(ha)
        .replace(/^export /, '')
  );
  const retry = ha.statements
    .find(
      (x) =>
        ts.isVariableStatement(x) &&
        x.declarationList.declarations.some(
          (d) => d.name.getText(ha) === 'HAND_COMMIT_RETRY_DELAYS_MS'
        )
    )
    .getText(ha)
    .replace(/^export /, '');
  const context = {
    Error,
    Map,
    Set,
    Promise,
    Date,
    Math,
    Number,
    Boolean,
    String,
    Object,
    performance: { now: () => 0 },
    console: { log() {}, error() {}, warn() {} },
    INSTANCE_ID: 'instance',
    POST_COMMIT_DRAIN_BUDGET_MS: 20000,
    randomUUID: () => uuid,
    cents: (n) => n,
    assertDiamondAcceptedHand() {},
    selectRevealedShowdownResults: () => [],
    buildDailyMissionHandEvents: () => [],
    handStackBefore,
    requireHandSeatGeneration,
    describeError: (e) => e?.message ?? String(e),
    reportError() {},
    raiseFinancialAlert: async (...args) => alerts.push(args),
    EngineMetrics: {
      settlementStepCount: { inc() {} },
      settlementStepDuration: { inc() {} },
      settlementStepSlow: { inc() {} },
    },
    AUTOMATIC_RECOVERY_EVENT_CLASS: 'automatic',
    leavePendingTerminalReason,
    structuredClone,
    setTimeout: (fn, ms) => {
      sleeps.push(ms);
      onSleep?.(probe, sleeps.length);
      queueMicrotask(fn);
      return 0;
    },
    supabase: {
      rpc: async (name, payload) => {
        order.push(name);
        if (name === 'fn_ca_retain_hand_submission') {
          retainedRequests.push(structuredClone(payload.p_request));
          const supplied = retainSequence?.[retainedRequests.length - 1];
          if (supplied instanceof Error) throw supplied;
          return supplied ?? { data: { retained: true, submission_id: uuid, request_hash: 'b'.repeat(64) }, error: null };
        }
        assert(['fn_ca_commit_hand_submission', 'fn_ca_commit_hand_settlement'].includes(name));
        calls.push(structuredClone(payload));
        references.push(payload);
        onRpc?.(probe, calls.length);
        const result = sequence[Math.min(calls.length - 1, sequence.length - 1)];
        if (result instanceof Error) throw result;
        if (result?.data?.success === true) probe.running = false;
        return result;
      },
    },
    wakeHandProjection: async () => {},
    getLiveHorseDecisionWorker: () => ({ observeCompletedHand: async () => {} }),
    readScopeOf: () => ({}),
    writeHandFacts: async () => {},
    recordHorseHandReviews: async () => {},
    processHandPostCommitObligations: async () => ({ ok: true }),
  };
  const code = `${retry}\n${hfunctions.join('\n')}\nclass Probe {static isCurrentEngineFor(){return false;} ${methods.join('\n')} ${post}};const ServerTableEngineBase=Probe;globalThis.Probe=Probe;`;
  vm.runInNewContext(
    ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    context
  );
  probe = new context.Probe();
  Object.assign(probe, {
    running: true,
    terminal: false,
    lifecycleDiagnostics: new LifecycleDiagnostics(),
    lifecycleDiagnosticWriteFailures: 0,
    tableId: uuid,
    handCount: 42,
    currentHandVariant: 'nlh',
    currentHandPotSize: 0,
    currentHandRake: 0,
    currentHandBBJFee: 0,
    currentHandStartedAt: 1000,
    currentHandInsuranceNet: 0,
    currentHandDealerSeat: 1,
    currentHandPots: [],
    currentHandCommunityCards: [],
    currentHandCommunityCards2: [],
    currentHandCommunityCards3: [],
    currentHandRitExtraBoards: [],
    currentHandWinners: [],
    currentHandActions: [],
    currentHandPerPotAwards: [],
    currentHandWinnersByBoard: [],
    currentHandShowdownResults: [],
    currentHandInsuranceSettlements: [],
    currentHandContributions: new Map(),
    currentHandHoleCards: new Map(),
    currentHandCashoutRedirects: new Map(),
    currentHandReturnedUncalled: new Map(),
    currentHandDealtStacks: new Map([[uuid, 100]]),
    // Kill pots (kill-v1): postHandTasks binds this hand's id into the table's
    // pending kill. The real engine field, empty: a hand with no kill facts.
    killSchedule: new KillPotSchedule(),
    currentHandKillRecord: null,
    currentHandSeatGenerations: new Map([
      [uuid, { seat_id: uuid, seat_joined_at: '2026-09-12T00:00:00.123456Z' }],
    ]),
    tableInfo: {
      club_id: uuid,
      game_variant: 'nlh',
      arena: { asset: 'chips' },
      small_blind: 1,
      big_blind: 2,
    },
    timeBankEngine: { getUsesRemaining: () => 1, getRemainingSeconds: () => 10 },
    engineLeaseAuthorityIsCurrent: () => true,
    isCurrentEngine: () => true,
    isTournamentTable: () => false,
    getEngineLeaseAuthority: () => ({ verified: true, generation: uuid }),
    hasCurrentEngineLeaseAuthority: () => true,
    setLoopPhase: (s) => phases.push(s),
    isMuckedAtShowdown: () => false,
    getMaxBuyIn: () => 200,
    vpipFloor: () => 0,
    humansSeated: () => 1,
    tableFormat: () => 'cash',
    sleep: async (ms) => sleeps.push(ms),
    clearEngineLeaseExpiryTimer() {},
    clearUnclaimedTournamentMovePauses() {},
    releasePendingPauseWait() {},
    settleReady() {},
    clearHandSafetyTimer() {},
    clearLooseHandTimers() {},
    signalRestartRequired() {},
    recordRecoveryEvent() {},
    finishTerminalBoundaryPersistence() {},
    finishF06AcceptedHand: async (...args) => finish.push(args),
    f06CurrentPermit: rootB ? { original: true } : null,
  });
  return {
    p: probe,
    calls,
    references,
    retainedRequests,
    order,
    alerts,
    sleeps,
    phases,
    finish,
    run: () =>
      probe.postHandTasks(
        [{ user_id: uuid, username: 'player', seat_number: 1, stack: 100, is_horse: false }],
        1
      ),
  };
}
const rollback = (sqlstate = '40001') => ({
  data: {
    success: false,
    atomic_hand_commit: false,
    reason: 'atomic_hand_rolled_back',
    sqlstate,
    error: 'F06_RETRY_CANONICAL_LANE',
    table_id: uuid,
    hand_number: 42,
    commit_hash: 'a'.repeat(64),
  },
  error: null,
});
const accepted = () => ({
  data: {
    success: true,
    atomic_hand_commit: true,
    history_id: uuid,
    post_commit_obligations: true,
    submission_id: uuid,
    submission_hash: 'b'.repeat(64),
    snapshot_completed: true,
  },
  error: null,
});
test('durable original is acknowledged before the receipt-only financial call', async () => {
  const h = harness([accepted()], { rootB: true });
  await h.run();
  assert.deepEqual(h.order, ['fn_ca_retain_hand_submission', 'fn_ca_commit_hand_submission']);
  assert.equal(h.retainedRequests.length, 1);
  assert.equal(h.retainedRequests[0].p_hand_row.id, uuid);
  assert.deepEqual(h.calls[0], {
    p_submission_id: uuid,
    p_instance_id: 'instance',
    p_lease_generation: h.retainedRequests[0].p_lease_generation,
  });
});
test('semantic XX000 refusal preserves full original while retaining unresolved custody', async () => {
  const h = harness([rollback('XX000')], { rootB: true });
  await assert.rejects(h.run());
  assert.equal(h.retainedRequests.length, 1);
  assert.equal(h.retainedRequests[0].p_hand_row.id, uuid);
  assert(h.retainedRequests[0].p_hand_row._accepted_post_commit_facts);
  assert(h.retainedRequests[0].p_post_commit_obligations);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.sleeps, []);
  assert.equal(h.finish.length, 0);
  assert(h.p.f06CurrentPermit);
});
test('lost retention acknowledgement repeats original retention before any financial call', async () => {
  const h = harness([accepted()], { retainSequence: [new Error('retention response lost')] });
  await h.run();
  assert.deepEqual(h.order, ['fn_ca_retain_hand_submission', 'fn_ca_retain_hand_submission', 'fn_ca_commit_hand_submission']);
  assert.deepEqual(h.retainedRequests[0], h.retainedRequests[1]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.sleeps, [200]);
});
test('malformed retention acknowledgement cannot dispatch settlement', async () => {
  const h = harness([accepted()], { retainSequence: [{ data: { retained: true, submission_id: 'wrong' }, error: null }] });
  await assert.rejects(h.run());
  assert.equal(h.calls.length, 0);
  assert.equal(h.finish.length, 0);
});
test('accepted-looking response without atomic snapshot acknowledgement cannot release custody', async () => {
  const reply = accepted();
  delete reply.data.snapshot_completed;
  const h = harness([reply], { rootB: true });
  await assert.rejects(h.run());
  assert.equal(h.calls.length, 1);
  assert.equal(h.finish.length, 0);
  assert(h.p.f06CurrentPermit);
});
for (const sqlstate of ['40001', '40P01'])
  test(
    sqlstate + ' retries actual nested commit boundary without engine kill or callback recapture',
    async () => {
      const h = harness([rollback(sqlstate), accepted()], {
        rootB: true,
        onRpc: (p, n) => {
          if (n === 1) {
            p.tableInfo.big_blind = 999;
            p.getMaxBuyIn = () => 9999;
            p.currentHandRake = 999;
          }
        },
      });
      await h.run();
      assert.equal(h.calls.length, 2);
      assert.deepEqual(h.calls[0], h.calls[1]);
      assert.strictEqual(h.references[0], h.references[1]);
      assert.equal(h.retainedRequests[0].p_hand_row.big_blind, 2);
      assert.equal(h.retainedRequests.length, 1);
      assert.equal(h.p.terminal, false);
      assert.deepEqual(h.sleeps, [250]);
      assert.deepEqual(h.finish, [['42', uuid]]);
    }
  );
test('first-attempt acceptance completes original F06 custody without a retry', async () => {
  const h = harness([accepted()], { rootB: true });
  await h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(h.sleeps.length, 0);
  assert.equal(h.p.terminal, false);
  assert.deepEqual(h.finish, [['42', uuid]]);
});
test('two confirmed rollback retries exhaust with original permit retained', async () => {
  const h = harness([rollback()], { rootB: true });
  await assert.rejects(h.run());
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.sleeps, [250, 1000]);
  assert.equal(h.finish.length, 0);
  assert(h.p.f06CurrentPermit);
  assert.equal(h.p.terminal, true);
});
test('lost response remains unknown and uses existing identical-payload path', async () => {
  const h = harness([new Error('fetch failed'), accepted()], { rootB: true });
  await h.run();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0], h.calls[1]);
  assert.deepEqual(h.sleeps, [200]);
  assert.deepEqual(h.finish, [['42', uuid]]);
});
test('mixed unknown response and confirmed rollback do not reset or recapture intent', async () => {
  const h = harness([new Error('fetch failed'), rollback(), accepted()]);
  await h.run();
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls[0], h.calls[2]);
  assert.deepEqual(h.sleeps, [200, 250]);
});
for (const field of [
  'sqlstate',
  'atomic_hand_commit',
  'reason',
  'table_id',
  'hand_number',
  'commit_hash',
])
  test('malformed/conflicting rollback ' + field + ' remains terminal', async () => {
    const raw = rollback();
    raw.data[field] =
      field === 'atomic_hand_commit' ? true : field === 'sqlstate' ? '23505' : 'wrong';
    const h = harness([raw, accepted()]);
    await assert.rejects(h.run());
    assert.equal(h.calls.length, 1);
    assert.equal(h.sleeps.length, 0);
  });
test('lease loss during rollback wait prevents another RPC', async () => {
  const h = harness([rollback(), accepted()], {
    onSleep: (p) => {
      p.hasCurrentEngineLeaseAuthority = () => false;
    },
  });
  await assert.rejects(h.run());
  assert.equal(h.calls.length, 1);
  assert.equal(h.p.terminal, true);
});
test('unknown outcomes retain existing13-attempt cap, never gain outer callback replay', async () => {
  const h = harness([new Error('fetch failed')]);
  await assert.rejects(h.run());
  assert.equal(h.calls.length, 13);
  assert.equal(h.sleeps.length, 12);
  assert(h.calls.every((x) => JSON.stringify(x) === JSON.stringify(h.calls[0])));
});
test('raw SQLSTATE error remains unknown in existing inner transport path', async () => {
  const h = harness([
    { data: null, error: { code: '40001', message: 'could not serialize access' } },
    accepted(),
  ]);
  await h.run();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.sleeps, [200]);
  assert.deepEqual(h.calls[0], h.calls[1]);
});
test('rollback at final global attempt cannot exceed existing13-call ceiling', async () => {
  const h = harness([
    ...Array.from({ length: 12 }, () => new Error('fetch failed')),
    rollback(),
    accepted(),
  ]);
  await assert.rejects(h.run());
  assert.equal(h.calls.length, 13);
  assert.equal(h.sleeps.length, 12);
});
test('invalid accepted receipt never consumes original F06 permit', async () => {
  const result = accepted();
  result.data.history_id = 'abcdef00-0000-4000-8000-000000000099';
  const h = harness([result], { rootB: true });
  await assert.rejects(h.run());
  assert.equal(h.calls.length, 1);
  assert.equal(h.finish.length, 0);
  assert(h.p.f06CurrentPermit);
});
test('exhausted rollback reports zero mutable callback retry budget', async () => {
  const h = harness([rollback()]);
  await assert.rejects(h.run());
  const alert = h.alerts.find((x) => x[1] === 'postHandTasks.hand_history_failed');
  assert.equal(alert[3].attempts, 1);
  assert.equal(alert[3].retry_budget, 0);
  assert.equal(h.calls.length, 3);
});
test('updated author budget assertions match candidate source and preserve leave budget', () => {
  const s = settlement,
    h = readCurrent('services/supabase/handHistory.ts');
  assert.doesNotMatch(s, /hand_history:\s*[1-9]/);
  assert.match(h, /rollbackRetryDelays\s*=\s*\[250,\s*1_000\]/);
  assert.match(s, /STEP_RETRY[\s\S]{0,900}leave_pending:\s*2/);
  assert.match(s, /STEP_RETRY_BACKOFF_MS\s*=\s*\[250,\s*1_000\]/);
});
test('legacy rolled_back wording without qualified core envelope cannot trigger callback replay', async () => {
  const r = rollback();
  r.data.reason = 'rolled_back';
  delete r.data.sqlstate;
  delete r.data.commit_hash;
  const h = harness([r, accepted()]);
  await assert.rejects(h.run());
  assert.equal(h.calls.length, 1);
  assert.equal(h.sleeps.length, 0);
  assert.equal(h.p.terminal, true);
});
test('4453 diagnostic guard and final unproved-hand fence remain in current candidate', () => {
  const s = settlement;
  assert(s.includes('ServerTableEngineBase.isRolledBackSerializationRefusal(err)'));
  assert(s.includes("this.killForRestart('authoritative_hand_commit_not_proved');"));
  assert(
    s.indexOf('ServerTableEngineBase.isRolledBackSerializationRefusal(err)') <
      s.indexOf("const semantic = message.includes('atomic hand commit refused')")
  );
});
