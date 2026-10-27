/** Actual runtime/control boundaries; reconstructed historical public geometry
 * plus explicitly SYNTHETIC qualification and accepted-hand controls, never a
 * natural fleet or historical exact-production certificate. */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  guardTestAdmission,
  GUARD_TEST_NOW,
} from '../HorseTournamentCatastropheGuardAuthority.test-support.js';
import { CATASTROPHE_GUARD_VERSION } from '../HorseTournamentCatastropheGuard.js';
import { liveHorsePhase8GuardAuthority } from '../HorseTournamentCatastropheGuardAuthority.js';
import { PHASE8_GUARD_PROTECTED_RELEASE_SELECTION } from '../HorseTournamentCatastropheGuardSelection.js';
import { HorsePhase8AuthorityGate } from '../HorseQualifiedAuthority.js';
import { recheckHorsePhase8GuardBeforeAcceptance } from '../HorsePhase8GuardAcceptance.js';
import { HORSE_POLICY_ORDER } from '../HorsePolicyGraph.js';
import { horseDecisionReceiptIsValid } from './responseValidation.js';
import { saveFastRandom } from '../HorseEval.js';
import {
  buildHorseDecisionKey,
  type HorseDecisionWorkerRequest,
  type HorseDecisionWorkerResponse,
  type FastHorseDecisionResult,
} from './protocol.js';
import { LiveHorseDecisionWorkerClient, type WorkerLike } from './client.js';
import {
  withFrozenHorseReplayClock,
  exactReplayHorseDecisionRecord,
} from './replay/exactReplay.js';
import { qualifiedReplayAdmissions } from './replay/qualifiedAuthority.js';
import {
  journalHash,
  horseJournalJson,
  makeHorseJournalRecord,
} from '../../services/horseDecisionJournal/record.js';
import {
  guardLiveRequest,
  guardLiveHarness,
  runGuardLiveFast,
  runGuardLiveDeep,
  guardLiveJournalFixture,
  GUARD_LIVE_TEST_SOURCE,
} from './phase8GuardLive.test-support.js';
import type { HorseDecision } from '../../types.js';

afterEach(() => vi.restoreAllMocks());
function assertGraph(decision: HorseDecision) {
  const graph = decision.policyGraph!,
    guard = decision.tournamentCatastropheGuard!;
  expect(graph.transitions.map((row) => row.node)).toEqual([...HORSE_POLICY_ORDER]);
  const node = graph.transitions.find((row) => row.node === 'tournament_continuation')!;
  expect(node.before).toEqual({ action: guard.baselineAction, amount: guard.baselineAmount });
  expect(node.after).toEqual({ action: guard.candidateAction, amount: guard.candidateAmount });
  for (let index = 1; index < graph.transitions.length; index++)
    expect(graph.transitions[index]!.before).toEqual(graph.transitions[index - 1]!.after);
  expect(graph.finalAction).toEqual({ action: decision.action, amount: decision.amount ?? null });
  expect(guard).toMatchObject({
    version: CATASTROPHE_GUARD_VERSION,
    policyFamily: 'catastrophe_guard_v1',
    workKind: 'phase7_candidate_guard',
    futureGame: null,
    baselineFutureGame: null,
    simulationMs: 0,
    guardWork: { assessmentCompleted: true },
  });
  expect(guard.work.rollouts).toBe(0);
  expect(guard.work.outcomeSamples).toBe(0);
}
function testGate() {
  const gate = new HorsePhase8AuthorityGate(
    () => guardTestAdmission(),
    'guard-main-test',
    CATASTROPHE_GUARD_VERSION
  );
  gate.refresh();
  for (const key of [
    'refresh',
    'check',
    'observeWorker',
    'stamp',
    'forgetWorker',
    'mainAuthority',
  ] as const)
    vi.spyOn(liveHorsePhase8GuardAuthority, key).mockImplementation(
      (gate[key] as Function).bind(gate)
    );
  return gate;
}
describe('genuine-only Phase8 guard in live decision graph', () => {
  it('null selection and a caller-forged family cannot activate the new guard', async () => {
    expect(PHASE8_GUARD_PROTECTED_RELEASE_SELECTION).toBeNull();
    for (const forged of [false, true]) {
      const request = guardLiveRequest();
      if (forged) {
        request.opts = { ...request.opts, phase8PolicyFamily: 'catastrophe_guard_v1' } as never;
        request.decisionKey = buildHorseDecisionKey(request);
      }
      const h = guardLiveHarness(null),
        result = await runGuardLiveFast(h, request);
      expect(result.decision.tournamentCatastropheGuard).toBeUndefined();
      expect(h.decisionOptions[0]!.phase8PolicyFamily).toBe('continuation_v2');
      expect(result.phase8GuardAuthority?.state).toBe('unselected');
    }
  });
  it('FAST and retained DEEP traverse the same real internal graph and preserve original inputs', async () => {
    const request = guardLiveRequest(),
      h = guardLiveHarness(),
      before = journalHash(horseJournalJson(request)),
      rng = saveFastRandom();
    const fast = await runGuardLiveFast(h, request),
      deep = await runGuardLiveDeep(h, request, fast);
    expect(fast.decision.tournamentCatastropheGuard).toMatchObject({
      applied: true,
      selection: 'selected',
    });
    for (const result of [fast, deep]) {
      assertGraph(result.decision);
      expect(result.phase8GuardAuthority?.state).toBe('usable');
      expect(result.decision.tournamentCatastropheGuard?.authority).toEqual(
        result.phase8GuardAuthority
      );
      expect(
        horseDecisionReceiptIsValid(result.decision, 'nlh', {
          player: request.player,
          gameState: request.gameState,
        })
      ).toBe(true);
    }
    expect(h.captures).toHaveLength(2);
    expect(
      h.captures.every(
        (row) => row.body.replayState.admission.phase8CatastropheGuard === 'candidate'
      )
    ).toBe(true);
    expect(h.captures[0]!.body.readFrame.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(journalHash(horseJournalJson(request))).toBe(before);
    expect(saveFastRandom()).toBe(rng);
  });
  it('withdrawn worker authority turns a retained DEEP assessment to shadow', async () => {
    const request = guardLiveRequest(),
      h = guardLiveHarness(),
      fast = await runGuardLiveFast(h, request);
    h.holders.get('phase8_guard:')!.withdraw('synthetic_pending');
    const deep = await runGuardLiveDeep(h, request, fast);
    expect(deep.phase8GuardAuthority?.state).toBe('withdrawn');
    expect(deep.decision.tournamentCatastropheGuard).toMatchObject({
      mode: 'shadow',
      applied: false,
    });
  });
  it.each(['usable', 'withdrawn', 'restarted'] as const)(
    'actual same-turn acceptance helper enforces %s authority',
    async (state) => {
      const request = guardLiveRequest(),
        h = guardLiveHarness(),
        fast = await runGuardLiveFast(h, request),
        gate = testGate();
      gate.observeWorker(fast.phase8GuardAuthority!);
      if (state === 'withdrawn') gate.withdraw('synthetic_before_action');
      if (state === 'restarted') gate.forgetWorker(fast.phase8GuardAuthority!.epoch);
      const decision = structuredClone(fast.decision),
        guard = decision.tournamentCatastropheGuard!;
      expect(guard.applied).toBe(true);
      const selected = recheckHorsePhase8GuardBeforeAcceptance(decision, request);
      if (state === 'usable')
        expect(selected.tournamentCatastropheGuard?.authorityVerdict).toBe('usable');
      else {
        expect(selected.action).toBe(guard.baselineAction);
        expect(selected.amount ?? null).toBe(guard.baselineAmount);
        expect(selected.tournamentCatastropheGuard).toMatchObject({
          applied: false,
          selection: 'withdrawn_before_acceptance',
        });
      }
    }
  );
  it('codec and actual action-door helper reject an applied guard outside its original domain', async () => {
    const f = await guardLiveJournalFixture();
    testGate().observeWorker(f.result.phase8GuardAuthority!);
    for (const patch of [
      { gameMode: 'cash' },
      { communityCards2: [...f.request.gameState.communityCards] },
      { stage: 'preflop' },
    ]) {
      const snapshot = {
        ...f.request,
        gameState: { ...f.request.gameState, ...patch },
      } as typeof f.request;
      const decision = structuredClone(f.result.decision);
      expect(
        horseDecisionReceiptIsValid(decision, 'nlh', {
          player: snapshot.player,
          gameState: snapshot.gameState,
        })
      ).toBe(false);
      expect(
        recheckHorsePhase8GuardBeforeAcceptance(decision, snapshot).tournamentCatastropheGuard
          ?.applied
      ).toBe(false);
    }
  });
  it.each(['valid', 'missing_mirror', 'mismatched_mirror'] as const)(
    'actual client validates the worker guard mirror: %s',
    async (fault) => {
      testGate();
      const h = guardLiveHarness();
      let read = 0;
      class Bridge extends EventEmitter implements WorkerLike {
        constructor() {
          super();
          void h.runtime.start().then(() => this.flush());
        }
        flush() {
          while (read < h.messages.length) {
            const message = structuredClone(h.messages[read++]!);
            if (message.type === 'FAST_RESULT') {
              if (fault === 'missing_mirror') delete message.phase8GuardAuthority;
              if (fault === 'mismatched_mirror')
                message.phase8GuardAuthority = {
                  ...message.phase8GuardAuthority!,
                  epoch: 'different-worker-epoch',
                };
            }
            this.emit('message', message);
          }
        }
        postMessage(message: HorseDecisionWorkerRequest) {
          h.runtime.receive(structuredClone(message));
          void h.runtime.drain().then(() => this.flush());
        }
        async terminate() {
          return 0;
        }
      }
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => new Bridge() });
      try {
        const pending = withFrozenHorseReplayClock(GUARD_TEST_NOW, () =>
          client.decideFast(guardLiveRequest())
        );
        if (fault === 'valid') {
          const result = await pending;
          expect(result.decision.tournamentCatastropheGuard?.applied).toBe(true);
        } else await expect(pending).rejects.toThrow(/guard|receipt|authority/i);
      } finally {
        await client.stop();
      }
    }
  );
  it('exactly replays the real captured guard admission and refuses a changed original admission', async () => {
    vi.spyOn(qualifiedReplayAdmissions, 'admitPhase8GuardAuthority').mockImplementation(() =>
      guardTestAdmission()
    );
    const f = await guardLiveJournalFixture();
    expect(f.result.decision.tournamentCatastropheGuard!.policyMs).toBeGreaterThan(0);
    const exact = await exactReplayHorseDecisionRecord(f.decisionRecord, {
      runningSource: GUARD_LIVE_TEST_SOURCE,
      execution: f.executionRecord,
    });
    expect(exact.outcome, exact.firstDifference ?? '').toBe('replayed_exact');
    const body = JSON.parse(f.decisionRecord.body);
    body.replayState.admission.phase8CatastropheGuard = 'off';
    const changed = makeHorseJournalRecord(f.decisionRecord, body);
    const mismatch = await exactReplayHorseDecisionRecord(changed, {
      runningSource: GUARD_LIVE_TEST_SOURCE,
    });
    expect(mismatch.outcome).toMatch(/^non_replayable:admission:/);
    delete body.replayState.admission.phase8CatastropheGuard;
    const missing = await exactReplayHorseDecisionRecord(
      makeHorseJournalRecord(f.decisionRecord, body),
      { runningSource: GUARD_LIVE_TEST_SOURCE }
    );
    expect(missing.outcome).toMatch(/^non_replayable:admission:/);
  });
});
