import { performance } from 'node:perf_hooks';
import { HorseObserverReads } from '../../engine/horseDecision/observerReads.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
  retireHorseExecutionWitness,
} from '../../engine/HorseExecutionWitness.js';
import { captureHorseHandJournalContext } from '../../engine/HorseDecisionHandBinding.js';
import { encodeHorseDecisionReads } from '../../engine/HorseDecisionReadFrame.js';
import { HorseMind } from '../../engine/HorseMind.js';
import { HorseLogic } from '../../engine/HorseLogic.js';
import { saveFastRandom, restoreFastRandom, seedFastRandom } from '../../engine/HorseEval.js';
import type { HorseDecision } from '../../types.js';
import {
  buildHorseDecisionKey,
  type FastHorseDecisionRequest,
} from '../../engine/horseDecision/protocol.js';
import { jointPolicyFixture } from '../../engine/multiway/JointRangeFixture.test-support.js';
import {
  journalHash,
  horseJournalJson,
  makeHorseJournalRecord,
  type HorseJournalRecord,
} from './record.js';
import { HorseDecisionJournalStore } from './store.js';
import { runtimeHorseJournalArchiveOptions } from './config.js';
import {
  readHorseJournalFleet,
  validateHorseFleetPacket,
  chargeHorseFleetReadBudget,
  HORSE_FLEET_READ_LIMITS,
} from './fleet.js';
import { horsePlanBatchBindingFromRequest } from '../../engine/HorsePlanHandIdentity.js';
import { horseLifecycleRequestDigest } from './lifecycle.js';
import { horseDecisionReplayState } from '../../engine/horseDecision/replayState.js';
import { HorseFleetPhaseInterpreter } from './phaseProof.js';
import { runHorseJournalReview } from '../../scripts/horseJournalReview.js';
const table = '10000000-0000-4000-8000-000000000001',
  hand = '30000000-0000-4000-8000-000000000001',
  producer = '40000000-0000-4000-8000-000000000001';
const handKey = journalHash(`${table}:12:9`);
const turn = (x: any) =>
  journalHash(
    JSON.stringify([x.generation, x.fence, x.requestId, x.decisionKey, x.decisionTimeMs])
  );
function fixture(phase7 = false) {
  const raw = jointPolicyFixture('nlh', 1, phase7 ? 'tournament' : 'cash', 'preflop');
  const { hero, state } = JSON.parse(JSON.stringify(raw), (k, v) =>
    typeof v === 'string' && /^p[0-9]$/.test(v)
      ? `20000000-0000-4000-8000-00000000000${Number(v.slice(1)) + 1}`
      : v
  );
  state.toCall = phase7 ? 0 : 1;
  if (phase7) {
    state.legalActions = ['check'];
    state.minRaiseTo = null;
    state.maxRaiseTo = null;
    state.tournament.stackByUser = Object.fromEntries(
      state.players.map((player: { user_id: string; stack: number; totalInvested: number }) => [
        player.user_id,
        player.stack + player.totalInvested,
      ])
    );
  }
  const snapshot: FastHorseDecisionRequest = {
    type: 'DECIDE_FAST',
    requestId: 1,
    generation: 7,
    fence: `${table}:12:1:9:7`,
    decisionTimeMs: 1000,
    decisionKey: '',
    player: hero,
    gameState: state,
    style: 'balanced',
    handJournalContext: captureHorseHandJournalContext(state.actionHistory),
  };
  snapshot.decisionKey = buildHorseDecisionKey(snapshot);
  let decision: HorseDecision = { action: 'call', thinkTime: 50 };
  if (phase7) {
    const old = saveFastRandom();
    try {
      seedFastRandom(7300930);
      decision = HorseLogic.decide(
        hero,
        state,
        'balanced',
        {},
        {
          telemetry: false,
          mind: false,
          decisionTimeMs: 1000,
          v27GtoCharts: false,
          phase8Postflop: 'off',
          phase13Joint: 'off',
        }
      );
    } finally {
      restoreFastRandom(old);
    }
    if (!decision.tournamentUtility?.evidence) throw Error('supported utility not emitted');
  }
  const d = {
    snapshot,
    readFrame: encodeHorseDecisionReads(
      HorseMind.createSandbox(),
      state.players,
      HorseMind.handKeyOf(state.actionHistory)
    ),
    decision,
    effects: [],
    rngBefore: 1,
    rngAfter: 2,
    computeMs: 1,
    governorScale: 1,
    runtimePins: 'incomplete',
  };
  if (decision.tournamentUtility?.evidence)
    decision.tournamentUtility.readFrameSha256 = d.readFrame.sha256;
  if (decision.plo4Policy?.inputs) decision.plo4Policy.readFrameSha256 = d.readFrame.sha256;
  const w = createHorseExecutionWitness(snapshot, decision, {
    requestId: 1,
    lane: 'fast',
    computeMs: 1,
    governorScale: 1,
  });
  const record = {
    seat: hero.seat,
    userId: hero.user_id,
    action: decision.action,
    amount: phase7 ? (decision.amount ?? 0) : 1,
    timestamp: 1001,
    stage: 'preflop' as const,
  };
  settleHorseExecutionWitness(w, { applied: true, acceptedActions: [{ record, intended: true }] });
  const ordinal = state.actionHistory.length;
  const a = {
    type: 'OBSERVE_COMPLETED_HAND',
    requestId: 3,
    generation: 12,
    fence: `${table}:12:9:observe`,
    handKey: `${table}:12`,
    committedHandId: hand,
    bigBlind: state.bigBlind,
    actions: [
      ...state.actionHistory,
      {
        ...record,
        origin: 'horse_policy',
        publicNode: { version: 1, status: 'captured', actorSeat: hero.seat, street: 'preflop' },
        observationIdentity: {
          version: 1,
          status: 'bound',
          handId: hand,
          actionOrdinal: ordinal,
          observationId: `${hand}:${ordinal}`,
          sessionKey: 'a'.repeat(64),
        },
      },
    ],
  };
  const make = (
    kind: HorseJournalRecord['kind'],
    sequence: number,
    body: unknown,
    recordTurn = turn(snapshot)
  ) =>
    makeHorseJournalRecord(
      {
        producerId: producer,
        sequence,
        atMs: 2000,
        sourceRelease: 'a'.repeat(40),
        kind,
        handKey,
        turnKey: kind === 'accepted_hand' ? handKey : recordTurn,
      },
      body
    );
  const result = {
    d,
    w,
    a,
    make,
    rows: (): HorseJournalRecord[] => [
      make('decision', 1, result.d),
      make('execution', 2, result.w),
      make('accepted_hand', 3, result.a),
    ],
  };
  return result;
}
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const roster = () =>
  Array.from(
    { length: 1000 },
    (_, i) => `20000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`
  );
const packet = () => ({
  version: 1 as const,
  sourceSha: 'a'.repeat(40),
  window: { startUtc: '1970-01-01T00:00:00.000Z', endUtc: '1970-01-01T00:01:00.000Z' },
  horseIds: roster(),
  handKeys: [handKey],
});
function stored(shard = 0, phase7 = false) {
  const dir = mkdtempSync(join(tmpdir(), 'horse-fleet-'));
  dirs.push(dir);
  const f = fixture(phase7);
  const store = new HorseDecisionJournalStore(dir, {
    archive: runtimeHorseJournalArchiveOptions(dir, {}, { index: shard }),
  });
  store.appendBatch(f.rows());
  store.close();
  return { dir, f };
}
describe('finite private fleet accepted-decision reader', () => {
  it.each([false, true])(
    'retains only accepted validated pooled provenance, future=%s',
    (future) => {
      const f = fixture();
      const bank = new HorseObserverReads();
      bank.run(f.d.snapshot, () => {});
      const original = bank.receipt(f.d.snapshot)!;
      expect(original?.disposition).toBe('independent');
      Object.assign(f.d, {
        observerReads: {
          ...original,
          version: 3,
          individualVersion: original.version,
          disposition: 'pooled_public',
          pooledPublicProfiles: {
            version: 1,
            source: 'accepted_hand_public_profiles',
            availableAtMs: future ? 1001 : 100,
            digest: 'a'.repeat(64),
            profiles: 1,
          },
        },
      });
      const dir = mkdtempSync(join(tmpdir(), 'horse-fleet-public-'));
      dirs.push(dir);
      const store = new HorseDecisionJournalStore(dir, {
        archive: runtimeHorseJournalArchiveOptions(dir, {}),
      });
      store.appendBatch(f.rows());
      store.close();
      const result = readHorseJournalFleet(dir, packet());
      const horse = result.horses.find((h) => h.horseId === f.d.snapshot.player.user_id)!;
      expect(horse.retainedReceiptCounts.pooledPublicReads).toBe(future ? undefined : 1);
      expect(horse.retainedReceiptCounts.independentPublicReads).toBeUndefined();
      expect(result).toMatchObject({ allPhasesVerified: false, gtoVerified: false });
      expect(JSON.stringify(result)).not.toContain('pooledPublicProfiles');
    }
  );

  it('reports supported Phase7 baseline activation from a real utility receipt persisted in SQLite without a calibration claim', () => {
    const { dir, f } = stored(0, true);
    expect(f.d.decision.tournamentUtility!.evidence!.responseModel.calibration).toBe(
      'uncalibrated'
    );
    const result = readHorseJournalFleet(dir, packet());
    expect(result.gaps).toEqual({});
    expect(result.acceptedDecisions).toBe(1);
    expect(result.phaseEvidence.phase7).toMatchObject({
      qualification: { verified: 1 },
      application: { accepted: 1 },
      reasons: { supported_uncalibrated_utility_baseline: 1 },
    });
    expect(result).toMatchObject({ allPhasesVerified: false, gtoVerified: false });
  });

  it('joins phase evidence only to original accepted SQLite chains, retaining unknown gates and private output', () => {
    const { dir, f } = stored();
    const result = readHorseJournalFleet(dir, packet());
    const horse = result.horses.find((h) => h.horseId === f.d.snapshot.player.user_id)!;
    const order = result.phaseProofSchema.statusOrder;
    expect(horse.phaseStatusCounts.phase3![order.indexOf('applicable-active')]).toBe(1);
    expect(horse.phaseStatusCounts.phase5![order.indexOf('applicable-active')]).toBe(1);
    expect(horse.phaseStatusCounts.phase9![order.indexOf('unknown')]).toBe(1);
    expect(horse.phaseAcceptedApplications.phase5).toBe(1);
    expect(result.phaseEvidence.phase9).toMatchObject({ qualification: { unknown: 1 } });
    expect(result).toMatchObject({ allPhasesVerified: false, phaseQualification: 'unknown' });
    expect(Object.values(result.phaseGates).every((x) => x === 'unknown')).toBe(true);
    expect(
      result.horses
        .filter((h) => h.acceptedDecisions === 0)
        .every((h) => Object.keys(h.phaseStatusCounts).length === 0)
    ).toBe(true);
    for (const value of ['communityCards', 'readFrame', 'rngBefore', f.d.snapshot.fence])
      expect(JSON.stringify(result)).not.toContain(value);
    const wrong = packet();
    wrong.sourceSha = 'b'.repeat(40);
    const refused = readHorseJournalFleet(dir, wrong);
    expect(refused.horses.every((h) => Object.keys(h.phaseStatusCounts).length === 0)).toBe(true);
  });
  it('does not certify a forged corrective receipt even if a private record is hash-valid', () => {
    const { dir, f } = stored();
    (f.d.decision as any).correctivePolicy = {
      version: 'horse-corrective-live-kernel-v1',
      applied: true,
      authority: { state: 'usable' },
    };
    const extraDir = mkdtempSync(join(tmpdir(), 'horse-fleet-forged-'));
    dirs.push(extraDir);
    const store = new HorseDecisionJournalStore(extraDir, {
      archive: runtimeHorseJournalArchiveOptions(extraDir, {}),
    });
    store.appendBatch(f.rows());
    store.close();
    const result = readHorseJournalFleet(extraDir, packet());
    expect(result.acceptedDecisions).toBe(0);
    expect(result.allPhasesVerified).toBe(false);
    expect(result.horses.every((h) => Object.keys(h.phaseStatusCounts).length === 0)).toBe(true);
  });
  it.each([false, true])(
    'counts only accepted DEEP, preserving legacy unknown and explicit original FAST binding metadata=%s',
    (metadata) => {
      const dir = mkdtempSync(join(tmpdir(), 'horse-fleet-deep-'));
      dirs.push(dir);
      const f = fixture(),
        deepSnapshot = {
          ...f.d.snapshot,
          type: 'DECIDE_DEEP' as const,
          requestId: 2,
          rngBefore: f.d.rngBefore,
          deepEquity: 2,
        };
      const retired = createHorseExecutionWitness(f.d.snapshot, f.d.decision, {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      });
      retireHorseExecutionWitness(retired, 'second_look_replaced');
      const accepted = createHorseExecutionWitness(deepSnapshot, f.d.decision, {
        requestId: 2,
        lane: 'deep',
        computeMs: 1,
        governorScale: 1,
      });
      settleHorseExecutionWitness(accepted, {
        applied: true,
        acceptedActions: f.w.acceptedActions,
      });
      if (metadata) {
        const binding = horsePlanBatchBindingFromRequest(f.d.snapshot);
        Object.assign(f.d, {
          planBinding: binding,
          planContext: binding.planContext,
          lifecycleVersion: 1,
        });
        f.d.readFrame = encodeHorseDecisionReads(
          HorseMind.createSandbox(),
          f.d.snapshot.gameState.players,
          HorseMind.handKeyOf(f.d.snapshot.gameState.actionHistory),
          binding.planContext
        );
      }
      const capture: any = {
        ...f.d,
        snapshot: deepSnapshot,
        effects: [],
        originalFastBinding: {
          inputDigest: journalHash(horseJournalJson(f.d.snapshot)),
          readFrameDigest: journalHash(horseJournalJson(f.d.readFrame)),
        },
        replayState: horseDecisionReplayState(
          {
            phase8Postflop: 'shadow',
            phase10Plo4: 'shadow',
            phase11Omaha: 'shadow',
            phase12Remaining: 'shadow',
            phase13Joint: 'shadow',
          },
          null
        ),
      };
      if (metadata) capture.planBinding = null;
      if (!metadata) {
        delete capture.effects;
        delete capture.replayState;
        delete capture.originalFastBinding;
      }
      const store = new HorseDecisionJournalStore(dir, {
        archive: runtimeHorseJournalArchiveOptions(dir, {}),
      });
      const lifecycle = (
        snapshot: typeof f.d.snapshot | typeof deepSnapshot,
        phase: 'requested' | 'terminal'
      ) =>
        phase === 'requested'
          ? {
              version: 1,
              phase,
              request: snapshot,
              requestDigest: horseLifecycleRequestDigest(snapshot),
              origin: 'worker_compute',
            }
          : {
              version: 1,
              phase,
              requestDigest: horseLifecycleRequestDigest(snapshot),
              outcome: 'success',
            };
      store.appendBatch(
        metadata
          ? [
              f.make('request_lifecycle', 1, lifecycle(f.d.snapshot, 'requested')),
              f.make('decision', 2, f.d),
              f.make('request_lifecycle', 3, lifecycle(f.d.snapshot, 'terminal')),
              f.make('execution', 4, retired),
              f.make(
                'request_lifecycle',
                5,
                lifecycle(deepSnapshot, 'requested'),
                turn(deepSnapshot)
              ),
              f.make('decision', 6, capture, turn(deepSnapshot)),
              f.make(
                'request_lifecycle',
                7,
                lifecycle(deepSnapshot, 'terminal'),
                turn(deepSnapshot)
              ),
              f.make('execution', 8, accepted, turn(deepSnapshot)),
              f.make('accepted_hand', 9, f.a),
            ]
          : [
              f.make('decision', 1, f.d),
              f.make('execution', 2, retired),
              f.make('decision', 3, capture, turn(deepSnapshot)),
              f.make('execution', 4, accepted, turn(deepSnapshot)),
              f.make('accepted_hand', 5, f.a),
            ]
      );
      store.close();
      const result = readHorseJournalFleet(dir, packet());
      expect(result.gaps).toEqual({});
      expect(result).toMatchObject({ acceptedDecisions: 1, reconciledHands: 1, gaps: {} });
      const horse = result.horses.find((h) => h.horseId === f.d.snapshot.player.user_id)!;
      expect(
        horse.phaseStatusCounts.phase5![
          result.phaseProofSchema.statusOrder.indexOf(metadata ? 'applicable-active' : 'unknown')
        ]
      ).toBe(1);
      expect(horse.phaseAcceptedApplications.phase5 ?? 0).toBe(metadata ? 1 : 0);
    }
  );
  it('retains the original aggregate budget refusal when phase qualification reaches its bound', () => {
    const { dir } = stored();
    const spy = vi
      .spyOn(HorseFleetPhaseInterpreter.prototype, 'interpret')
      .mockImplementation(() => {
        throw Error('bound_reached');
      });
    try {
      expect(readHorseJournalFleet(dir, packet())).toMatchObject({
        acceptedDecisions: 0,
        boundReached: true,
        captureUnfinished: true,
        gaps: { bound_reached: 1 },
      });
    } finally {
      spy.mockRestore();
    }
  });
  it('cannot turn an orphan self-declared applied receipt into phase15 application evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'horse-fleet-orphan-plan-'));
    dirs.push(dir);
    const f = fixture();
    const store = new HorseDecisionJournalStore(dir, {
      archive: runtimeHorseJournalArchiveOptions(dir, {}),
    });
    store.appendBatch([
      ...f.rows(),
      f.make('plan_receipt', 4, { disposition: 'applied', applicationVerified: true }),
    ]);
    store.close();
    const result = readHorseJournalFleet(dir, packet());
    expect(result.allPhasesVerified).toBe(false);
    expect(result.phaseEvidence.phase15!.application.accepted ?? 0).toBe(0);
    expect(result.horses.every((h) => (h.phaseAcceptedApplications.phase15 ?? 0) === 0)).toBe(true);
  });
  it('keeps the complete canonical private result below the original transport byte cap', () => {
    const { dir } = stored();
    const result = readHorseJournalFleet(dir, packet());
    const full = {
      ...result,
      horses: result.horses.map((h) => ({
        ...h,
        phaseStatusCounts: Object.fromEntries(
          Array.from({ length: 15 }, (_, i) => [
            `phase${i + 1}`,
            [10000, 10000, 10000, 10000, 0, 10000],
          ])
        ),
        phaseAcceptedApplications: Object.fromEntries(
          Array.from({ length: 15 }, (_, i) => [`phase${i + 1}`, 10000])
        ),
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThan(2 * 1024 * 1024);
  });
  it('reads archived SQLite/shards, reports absent horses and preserves private storage', () => {
    const { dir, f } = stored(1);
    const before = readFileSync(join(dir, 'horse-decisions.sqlite'));
    const result = readHorseJournalFleet(dir, packet());
    expect(result).toMatchObject({
      reconciledHands: 1,
      acceptedDecisions: 1,
      observedHorses: 1,
      unobservedHorses: 999,
      completeHorseCoverage: false,
      completePopulation: false,
      phaseQualification: 'unknown',
      gaps: {},
    });
    expect(
      result.horses.find((h) => h.horseId === f.d.snapshot.player.user_id)?.acceptedDecisions
    ).toBe(1);
    const output = JSON.stringify(result);
    for (const privateValue of ['readFrame', 'communityCards', 'rngBefore', f.d.snapshot.fence])
      expect(output).not.toContain(privateValue);
    expect(readFileSync(join(dir, 'horse-decisions.sqlite'))).toEqual(before);
  });
  it('refuses wrong source and out-of-window capture', () => {
    const { dir } = stored();
    const p = packet();
    p.sourceSha = 'b'.repeat(40);
    expect(readHorseJournalFleet(dir, p)).toMatchObject({
      acceptedDecisions: 0,
      gaps: { source_mismatch: 1 },
    });
    const outside = packet();
    outside.window = { startUtc: '1970-01-01T00:00:03.000Z', endUtc: '1970-01-01T00:01:00.000Z' };
    expect(readHorseJournalFleet(dir, outside)).toMatchObject({
      acceptedDecisions: 0,
      gaps: { capture_outside_window: 1 },
    });
  });
  it('deduplicates exact replay across archive shards', () => {
    const { dir, f } = stored();
    const once = readHorseJournalFleet(dir, packet()).validatedBytes;
    const store = new HorseDecisionJournalStore(dir, {
      archive: runtimeHorseJournalArchiveOptions(dir, {}, { index: 1 }),
    });
    store.appendBatch(f.rows());
    store.close();
    expect(readHorseJournalFleet(dir, packet())).toMatchObject({
      validatedBytes: 2 * once,
      acceptedDecisions: 1,
      observedHorses: 1,
      gaps: {},
    });
  });
  it('rejects conflicting same-event capture across shards', () => {
    const { dir, f } = stored();
    const conflict = f.make('decision', 1, { ...f.d, computeMs: 2 });
    expect(conflict.eventId).toBe(f.rows()[0]!.eventId);
    const store = new HorseDecisionJournalStore(dir, {
      archive: runtimeHorseJournalArchiveOptions(dir, {}, { index: 1 }),
    });
    store.append(conflict);
    store.close();
    expect(readHorseJournalFleet(dir, packet())).toMatchObject({
      acceptedDecisions: 0,
      gaps: { record_conflict: 1 },
    });
  });
  it('does not infer missing capture or current horse membership', () => {
    const { dir } = stored();
    const p = packet();
    p.handKeys = [journalHash('missing')];
    expect(readHorseJournalFleet(dir, p)).toMatchObject({
      acceptedDecisions: 0,
      observedHorses: 0,
      completeHorseCoverage: false,
    });
    const notRoster = packet();
    notRoster.horseIds = roster().map((id) => id.replace('20000000', '90000000'));
    expect(readHorseJournalFleet(dir, notRoster)).toMatchObject({
      acceptedDecisions: 0,
      gaps: { actor_outside_roster: 1 },
    });
  });
  it('enforces exact roster, UTC window and finite selection', () => {
    for (const change of [
      { horseIds: roster().slice(1) },
      { horseIds: [...roster().slice(1), roster()[1]] },
      { handKeys: Array(10001).fill(handKey) },
      { window: { startUtc: '2026-10-25', endUtc: '2026-10-26' } },
    ])
      expect(() => validateHorseFleetPacket({ ...packet(), ...change })).toThrow();
    expect(readHorseJournalFleet('/no-such-private-journal', packet())).toMatchObject({
      acceptedDecisions: 0,
      gaps: { storage_unavailable: 1 },
    });
  });
});

describe('fleet CLI private input boundary', () => {
  it('uses the existing command and emits no packet paths or captured payloads', () => {
    const { dir } = stored();
    const input = join(dir, 'private-roster.json');
    writeFileSync(input, JSON.stringify(packet()));
    const result = runHorseJournalReview(['--fleet', dir, input]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({
      observedHorses: 1,
      completePopulation: false,
    });
    expect(result.output).not.toContain(dir);
    expect(result.output).not.toContain('readFrame');
    expect(runHorseJournalReview(['--fleet', 'relative', input]).code).toBe(64);
    writeFileSync(input, 'x'.repeat(1024 * 1024 + 1));
    const oversized = runHorseJournalReview(['--fleet', dir, input]);
    expect(oversized.code).toBe(3);
    expect(oversized.output).not.toContain(dir);
  });
});

describe('fleet global observation budget', () => {
  it('stops on elapsed bound and retains uninspected hands as unknown', () => {
    const { dir } = stored();
    let calls = 0;
    const clock = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => (++calls === 1 ? 0 : 30001));
    try {
      expect(readHorseJournalFleet(dir, packet())).toMatchObject({
        boundReached: true,
        captureUnfinished: true,
        inspectedHands: 0,
        remainingHands: 1,
        completeHorseCoverage: false,
        gaps: { bound_reached: 1 },
        rosterVerified: false,
        horseCoverageScope: 'supplied_cohort_only',
      });
    } finally {
      clock.mockRestore();
    }
  });
});

describe('global budget owner charges duplicate validated bytes', () => {
  it('refuses at the unchanged64MiB ceiling and retains charged bytes', () => {
    const budget = {
      started: performance.now(),
      validatedBytes: HORSE_FLEET_READ_LIMITS.validatedBytes - 1,
    };
    expect(() => chargeHorseFleetReadBudget(budget, 2)).toThrow('bound_reached');
    expect(budget.validatedBytes).toBe(HORSE_FLEET_READ_LIMITS.validatedBytes + 1);
  });
});

describe('elapsed budget inside a catalog read', () => {
  it('breaks the outer hand loop instead of resetting budget on refusal', () => {
    const { dir } = stored();
    const p = packet();
    p.handKeys.push(journalHash('next-hand'));
    let calls = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (++calls <= 3 ? 0 : 30001));
    try {
      expect(readHorseJournalFleet(dir, p)).toMatchObject({
        boundReached: true,
        captureUnfinished: true,
        inspectedHands: 0,
        remainingHands: 2,
        acceptedDecisions: 0,
        gaps: { bound_reached: 1 },
      });
    } finally {
      clock.mockRestore();
    }
  });
});
