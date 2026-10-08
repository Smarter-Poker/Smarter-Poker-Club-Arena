import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
  retireHorseExecutionWitness,
  withdrawHorsePhase8Selection,
  withdrawHorsePhase10Selection,
  recordHorsePhase10Verdict,
  withdrawHorsePhase11Selection,
  recordHorsePhase11Verdict,
  withdrawHorsePhase12Selection,
  recordHorsePhase12Verdict,
  withdrawHorsePhase13Selection,
  recordHorsePhase13Verdict,
} from '../../engine/HorseExecutionWitness.js';
import { qualifiedPhase13TestAdmission } from '../../engine/HorsePhase13Authority.test-support.js';
import { horsePhase13ContinuationVersion } from '../../engine/HorsePhase13Authority.js';
import { qualifiedPhase10TestAdmission } from '../../engine/HorsePhase10Authority.test-support.js';
import { qualifiedPhase11TestAdmission } from '../../engine/HorsePhase11Authority.test-support.js';
import { OMAHA_VARIANT_PACKS } from '../../engine/omaha/OmahaVariantPolicyPack.js';
import { qualifiedPhase12TestAdmission } from '../../engine/HorsePhase12Authority.test-support.js';
import { REMAINING_VARIANT_PACKS } from '../../engine/remainingVariants/RemainingVariantPolicyPack.js';
import {
  captureHorseHandJournalContext,
  horsePriorActionsDigest,
} from '../../engine/HorseDecisionHandBinding.js';
import { encodeHorseDecisionReads } from '../../engine/HorseDecisionReadFrame.js';
import { HorseMind } from '../../engine/HorseMind.js';
import {
  HorseQualifiedAuthorityHolder,
  HorsePhase8AuthorityGate,
} from '../../engine/HorseQualifiedAuthority.js';
import { qualifiedTestAdmission } from '../../engine/HorseQualifiedAuthority.test-support.js';
import { HorseLogic } from '../../engine/HorseLogic.js';
import { saveFastRandom, restoreFastRandom, seedFastRandom } from '../../engine/HorseEval.js';
import type { HorseDecision } from '../../types.js';
import { horseTournamentUtilityReceiptIsValid } from '../../engine/horseDecision/responseValidation.js';
import {
  buildHorseDecisionKey,
  type FastHorseDecisionRequest,
} from '../../engine/horseDecision/protocol.js';
import { jointPolicyFixture } from '../../engine/multiway/JointRangeFixture.test-support.js';
import { journalHash, makeHorseJournalRecord, type HorseJournalRecord } from './record.js';
import { HorseDecisionJournalStore } from './store.js';
import {
  readHorseJournalHand,
  readHorseJournalHandRecords,
  reconcileHorseJournalHand,
  reviewHorsePlanEffects,
} from './review.js';
import {
  createHorsePlanEffectReceipt,
  type HorsePlanEffectReceipt,
} from '../../engine/HorsePlanEffectReceipt.js';
import {
  workerHarness as planWorkerHarness,
  commitOf as planCommitOf,
} from '../../testing/horseRegression/plan/fixture.js';
import { runtimeHorseJournalArchiveOptions } from './config.js';
import { doorRosterTransport } from '../horseAcceptedRoster/fixture.test-support.js';

const table = '10000000-0000-4000-8000-000000000001',
  hand = '30000000-0000-4000-8000-000000000001',
  producer = '40000000-0000-4000-8000-000000000001';
const handKey = journalHash(`${table}:12:9`);
const turn = (x: any) =>
  journalHash(
    JSON.stringify([x.generation, x.fence, x.requestId, x.decisionKey, x.decisionTimeMs])
  );
function fixture(
  variant: Parameters<typeof jointPolicyFixture>[0] = 'nlh',
  historyPrefix: readonly Record<string, unknown>[] = [],
  phase7 = false,
  phase10 = false,
  phase11 = false,
  phase12 = false,
  phase13 = false
) {
  const raw = jointPolicyFixture(variant, 1, phase7 ? 'tournament' : 'cash', 'preflop');
  const { hero, state } = JSON.parse(JSON.stringify(raw), (k, v) =>
    typeof v === 'string' && /^p[0-9]$/.test(v)
      ? `20000000-0000-4000-8000-00000000000${Number(v.slice(1)) + 1}`
      : v
  );
  state.toCall = phase7 || phase10 || phase11 || phase12 || phase13 ? 0 : 1;
  // The fixture's button is seat 4: the walk posts the blinds from seats 1 and 2.
  if (phase10 || phase11 || phase12) state.blindSeats = { smallBlind: 1, bigBlind: 2 };
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
    handJournalContext: captureHorseHandJournalContext([...historyPrefix, ...state.actionHistory]),
  };
  snapshot.decisionKey = buildHorseDecisionKey(snapshot);
  let decision: HorseDecision = { action: 'call', thinkTime: 50 };
  if (phase7) {
    const rng = saveFastRandom();
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
      restoreFastRandom(rng);
    }
    if (!decision.tournamentUtility?.evidence)
      throw Error('Phase 7 fixture did not evaluate utility');
  }
  if (phase10) {
    const rng = saveFastRandom();
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
          phase10EvidenceMode: true,
          phase8Postflop: 'off',
          phase13Joint: 'off',
        }
      );
    } finally {
      restoreFastRandom(rng);
    }
    if (!decision.plo4Policy?.inputs) throw Error('Phase 10 fixture did not bind its inputs');
  }
  if (phase11) {
    const rng = saveFastRandom();
    try {
      seedFastRandom(7301004);
      decision = HorseLogic.decide(
        hero,
        state,
        'balanced',
        {},
        {
          telemetry: false,
          mind: false,
          decisionTimeMs: 1000,
          phase11EvidenceMode: true,
          phase8Postflop: 'off',
          phase13Joint: 'off',
        }
      );
    } finally {
      restoreFastRandom(rng);
    }
    if (!decision.omahaVariantPolicy?.inputs)
      throw Error('Phase 11 fixture did not bind its inputs');
  }
  if (phase12) {
    const rng = saveFastRandom();
    try {
      seedFastRandom(7301205);
      decision = HorseLogic.decide(
        hero,
        state,
        'balanced',
        {},
        {
          telemetry: false,
          mind: false,
          decisionTimeMs: 1000,
          phase12EvidenceMode: true,
          phase8Postflop: 'off',
          phase13Joint: 'off',
        }
      );
    } finally {
      restoreFastRandom(rng);
    }
    if (!decision.remainingVariantPolicy?.inputs)
      throw Error('Phase 12 fixture did not bind its inputs');
  }
  if (phase13) {
    const rng = saveFastRandom();
    try {
      seedFastRandom(7301301);
      decision = HorseLogic.decide(
        hero,
        state,
        'balanced',
        {},
        {
          telemetry: false,
          mind: false,
          decisionTimeMs: 1000,
          phase8Postflop: 'off',
          phase10Plo4: 'off',
          phase11Omaha: 'off',
          phase12Remaining: 'off',
          phase13Joint: 'shadow',
          phase13EvidenceMode: true,
        }
      );
    } finally {
      restoreFastRandom(rng);
    }
    if (!decision.jointPolicy?.inputs) throw Error('Phase 13 fixture did not bind its inputs');
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
    amount: phase7 || phase10 || phase11 || phase12 || phase13 ? (decision.amount ?? 0) : 1,
    timestamp: 1001,
    stage: 'preflop' as const,
  };
  settleHorseExecutionWitness(w, { applied: true, acceptedActions: [{ record, intended: true }] });
  const ordinal = historyPrefix.length + state.actionHistory.length;
  const a = {
    type: 'OBSERVE_COMPLETED_HAND',
    requestId: 3,
    generation: 12,
    fence: `${table}:12:9:observe`,
    handKey: `${table}:12`,
    committedHandId: hand,
    bigBlind: state.bigBlind,
    actions: [
      ...historyPrefix,
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
const directory = () => {
  const d = mkdtempSync(join(tmpdir(), 'horse-review-test-'));
  dirs.push(d);
  return d;
};
describe('private retained-hand journal consumer', () => {
  it('reconciles actual Phase 7 utility evidence and its original read frame to acceptance', () => {
    const f = fixture('nlh', [], true);
    expect(
      horseTournamentUtilityReceiptIsValid(f.d.decision.tournamentUtility, f.d.decision),
      JSON.stringify(f.d.decision.tournamentUtility)
    ).toBe(true);
    expect(f.w.phase7Evidence?.inputSha256).toBe(
      f.d.decision.tournamentUtility!.evidence!.inputSha256
    );
    expect(f.w.phase7Evidence?.readFrameSha256).toBe(f.d.readFrame.sha256);
    expect(f.w.executionStatus).toBe('intended');
    const persisted = JSON.parse(f.rows()[0]!.body) as typeof f.d;
    const recovered = createHorseExecutionWitness(persisted.snapshot, persisted.decision, {
      requestId: 1,
      lane: 'fast',
      computeMs: 1,
      governorScale: 1,
    });
    expect(recovered.phase7Evidence).toEqual(f.w.phase7Evidence);
    expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
      status: 'reconciled',
      matchedActions: 1,
      gaps: [],
      replayVerified: false,
      gtoVerified: false,
      activationAllowed: false,
    });
  });

  it.each(['inputSha256', 'evidenceSha256'] as const)(
    'rejects a changed Phase 7 witness %s even when the accepted action still matches',
    (field) => {
      const f = fixture('nlh', [], true);
      f.w = { ...f.w, phase7Evidence: { ...f.w.phase7Evidence!, [field]: 'f'.repeat(64) } };
      const report = reconcileHorseJournalHand(f.rows(), handKey);
      expect(report.status).toBe('incomplete');
      expect(report.matchedActions).toBe(0);
      expect(report.gaps).toContain('input_mismatch');
    }
  );

  it('rejects a different valid read frame whose digest no longer owns the Phase 7 decision', () => {
    const f = fixture('nlh', [], true);
    const reads = HorseMind.createSandbox();
    HorseMind.runInSandbox(reads, () => {
      HorseMind.importStats([
        {
          user_id: f.d.snapshot.gameState.players[1]!.user_id,
          hands: 50,
          folds: 20,
          facedAggr: 30,
        },
      ]);
    });
    const changed = encodeHorseDecisionReads(
      reads,
      f.d.snapshot.gameState.players,
      HorseMind.handKeyOf(f.d.snapshot.gameState.actionHistory)
    );
    expect(changed.sha256).not.toBe(f.d.readFrame.sha256);
    f.d.readFrame = changed;
    expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
      status: 'incomplete',
      matchedActions: 0,
      gaps: expect.arrayContaining(['read_frame_unavailable']),
    });
  });

  it('reconciles the Phase 10 input binding and its original read frame to acceptance', () => {
    const f = fixture('plo4', [], false, true);
    expect(f.w.phase10Inputs?.readFrameSha256).toBe(f.d.readFrame.sha256);
    expect(f.w.phase10Inputs?.rangeStatus).toBe('not_consumed_preflop');
    const persisted = JSON.parse(f.rows()[0]!.body) as typeof f.d;
    const recovered = createHorseExecutionWitness(persisted.snapshot, persisted.decision, {
      requestId: 1,
      lane: 'fast',
      computeMs: 1,
      governorScale: 1,
    });
    expect(recovered.phase10Inputs).toEqual(f.w.phase10Inputs);
    expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
      status: 'reconciled',
      matchedActions: 1,
      gaps: [],
      gtoVerified: false,
      activationAllowed: false,
    });
  });

  it('rejects a changed Phase 10 input commitment even when the accepted action still matches', () => {
    const f = fixture('plo4', [], false, true);
    f.w = { ...f.w, phase10Inputs: { ...f.w.phase10Inputs!, inputSha256: 'f'.repeat(64) } };
    const report = reconcileHorseJournalHand(f.rows(), handKey);
    expect(report.status).toBe('incomplete');
    expect(report.matchedActions).toBe(0);
    expect(report.gaps).toContain('input_mismatch');
  });

  it.each(['plo5', 'plo6', 'plo8'] as const)(
    'reconciles the %s Phase 11 input binding to acceptance (P11.1)',
    (variant) => {
      const f = fixture(variant, [], false, false, true);
      expect(f.w.phase11Inputs).toMatchObject({
        version: 'horse-phase11-input-binding-v1',
        variant,
        rangeStatus: 'not_consumed_preflop',
      });
      const persisted = JSON.parse(f.rows()[0]!.body) as typeof f.d;
      const recovered = createHorseExecutionWitness(persisted.snapshot, persisted.decision, {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      });
      expect(recovered.phase11Inputs).toEqual(f.w.phase11Inputs);
      expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
        status: 'reconciled',
        matchedActions: 1,
        gaps: [],
        activationAllowed: false,
      });
    }
  );

  it.each(['short_deck', 'pineapple', 'flh', 'flo8'] as const)(
    'reconciles the %s Phase 12 input binding to acceptance (P12.1)',
    (variant) => {
      const f = fixture(variant, [], false, false, false, true);
      expect(f.w.phase12Inputs).toMatchObject({
        version: 'horse-phase12-input-binding-v1',
        variant,
        rangeStatus: 'not_consumed_preflop',
      });
      const persisted = JSON.parse(f.rows()[0]!.body) as typeof f.d;
      const recovered = createHorseExecutionWitness(persisted.snapshot, persisted.decision, {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      });
      expect(recovered.phase12Inputs).toEqual(f.w.phase12Inputs);
      expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
        status: 'reconciled',
        matchedActions: 1,
        gaps: [],
        activationAllowed: false,
      });
    }
  );

  it.each(['nlh', 'plo4', 'flo8', 'short_deck'] as const)(
    'reconciles the %s Phase 13 input binding to its accepted execution (P13.1)',
    (variant) => {
      const f = fixture(variant, [], false, false, false, false, true);
      expect(f.w.phase13Inputs).toMatchObject({
        version: 'horse-phase13-input-binding-v1',
        variant,
        rangeStatus: 'consumed',
      });
      // The journal's decision record still reads `pending`: the worker
      // journals it before the table acts. The join to the accepted action is
      // this commitment, recomputed from the persisted decision record.
      const persisted = JSON.parse(f.rows()[0]!.body) as typeof f.d;
      expect(persisted.decision.jointPolicy?.executionStatus).toBe('pending');
      const recovered = createHorseExecutionWitness(persisted.snapshot, persisted.decision, {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      });
      expect(recovered.phase13Inputs).toEqual(f.w.phase13Inputs);
      const accepted = JSON.parse(f.rows()[1]!.body) as typeof f.w;
      expect(accepted.acceptedActions).toHaveLength(1);
      expect(accepted.acceptedActions[0]!.record.action).toBe(
        persisted.decision.jointPolicy?.finalAction
      );
      expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
        status: 'reconciled',
        matchedActions: 1,
        gaps: [],
        activationAllowed: false,
      });
    }
  );

  it('rejects a changed Phase 13 input commitment even when the accepted action still matches', () => {
    const f = fixture('plo5', [], false, false, false, false, true);
    f.w = { ...f.w, phase13Inputs: { ...f.w.phase13Inputs!, inputSha256: 'f'.repeat(64) } };
    const report = reconcileHorseJournalHand(f.rows(), handKey);
    expect(report.status).toBe('incomplete');
    expect(report.matchedActions).toBe(0);
    expect(report.gaps).toContain('input_mismatch');
  });

  it('rejects a Phase 13 witness that drops the commitment of a bound proposal', () => {
    const f = fixture('nlh', [], false, false, false, false, true);
    f.w = Object.fromEntries(
      Object.entries(f.w).filter(([key]) => key !== 'phase13Inputs')
    ) as typeof f.w;
    const report = reconcileHorseJournalHand(f.rows(), handKey);
    expect(report.status).toBe('incomplete');
    expect(report.gaps).toContain('input_mismatch');
  });

  it('rejects a changed Phase 12 input commitment even when the accepted action still matches', () => {
    const f = fixture('flo8', [], false, false, false, true);
    f.w = { ...f.w, phase12Inputs: { ...f.w.phase12Inputs!, inputSha256: 'f'.repeat(64) } };
    const report = reconcileHorseJournalHand(f.rows(), handKey);
    expect(report.status).toBe('incomplete');
    expect(report.matchedActions).toBe(0);
    expect(report.gaps).toContain('input_mismatch');
  });

  it('rejects a Phase 12 witness that drops the commitment of a bound proposal', () => {
    const f = fixture('pineapple', [], false, false, false, true);
    f.w = Object.fromEntries(
      Object.entries(f.w).filter(([key]) => key !== 'phase12Inputs')
    ) as typeof f.w;
    const report = reconcileHorseJournalHand(f.rows(), handKey);
    expect(report.status).toBe('incomplete');
    expect(report.gaps).toContain('input_mismatch');
  });

  it('rejects a changed Phase 11 input commitment even when the accepted action still matches', () => {
    const f = fixture('plo8', [], false, false, true);
    f.w = { ...f.w, phase11Inputs: { ...f.w.phase11Inputs!, inputSha256: 'f'.repeat(64) } };
    const report = reconcileHorseJournalHand(f.rows(), handKey);
    expect(report.status).toBe('incomplete');
    expect(report.matchedActions).toBe(0);
    expect(report.gaps).toContain('input_mismatch');
  });

  it('rejects a Phase 11 witness that drops the commitment of a bound proposal', () => {
    const f = fixture('plo5', [], false, false, true);
    f.w = Object.fromEntries(
      Object.entries(f.w).filter(([key]) => key !== 'phase11Inputs')
    ) as typeof f.w;
    const report = reconcileHorseJournalHand(f.rows(), handKey);
    expect(report.status).toBe('incomplete');
    expect(report.gaps).toContain('input_mismatch');
  });

  it('rejects a read frame that no longer owns the Phase 10 input binding', () => {
    const f = fixture('plo4', [], false, true);
    const reads = HorseMind.createSandbox();
    HorseMind.runInSandbox(reads, () => {
      HorseMind.importStats([
        {
          user_id: f.d.snapshot.gameState.players[1]!.user_id,
          hands: 50,
          folds: 20,
          facedAggr: 30,
        },
      ]);
    });
    f.d.readFrame = encodeHorseDecisionReads(
      reads,
      f.d.snapshot.gameState.players,
      HorseMind.handKeyOf(f.d.snapshot.gameState.actionHistory)
    );
    expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
      status: 'incomplete',
      matchedActions: 0,
      gaps: expect.arrayContaining(['read_frame_unavailable']),
    });
  });

  it('retains compatibility with a valid legacy utility ledger without new provenance fields', () => {
    const f = fixture('nlh', [], true);
    delete f.d.decision.tournamentUtility!.evidence;
    delete f.d.decision.tournamentUtility!.readFrameSha256;
    const records = f.w.acceptedActions;
    f.w = createHorseExecutionWitness(f.d.snapshot, f.d.decision, {
      requestId: 1,
      lane: 'fast',
      computeMs: 1,
      governorScale: 1,
    });
    settleHorseExecutionWitness(f.w, { applied: true, acceptedActions: records });
    expect(f.w.phase7Evidence).toBeNull();
    expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
      status: 'reconciled',
      matchedActions: 1,
      gaps: [],
      gtoVerified: false,
    });
  });

  const returned = () => ({
    seat: 1,
    userId: '20000000-0000-4000-8000-000000000001',
    action: 'return',
    amount: 100,
    timestamp: 1002,
    stage: 'flop',
    historyEvent: 'uncalled_bet_returned',
  });

  it('reconciles explicit forced posts and returned accounting rows without changing the Horse ordinal', () => {
    const post = {
      ...returned(),
      action: 'sb',
      amount: 1,
      timestamp: 999,
      stage: 'preflop',
      dead: false,
      origin: 'forced',
    };
    const { historyEvent: _event, ...forcedPost } = post;
    const f = fixture('nlh', [forcedPost]);
    f.a.actions.push(returned());
    const before = JSON.stringify(f.a);
    expect(f.w.handAnchor).toMatchObject({ status: 'anchored', actionOrdinal: 1 });
    expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
      status: 'reconciled',
      acceptedHorseActions: 1,
      matchedActions: 1,
      gaps: [],
      completePopulation: false,
      activationAllowed: false,
    });
    expect(JSON.stringify(f.a)).toBe(before);
  });

  // Exact five-field history shape emitted by ServerTableEngineRunout. Boards
  // may share the already-dealt flop; only duplicates within one board are bad.
  const ritBoard = (board: 2 | 3 = 2): Record<string, unknown> => ({
    seat: 0,
    userId: 'system',
    action:
      board === 2
        ? 'rit_board_2:2clubs,3diamonds,4hearts,Tspades,Aclubs'
        : 'rit_board_3:2clubs,3diamonds,4hearts,Kspades,Qclubs',
    stage: 'river',
    timestamp: 1002,
  });

  it.each([2, 3] as const)(
    'reconciles %s-run trailing board metadata while preserving posts, returns and full ordinals',
    (runs) => {
      const forcedPost = {
        seat: 1,
        userId: '20000000-0000-4000-8000-000000000001',
        action: 'sb',
        amount: 1,
        timestamp: 999,
        stage: 'preflop',
        dead: false,
        origin: 'forced',
      };
      const f = fixture('nlh', [forcedPost]);
      const accepted = f.a.actions[1];
      f.a.actions.push(ritBoard(2));
      if (runs === 3) f.a.actions.push(ritBoard(3));
      // The actual RIT path appends boards before settleUncalledBet emits this.
      f.a.actions.push({ ...returned(), timestamp: 1003 });
      const rows = f.rows();
      const beforeHand = JSON.stringify(f.a);
      const beforeRows = JSON.stringify(rows);
      Object.freeze(f.a.actions);
      Object.freeze(rows);
      expect(f.w.handAnchor).toMatchObject({ status: 'anchored', actionOrdinal: 1 });
      expect(accepted.observationIdentity.actionOrdinal).toBe(1);
      const report = reconcileHorseJournalHand(rows, handKey);
      expect(report).toMatchObject({
        status: 'reconciled',
        acceptedHorseActions: 1,
        matchedActions: 1,
        gaps: [],
        completePopulation: false,
        replayVerified: false,
        gtoVerified: false,
        activationAllowed: false,
      });
      expect(f.a.actions[0]).toEqual(forcedPost);
      expect(f.a.actions[1]).toBe(accepted);
      expect(f.a.actions.at(-1)).toEqual({ ...returned(), timestamp: 1003 });
      expect(JSON.stringify(f.a)).toBe(beforeHand);
      expect(JSON.stringify(rows)).toBe(beforeRows);
      expect(JSON.stringify(report)).not.toContain(String(ritBoard(2).action));
    }
  );

  it.each([
    { name: 'player seat', patch: { seat: 1 } },
    { name: 'string seat', patch: { seat: '0' } },
    { name: 'player UUID', patch: { userId: '20000000-0000-4000-8000-000000000001' } },
    { name: 'missing actor', patch: { userId: undefined } },
    { name: 'missing cards', patch: { action: 'rit_board_2:' } },
    { name: 'four cards', patch: { action: 'rit_board_2:2clubs,3diamonds,4hearts,Tspades' } },
    {
      name: 'six cards',
      patch: { action: 'rit_board_2:2clubs,3diamonds,4hearts,Tspades,Aclubs,Khearts' },
    },
    { name: 'bad rank', patch: { action: 'rit_board_2:2clubs,3diamonds,4hearts,10spades,Aclubs' } },
    { name: 'bad suit', patch: { action: 'rit_board_2:2clubs,3diamonds,4hearts,Tspade,Aclubs' } },
    {
      name: 'duplicate card',
      patch: { action: 'rit_board_2:2clubs,3diamonds,4hearts,Tspades,2clubs' },
    },
    {
      name: 'first board',
      patch: { action: 'rit_board_1:2clubs,3diamonds,4hearts,Tspades,Aclubs' },
    },
    {
      name: 'fourth board',
      patch: { action: 'rit_board_4:2clubs,3diamonds,4hearts,Tspades,Aclubs' },
    },
    {
      name: 'padded board number',
      patch: { action: 'rit_board_02:2clubs,3diamonds,4hearts,Tspades,Aclubs' },
    },
    ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map((suffix) => ({
      name: `trailing line terminator ${JSON.stringify(suffix)}`,
      patch: { action: String(ritBoard().action) + suffix },
    })),
    { name: 'wrong stage', patch: { stage: 'flop' } },
    { name: 'missing stage', patch: { stage: undefined } },
    { name: 'supplied zero amount', patch: { amount: 0 } },
    { name: 'supplied null amount', patch: { amount: null } },
    { name: 'forced origin', patch: { origin: 'forced' } },
    { name: 'Horse origin', patch: { origin: 'horse_policy' } },
    { name: 'null origin', patch: { origin: null } },
    { name: 'public node', patch: { publicNode: { version: 1, status: 'captured' } } },
    {
      name: 'observation identity',
      patch: { observationIdentity: { version: 1, status: 'bound' } },
    },
    { name: 'return marker', patch: { historyEvent: 'uncalled_bet_returned' } },
    { name: 'dead-money flag', patch: { dead: false } },
    { name: 'raise flag', patch: { isFullRaise: false } },
    { name: 'missing timestamp', patch: { timestamp: undefined } },
    { name: 'negative timestamp', patch: { timestamp: -1 } },
    { name: 'fractional timestamp', patch: { timestamp: 1002.5 } },
    { name: 'unsafe timestamp', patch: { timestamp: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'string timestamp', patch: { timestamp: '1002' } },
    { name: 'null timestamp', patch: { timestamp: null } },
  ])('never reconciles an RIT metadata impostor with $name', ({ patch }) => {
    const f = fixture();
    f.a.actions.push({ ...ritBoard(), ...patch });
    const before = JSON.stringify(f.a);
    const report = reconcileHorseJournalHand(f.rows(), handKey);
    expect(report.status).not.toBe('reconciled');
    expect(report.gaps.length).toBeGreaterThan(0);
    expect(report.completePopulation).toBe(false);
    expect(report.activationAllowed).toBe(false);
    expect(JSON.stringify(f.a)).toBe(before);
  });

  it.each([
    { name: 'board three without board two', boards: [3] },
    { name: 'duplicate board two', boards: [2, 2] },
    { name: 'reversed boards', boards: [3, 2] },
  ] as const)('refuses $name in the retained RIT suffix', ({ boards }) => {
    const f = fixture();
    f.a.actions.push(...boards.map((board) => ritBoard(board)));
    expect(reconcileHorseJournalHand(f.rows(), handKey).status).not.toBe('reconciled');
  });

  it('does not hide a player action after RIT board metadata', () => {
    const f = fixture();
    f.a.actions.push(ritBoard(), {
      seat: 2,
      userId: '20000000-0000-4000-8000-000000000002',
      action: 'check',
      amount: 0,
      timestamp: 1003,
      stage: 'river',
      origin: 'player',
    });
    expect(reconcileHorseJournalHand(f.rows(), handKey).status).not.toBe('reconciled');
  });

  it.each([2, 3] as const)(
    'keeps board %s metadata invalid for live player-action anchors',
    (board) => {
      const f = fixture();
      const actions = [...f.a.actions, ritBoard(board)];
      expect(horsePriorActionsDigest(actions)).toBeNull();
      expect(captureHorseHandJournalContext(actions)).toBeNull();
    }
  );

  it('reconciles persisted RIT metadata from a fresh read-only store without rewriting it', () => {
    const dir = directory();
    const f = fixture();
    f.a.actions.push(ritBoard(), { ...returned(), timestamp: 1003 });
    const rows = f.rows();
    const store = new HorseDecisionJournalStore(dir);
    try {
      store.appendBatch(rows);
    } finally {
      store.close();
    }
    const path = join(dir, 'horse-decisions.sqlite');
    const before = readFileSync(path);
    expect(readHorseJournalHand(dir, handKey)).toMatchObject({
      status: 'reconciled',
      acceptedHorseActions: 1,
      matchedActions: 1,
      gaps: [],
    });
    expect(readFileSync(path)).toEqual(before);
    const reader = new HorseDecisionJournalStore(dir, { readOnly: true });
    try {
      expect(reader.readHand(handKey)).toEqual(rows);
    } finally {
      reader.close();
    }
  });

  it.each([
    { name: 'legacy absent marker', patch: { historyEvent: undefined } },
    { name: 'zero returned amount', patch: { amount: 0 } },
    { name: 'unknown marker', patch: { historyEvent: 'accounting' } },
    { name: 'null marker', patch: { historyEvent: null } },
    { name: 'array marker', patch: { historyEvent: ['uncalled_bet_returned'] } },
    { name: 'object marker', patch: { historyEvent: { type: 'uncalled_bet_returned' } } },
    { name: 'ordinary player choice', patch: { action: 'call', origin: 'player' } },
    { name: 'discard choice', patch: { action: 'discard' } },
    ...['unknown', 'forced', 'pre_action', 'player', 'horse_policy', 'horse_fallback', null].map(
      (origin) => ({ name: `supplied origin ${origin}`, patch: { origin } })
    ),
    {
      name: 'legacy return with forced origin',
      patch: { historyEvent: undefined, origin: 'forced' },
    },
  ])('keeps $name unqualified instead of inventing event provenance', ({ patch }) => {
    const f = fixture();
    f.a.actions.push({ ...returned(), ...patch });
    expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
      status: 'incomplete',
      gaps: expect.arrayContaining(['action_origin_unavailable']),
      completePopulation: false,
      activationAllowed: false,
    });
  });

  it.each([
    'nlh',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'flh',
    'flo8',
    'short_deck',
    'pineapple',
  ] as const)(
    'joins original inputs, reads, execution and accepted action for %s without claiming strength',
    (variant) => {
      const f = fixture(variant),
        report = reconcileHorseJournalHand(f.rows(), handKey);
      expect(report).toMatchObject({
        status: 'reconciled',
        retainedRecords: 3,
        acceptedHorseActions: 1,
        matchedActions: 1,
        gaps: [],
        completePopulation: false,
        replayVerified: false,
        gtoVerified: false,
        activationAllowed: false,
      });
      const publicJson = JSON.stringify(report);
      for (const secret of [
        table,
        hand,
        producer,
        f.d.snapshot.player.user_id,
        'decisionKey',
        'readFrame',
        'sourceRelease',
        'sessionKey',
      ])
        expect(publicJson).not.toContain(secret);
    }
  );
  it('recovers from a fresh read-only connection without altering the spool', () => {
    const dir = directory(),
      f = fixture(),
      s = new HorseDecisionJournalStore(dir);
    s.appendBatch(f.rows());
    s.close();
    const path = join(dir, 'horse-decisions.sqlite'),
      before = readFileSync(path);
    expect(readHorseJournalHand(dir, handKey).status).toBe('reconciled');
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dir)).toEqual(['horse-decisions.sqlite']);
    const ro = new HorseDecisionJournalStore(dir, { readOnly: true });
    expect(() => ro.append(f.rows()[0]!)).toThrow('read only');
    ro.close();
  });
  it('missing storage is unavailable and is never created by review', () => {
    const dir = join(directory(), 'absent');
    expect(readHorseJournalHand(dir, handKey)).toMatchObject({
      status: 'unavailable',
      gaps: ['storage_unavailable'],
    });
    expect(existsSync(dir)).toBe(false);
  });
  it('deduplicates exact disk replay and transport retries without counting another action', () => {
    const f = fixture(),
      rows = f.rows();
    const report = reconcileHorseJournalHand(
      [...rows, structuredClone(rows[0]!), f.make('accepted_hand', 4, { ...f.a, requestId: 99 })],
      handKey
    );
    expect(report).toMatchObject({ status: 'reconciled', matchedActions: 1, retainedRecords: 4 });
    expect(reconcileHorseJournalHand(rows.slice().reverse(), handKey).manifest).toBe(
      reconcileHorseJournalHand(rows, handKey).manifest
    );
  });
  it.each(['accepted_hand', 'decision', 'execution'] as const)(
    'reports missing %s rather than an empty successful population',
    (kind) => {
      const report = reconcileHorseJournalHand(
        fixture()
          .rows()
          .filter((r) => r.kind !== kind),
        handKey
      );
      expect(report.status).not.toBe('reconciled');
      expect(report.gaps).toContain(`${kind}_missing`);
      expect(report.matchedActions).toBe(0);
    }
  );
  it.each(['identity', 'actions', 'blind', 'roster', 'roster_absent'])(
    'refuses contradictory accepted %s',
    (change) => {
      const f = fixture(),
        a = structuredClone(f.a) as typeof f.a & { acceptedActorRoster?: unknown };
      // P14.2: retained acceptances of one hand must agree on the private roster.
      const roster = (horse: string) =>
        doorRosterTransport(table, 12, hand, (r) => {
          r.actors[1]!.classification = horse as 'horse';
        });
      if (change === 'identity') a.committedHandId = table;
      else if (change === 'blind') a.bigBlind++;
      else if (change === 'roster' || change === 'roster_absent') {
        a.acceptedActorRoster = roster('horse');
        if (change === 'roster')
          f.a = { ...f.a, acceptedActorRoster: roster('human') } as typeof f.a;
      } else a.actions.at(-1)!.amount++;
      expect(
        reconcileHorseJournalHand([...f.rows(), f.make('accepted_hand', 4, a)], handKey)
      ).toMatchObject({ status: 'unavailable', gaps: ['accepted_hand_conflict'] });
    }
  );
  it('treats identical retained accepted rosters as one acceptance', () => {
    const f = fixture();
    f.a = { ...f.a, acceptedActorRoster: doorRosterTransport(table, 12, hand) } as typeof f.a;
    const rows = f.rows();
    const accepted = rows.find((r) => r.kind === 'accepted_hand')!;
    expect(
      reconcileHorseJournalHand(
        [...rows, f.make('accepted_hand', 4, { ...JSON.parse(accepted.body), requestId: 99 })],
        handKey
      )
    ).toMatchObject({ status: 'reconciled', matchedActions: 1 });
  });
  it.each([
    'selected',
    'actor',
    'read_frame',
    'rng',
    'key',
    'release',
    'order',
    'status',
    'origin',
    'prefix',
    'source_turn',
  ])('makes changed %s evidence unavailable', (change) => {
    const f = fixture();
    if (change === 'selected') f.w = { ...f.w, selected: { action: 'raise', amount: 20 } };
    else if (change === 'actor')
      f.w.acceptedActions[0] = {
        ...f.w.acceptedActions[0]!,
        record: { ...f.w.acceptedActions[0]!.record, userId: table },
      };
    else if (change === 'read_frame') f.d.readFrame = { ...f.d.readFrame, sha256: '0'.repeat(64) };
    else if (change === 'rng') f.d.rngBefore = -1;
    else if (change === 'key') f.d.snapshot.decisionKey = 'bad';
    else if (change === 'status') f.w.executionStatus = 'coerced';
    else if (change === 'origin') f.a.actions.at(-1)!.origin = 'horse_fallback';
    else if (change === 'prefix')
      f.d.snapshot.handJournalContext = { ...f.d.snapshot.handJournalContext!, actionCount: 22 };
    const rows = f.rows();
    if (change === 'release')
      rows[1] = makeHorseJournalRecord({ ...rows[1]!, sourceRelease: 'b'.repeat(40) }, f.w);
    if (change === 'order') rows[1] = f.make('execution', 0 + 1, f.w);
    if (change === 'source_turn') rows[1] = f.make('execution', 2, f.w, 'f'.repeat(64));
    const report = reconcileHorseJournalHand(rows, handKey);
    expect(report.status).not.toBe('reconciled');
    expect(report.matchedActions).toBe(0);
    expect(report.gaps.length).toBeGreaterThan(0);
  });
  it('detects a Horse action that has no corresponding captured decision', () => {
    const f = fixture();
    f.a.actions.push({ ...f.a.actions.at(-1)!, timestamp: 1002 });
    expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
      status: 'incomplete',
      acceptedHorseActions: 2,
      matchedActions: 1,
      gaps: ['unmatched_horse_action'],
    });
  });
  it('does not pick the first of competing decisions for one accepted action', () => {
    const f = fixture(),
      other = fixture();
    other.d.snapshot.requestId = 9;
    other.w = createHorseExecutionWitness(other.d.snapshot, other.d.decision, {
      requestId: 9,
      lane: 'fast',
      computeMs: 1,
      governorScale: 1,
    });
    settleHorseExecutionWitness(other.w, { applied: true, acceptedActions: f.w.acceptedActions });
    const rows = [
      ...f.rows(),
      other.make('decision', 4, other.d),
      other.make('execution', 5, other.w),
    ];
    expect(reconcileHorseJournalHand(rows, handKey)).toMatchObject({
      status: 'incomplete',
      matchedActions: 0,
      gaps: ['multiple_decisions_for_action'],
    });
  });
  it('requires an explicit terminal retirement for an unexecuted decision', () => {
    const f = fixture();
    f.w = createHorseExecutionWitness(f.d.snapshot, f.d.decision, {
      requestId: 1,
      lane: 'fast',
      computeMs: 1,
      governorScale: 1,
    });
    retireHorseExecutionWitness(f.w, 'turn_abandoned');
    f.a.actions.pop();
    expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
      status: 'reconciled',
      matchedActions: 0,
      retiredDecisions: 1,
    });
  });
  it.each(['honest', 'tampered_reference', 'tampered_authority'] as const)(
    'reconciles a Phase 8 selection withdrawn before acceptance (%s)',
    (mode) => {
      const f = fixture();
      const s = f.d.snapshot;
      const worker = new HorseQualifiedAuthorityHolder('review-worker');
      worker.apply(qualifiedTestAdmission(1));
      const ledger = (authority: unknown) => ({
        version: 'horse-tournament-postflop-round1-v4',
        mode: 'candidate',
        changed: true,
        applied: true,
        selection: 'selected',
        authority,
        authorityVerdict: null,
        baselineAction: 'call',
        baselineAmount: null,
        candidateAction: 'fold',
        candidateAmount: null,
        executionStatus: 'pending',
        executedAction: null,
        executedAmount: null,
      });
      // The worker journals its unstamped receipt; the client stamps the
      // main generation before it builds the witness.
      f.d.decision = {
        action: 'fold',
        thinkTime: 50,
        tournamentPostflop: ledger(worker.receipt()),
      } as unknown as HorseDecision;
      const gate = new HorsePhase8AuthorityGate(() => qualifiedTestAdmission(1), 'review-main');
      gate.refresh();
      const delivered = {
        ...f.d.decision,
        tournamentPostflop: ledger(
          mode === 'tampered_authority'
            ? gate.stamp({ ...worker.receipt(), generation: 9 })
            : gate.stamp(worker.receipt())
        ),
      } as unknown as HorseDecision;
      const w = createHorseExecutionWitness(s, delivered, {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      });
      withdrawHorsePhase8Selection(w, s, 'withdrawn');
      if (mode === 'tampered_reference')
        (w as { selected: unknown }).selected = { action: 'call', amount: 2 };
      settleHorseExecutionWitness(w, {
        applied: true,
        acceptedActions: f.w.acceptedActions,
      });
      f.w = w;
      expect(w.phase8Authority?.selection).toBe('withdrawn_before_acceptance');
      expect(reconcileHorseJournalHand(f.rows(), handKey).status).toBe(
        mode === 'honest' ? 'reconciled' : 'incomplete'
      );
    }
  );
  describe('P10.3 PLO4 selection reconciliation', () => {
    /** A P10.3 cash receipt as the worker returns it, bound to its authority. */
    const plo4Receipt = (authority: unknown, selected: boolean) => ({
      version: 'plo4-policy-round1-v3',
      mode: selected ? 'candidate' : 'shadow',
      eligible: true,
      fired: true,
      changed: true,
      applied: selected,
      selection: selected ? 'selected' : 'shadow_change',
      selectionRefusal: null,
      authority,
      authorityVerdict: null,
      reason: 'preflop_entry',
      street: 'preflop',
      baselineAction: 'call',
      baselineAmount: null,
      proposalAction: 'raise',
      proposalAmount: 4,
      finalAction: selected ? 'raise' : 'call',
      finalAmount: selected ? 4 : null,
      utilityOwner: 'cash',
      executionStatus: 'pending',
      executedAction: null,
      executedAmount: null,
    });
    function selectedCase(selected = true) {
      const f = fixture('plo4');
      const s = f.d.snapshot;
      const worker = new HorseQualifiedAuthorityHolder(
        'review-p10-worker',
        'plo4-policy-round1-v3'
      );
      worker.apply(qualifiedPhase10TestAdmission(1));
      const gate = new HorsePhase8AuthorityGate(
        () => qualifiedPhase10TestAdmission(1),
        'review-p10-main',
        'plo4-policy-round1-v3'
      );
      gate.refresh();
      const journaled = selected ? worker.receipt() : null;
      const act = selected ? { action: 'raise' as const, amount: 4 } : { action: 'call' as const };
      // The worker journals its unstamped receipt; the client stamps it.
      f.d.decision = {
        ...act,
        thinkTime: 50,
        plo4Policy: plo4Receipt(journaled, selected),
      } as unknown as HorseDecision;
      const delivered = {
        ...f.d.decision,
        plo4Policy: plo4Receipt(journaled ? gate.stamp(worker.receipt()) : null, selected),
      } as unknown as HorseDecision;
      const w = createHorseExecutionWitness(s, delivered, {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      });
      return { f, s, w, gate, worker };
    }
    const accept = (f: ReturnType<typeof fixture>, action: 'raise' | 'call', amount: number) => {
      const last = f.a.actions.at(-1) as Record<string, unknown>;
      f.a.actions[f.a.actions.length - 1] = { ...last, action, amount } as never;
      return [
        {
          record: { ...f.w.acceptedActions[0]!.record, action, amount },
          intended: true,
        },
      ];
    };

    it('reconciles an accepted selection: the reviewer recomputes the selected and baseline actions', () => {
      const { f, w } = selectedCase();
      recordHorsePhase10Verdict(w, 'usable');
      settleHorseExecutionWitness(w, { applied: true, acceptedActions: accept(f, 'raise', 4) });
      f.w = w;
      expect(w.executionStatus).toBe('intended');
      expect(w.phase10Authority).toMatchObject({
        selection: 'controller_accepted',
        verdict: 'usable',
        candidate: { action: 'raise', amount: 4 },
        reference: { action: 'call', amount: null },
      });
      expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
        status: 'reconciled',
        matchedActions: 1,
        gaps: [],
      });
    });

    it.each([
      [
        'a changed shadow baseline',
        (w: any): void => {
          w.phase10Authority.reference = { action: 'fold', amount: null };
        },
      ],
      [
        'a changed selected proposal',
        (w: any): void => {
          w.phase10Authority.candidate = { action: 'raise', amount: 6 };
        },
      ],
      [
        'acceptance without a usable verdict',
        (w: any): void => {
          w.phase10Authority.verdict = 'withdrawn';
        },
      ],
      [
        'a forged worker authority',
        (w: any): void => {
          w.phase10Authority.authority = { ...w.phase10Authority.authority, generation: 9 };
        },
      ],
      [
        'a dropped binding',
        (w: any): void => {
          delete w.phase10Authority;
        },
      ],
    ] as const)('rejects %s even when the accepted action matches', (_name, tamper) => {
      const { f, w } = selectedCase();
      recordHorsePhase10Verdict(w, 'usable');
      settleHorseExecutionWitness(w, { applied: true, acceptedActions: accept(f, 'raise', 4) });
      tamper(w);
      f.w = w;
      const report = reconcileHorseJournalHand(f.rows(), handKey);
      expect(report.status).toBe('incomplete');
      expect(report.matchedActions).toBe(0);
    });

    it.each(['honest', 'tampered_reference', 'claims_acceptance'] as const)(
      'reconciles a PLO4 selection withdrawn before acceptance (%s)',
      (mode) => {
        const { f, s, w } = selectedCase();
        withdrawHorsePhase10Selection(w, s, 'withdrawn');
        if (mode === 'tampered_reference')
          (w as { selected: unknown }).selected = { action: 'raise', amount: 4 };
        settleHorseExecutionWitness(w, { applied: true, acceptedActions: f.w.acceptedActions });
        if (mode === 'claims_acceptance') w.phase10Authority!.selection = 'controller_accepted';
        f.w = w;
        expect(w.selected).toEqual(
          mode === 'tampered_reference'
            ? { action: 'raise', amount: 4 }
            : { action: 'call', amount: null }
        );
        expect(reconcileHorseJournalHand(f.rows(), handKey).status).toBe(
          mode === 'honest' ? 'reconciled' : 'incomplete'
        );
      }
    );

    it('reconciles a shadow change and rejects one relabelled as selected', () => {
      const honest = selectedCase(false);
      settleHorseExecutionWitness(honest.w, {
        applied: true,
        acceptedActions: honest.f.w.acceptedActions,
      });
      honest.f.w = honest.w;
      expect(honest.w.phase10Authority).toMatchObject({
        mode: 'shadow',
        selection: 'shadow_change',
        authority: null,
      });
      expect(reconcileHorseJournalHand(honest.f.rows(), handKey).status).toBe('reconciled');
      const relabelled = selectedCase(false);
      settleHorseExecutionWitness(relabelled.w, {
        applied: true,
        acceptedActions: relabelled.f.w.acceptedActions,
      });
      relabelled.w.phase10Authority!.selection = 'selected';
      relabelled.f.w = relabelled.w;
      expect(reconcileHorseJournalHand(relabelled.f.rows(), handKey).status).toBe('incomplete');
    });
  });

  describe('P11.3 PLO5/PLO6/PLO8 selection reconciliation', () => {
    /** A P11.3 cash receipt as the worker returns it, bound to its pack authority. */
    const omahaReceipt = (
      variant: 'plo5' | 'plo6' | 'plo8',
      authority: unknown,
      selected: boolean,
      inputs: unknown
    ) => ({
      version: OMAHA_VARIANT_PACKS[variant].version,
      variant,
      mode: selected ? 'candidate' : 'shadow',
      eligible: true,
      fired: true,
      changed: true,
      applied: selected,
      selection: selected ? 'selected' : 'shadow_change',
      selectionRefusal: null,
      authority,
      authorityVerdict: null,
      reason: 'preflop_entry',
      street: 'preflop',
      baselineAction: 'call',
      baselineAmount: null,
      proposalAction: 'raise',
      proposalAmount: 4,
      finalAction: selected ? 'raise' : 'call',
      finalAmount: selected ? 4 : null,
      utilityOwner: 'cash',
      executionStatus: 'pending',
      executedAction: null,
      executedAmount: null,
      inputs,
    });
    function selectedCase(variant: 'plo5' | 'plo6' | 'plo8' = 'plo6', selected = true) {
      const f = fixture(variant, [], false, false, true);
      // The real binding the policy recorded on this snapshot (P11.1/P12.1): a
      // receipt that carries a selection carries its binding (audit 2026-10-05).
      const inputs = (f.d.decision as unknown as Record<string, { inputs?: unknown }>)
        .omahaVariantPolicy?.inputs;
      if (!inputs) throw Error('fixture did not bind the omahaVariantPolicy inputs');
      const s = f.d.snapshot;
      const version = OMAHA_VARIANT_PACKS[variant].version;
      const worker = new HorseQualifiedAuthorityHolder('review-p11-worker', version);
      worker.apply(qualifiedPhase11TestAdmission(variant));
      const gate = new HorsePhase8AuthorityGate(
        () => qualifiedPhase11TestAdmission(variant),
        'review-p11-main',
        version
      );
      gate.refresh();
      const journaled = selected ? worker.receipt() : null;
      const act = selected ? { action: 'raise' as const, amount: 4 } : { action: 'call' as const };
      // The worker journals its unstamped receipt; the client stamps it.
      f.d.decision = {
        ...act,
        thinkTime: 50,
        omahaVariantPolicy: omahaReceipt(variant, journaled, selected, inputs),
      } as unknown as HorseDecision;
      const delivered = {
        ...f.d.decision,
        omahaVariantPolicy: omahaReceipt(
          variant,
          journaled ? gate.stamp(worker.receipt()) : null,
          selected,
          inputs
        ),
      } as unknown as HorseDecision;
      const w = createHorseExecutionWitness(s, delivered, {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      });
      return { f, s, w, gate, worker };
    }
    const accept = (f: ReturnType<typeof fixture>, action: 'raise' | 'call', amount: number) => {
      const last = f.a.actions.at(-1) as Record<string, unknown>;
      f.a.actions[f.a.actions.length - 1] = { ...last, action, amount } as never;
      return [
        {
          record: { ...f.w.acceptedActions[0]!.record, action, amount },
          intended: true,
        },
      ];
    };

    it.each(['plo5', 'plo6', 'plo8'] as const)(
      'reconciles an accepted %s selection: the reviewer recomputes the selected and baseline actions',
      (variant) => {
        const { f, w } = selectedCase(variant);
        recordHorsePhase11Verdict(w, 'usable');
        settleHorseExecutionWitness(w, { applied: true, acceptedActions: accept(f, 'raise', 4) });
        f.w = w;
        expect(w.executionStatus).toBe('intended');
        expect(w.phase11Authority).toMatchObject({
          continuationVersion: OMAHA_VARIANT_PACKS[variant].version,
          selection: 'controller_accepted',
          verdict: 'usable',
          candidate: { action: 'raise', amount: 4 },
          reference: { action: 'call', amount: null },
        });
        expect(w).not.toHaveProperty('phase10Authority');
        expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
          status: 'reconciled',
          matchedActions: 1,
          gaps: [],
          activationAllowed: false,
        });
      }
    );

    it.each([
      [
        'a changed shadow baseline',
        (w: any): void => {
          w.phase11Authority.reference = { action: 'fold', amount: null };
        },
      ],
      [
        'a changed selected proposal',
        (w: any): void => {
          w.phase11Authority.candidate = { action: 'raise', amount: 6 };
        },
      ],
      [
        'acceptance without a usable verdict',
        (w: any): void => {
          w.phase11Authority.verdict = 'withdrawn';
        },
      ],
      [
        'a forged worker authority',
        (w: any): void => {
          w.phase11Authority.authority = { ...w.phase11Authority.authority, generation: 9 };
        },
      ],
      [
        'another pack version',
        (w: any): void => {
          w.phase11Authority.continuationVersion = OMAHA_VARIANT_PACKS.plo5.version;
        },
      ],
      [
        'a dropped binding',
        (w: any): void => {
          delete w.phase11Authority;
        },
      ],
      [
        'the binding moved to the Phase 10 slot',
        (w: any): void => {
          w.phase10Authority = w.phase11Authority;
          delete w.phase11Authority;
        },
      ],
    ] as const)('rejects %s even when the accepted action matches', (_name, tamper) => {
      const { f, w } = selectedCase();
      recordHorsePhase11Verdict(w, 'usable');
      settleHorseExecutionWitness(w, { applied: true, acceptedActions: accept(f, 'raise', 4) });
      tamper(w);
      f.w = w;
      const report = reconcileHorseJournalHand(f.rows(), handKey);
      expect(report.status).toBe('incomplete');
      expect(report.matchedActions).toBe(0);
    });

    it.each([
      'honest',
      'tampered_reference',
      'claims_acceptance',
      'unusable_verdict_missing',
    ] as const)('reconciles a Phase 11 selection withdrawn before acceptance (%s)', (mode) => {
      const { f, s, w } = selectedCase();
      withdrawHorsePhase11Selection(w, s, 'withdrawn');
      if (mode === 'tampered_reference')
        (w as { selected: unknown }).selected = { action: 'raise', amount: 4 };
      settleHorseExecutionWitness(w, { applied: true, acceptedActions: f.w.acceptedActions });
      if (mode === 'claims_acceptance') w.phase11Authority!.selection = 'controller_accepted';
      if (mode === 'unusable_verdict_missing') w.phase11Authority!.verdict = null;
      f.w = w;
      expect(w.selected).toEqual(
        mode === 'tampered_reference'
          ? { action: 'raise', amount: 4 }
          : { action: 'call', amount: null }
      );
      expect(reconcileHorseJournalHand(f.rows(), handKey).status).toBe(
        mode === 'honest' ? 'reconciled' : 'incomplete'
      );
    });

    it('reconciles a shadow change and rejects one relabelled as selected', () => {
      const honest = selectedCase('plo8', false);
      settleHorseExecutionWitness(honest.w, {
        applied: true,
        acceptedActions: honest.f.w.acceptedActions,
      });
      honest.f.w = honest.w;
      expect(honest.w.phase11Authority).toMatchObject({
        mode: 'shadow',
        selection: 'shadow_change',
        authority: null,
      });
      expect(reconcileHorseJournalHand(honest.f.rows(), handKey).status).toBe('reconciled');
      const relabelled = selectedCase('plo8', false);
      settleHorseExecutionWitness(relabelled.w, {
        applied: true,
        acceptedActions: relabelled.f.w.acceptedActions,
      });
      relabelled.w.phase11Authority!.selection = 'selected';
      relabelled.f.w = relabelled.w;
      expect(reconcileHorseJournalHand(relabelled.f.rows(), handKey).status).toBe('incomplete');
    });
  });
  describe('P12.3 Short Deck/Pineapple/FLH/FLO8 selection reconciliation', () => {
    /** A P12.3 cash receipt as the worker returns it, bound to its pack authority. */
    const remainingReceipt = (
      variant: 'short_deck' | 'pineapple' | 'flh' | 'flo8',
      authority: unknown,
      selected: boolean,
      inputs: unknown
    ) => ({
      version: REMAINING_VARIANT_PACKS[variant].version,
      variant,
      mode: selected ? 'candidate' : 'shadow',
      eligible: true,
      fired: true,
      changed: true,
      applied: selected,
      selection: selected ? 'selected' : 'shadow_change',
      selectionRefusal: null,
      authority,
      authorityVerdict: null,
      reason: 'preflop_entry',
      street: 'preflop',
      baselineAction: 'call',
      baselineAmount: null,
      proposalAction: 'raise',
      proposalAmount: 4,
      finalAction: selected ? 'raise' : 'call',
      finalAmount: selected ? 4 : null,
      utilityOwner: 'cash',
      executionStatus: 'pending',
      executedAction: null,
      executedAmount: null,
      inputs,
    });
    function selectedCase(
      variant: 'short_deck' | 'pineapple' | 'flh' | 'flo8' = 'short_deck',
      selected = true
    ) {
      const f = fixture(variant, [], false, false, false, true);
      // The real binding the policy recorded on this snapshot (P11.1/P12.1): a
      // receipt that carries a selection carries its binding (audit 2026-10-05).
      const inputs = (f.d.decision as unknown as Record<string, { inputs?: unknown }>)
        .remainingVariantPolicy?.inputs;
      if (!inputs) throw Error('fixture did not bind the remainingVariantPolicy inputs');
      const s = f.d.snapshot;
      const version = REMAINING_VARIANT_PACKS[variant].version;
      const worker = new HorseQualifiedAuthorityHolder('review-p12-worker', version);
      worker.apply(qualifiedPhase12TestAdmission(variant));
      const gate = new HorsePhase8AuthorityGate(
        () => qualifiedPhase12TestAdmission(variant),
        'review-p12-main',
        version
      );
      gate.refresh();
      const journaled = selected ? worker.receipt() : null;
      const act = selected ? { action: 'raise' as const, amount: 4 } : { action: 'call' as const };
      // The worker journals its unstamped receipt; the client stamps it.
      f.d.decision = {
        ...act,
        thinkTime: 50,
        remainingVariantPolicy: remainingReceipt(variant, journaled, selected, inputs),
      } as unknown as HorseDecision;
      const delivered = {
        ...f.d.decision,
        remainingVariantPolicy: remainingReceipt(
          variant,
          journaled ? gate.stamp(worker.receipt()) : null,
          selected,
          inputs
        ),
      } as unknown as HorseDecision;
      const w = createHorseExecutionWitness(s, delivered, {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      });
      return { f, s, w, gate, worker };
    }
    const accept = (f: ReturnType<typeof fixture>, action: 'raise' | 'call', amount: number) => {
      const last = f.a.actions.at(-1) as Record<string, unknown>;
      f.a.actions[f.a.actions.length - 1] = { ...last, action, amount } as never;
      return [
        {
          record: { ...f.w.acceptedActions[0]!.record, action, amount },
          intended: true,
        },
      ];
    };

    it.each(['short_deck', 'pineapple', 'flh', 'flo8'] as const)(
      'reconciles an accepted %s selection: the reviewer recomputes the selected and baseline actions',
      (variant) => {
        const { f, w } = selectedCase(variant);
        recordHorsePhase12Verdict(w, 'usable');
        settleHorseExecutionWitness(w, { applied: true, acceptedActions: accept(f, 'raise', 4) });
        f.w = w;
        expect(w.executionStatus).toBe('intended');
        expect(w.phase12Authority).toMatchObject({
          continuationVersion: REMAINING_VARIANT_PACKS[variant].version,
          selection: 'controller_accepted',
          verdict: 'usable',
          candidate: { action: 'raise', amount: 4 },
          reference: { action: 'call', amount: null },
        });
        expect(w).not.toHaveProperty('phase10Authority');
        expect(w).not.toHaveProperty('phase11Authority');
        expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
          status: 'reconciled',
          matchedActions: 1,
          gaps: [],
          activationAllowed: false,
        });
      }
    );

    it.each([
      [
        'a changed shadow baseline',
        (w: any): void => {
          w.phase12Authority.reference = { action: 'fold', amount: null };
        },
      ],
      [
        'a changed selected proposal',
        (w: any): void => {
          w.phase12Authority.candidate = { action: 'raise', amount: 6 };
        },
      ],
      [
        'acceptance without a usable verdict',
        (w: any): void => {
          w.phase12Authority.verdict = 'withdrawn';
        },
      ],
      [
        'a forged worker authority',
        (w: any): void => {
          w.phase12Authority.authority = { ...w.phase12Authority.authority, generation: 9 };
        },
      ],
      [
        'another pack version',
        (w: any): void => {
          w.phase12Authority.continuationVersion = REMAINING_VARIANT_PACKS.flh.version;
        },
      ],
      [
        'a dropped binding',
        (w: any): void => {
          delete w.phase12Authority;
        },
      ],
      [
        'the binding moved to the Phase 10 slot',
        (w: any): void => {
          w.phase10Authority = w.phase12Authority;
          delete w.phase12Authority;
        },
      ],
      [
        'the binding moved to the Phase 11 slot',
        (w: any): void => {
          w.phase11Authority = w.phase12Authority;
          delete w.phase12Authority;
        },
      ],
    ] as const)('rejects %s even when the accepted action matches', (_name, tamper) => {
      const { f, w } = selectedCase();
      recordHorsePhase12Verdict(w, 'usable');
      settleHorseExecutionWitness(w, { applied: true, acceptedActions: accept(f, 'raise', 4) });
      tamper(w);
      f.w = w;
      const report = reconcileHorseJournalHand(f.rows(), handKey);
      expect(report.status).toBe('incomplete');
      expect(report.matchedActions).toBe(0);
    });

    it.each([
      'honest',
      'tampered_reference',
      'claims_acceptance',
      'unusable_verdict_missing',
    ] as const)('reconciles a Phase 12 selection withdrawn before acceptance (%s)', (mode) => {
      const { f, s, w } = selectedCase();
      withdrawHorsePhase12Selection(w, s, 'withdrawn');
      if (mode === 'tampered_reference')
        (w as { selected: unknown }).selected = { action: 'raise', amount: 4 };
      settleHorseExecutionWitness(w, { applied: true, acceptedActions: f.w.acceptedActions });
      if (mode === 'claims_acceptance') w.phase12Authority!.selection = 'controller_accepted';
      if (mode === 'unusable_verdict_missing') w.phase12Authority!.verdict = null;
      f.w = w;
      expect(w.selected).toEqual(
        mode === 'tampered_reference'
          ? { action: 'raise', amount: 4 }
          : { action: 'call', amount: null }
      );
      expect(reconcileHorseJournalHand(f.rows(), handKey).status).toBe(
        mode === 'honest' ? 'reconciled' : 'incomplete'
      );
    });

    it('reconciles a shadow change and rejects one relabelled as selected', () => {
      const honest = selectedCase('flo8', false);
      settleHorseExecutionWitness(honest.w, {
        applied: true,
        acceptedActions: honest.f.w.acceptedActions,
      });
      honest.f.w = honest.w;
      expect(honest.w.phase12Authority).toMatchObject({
        mode: 'shadow',
        selection: 'shadow_change',
        authority: null,
      });
      expect(reconcileHorseJournalHand(honest.f.rows(), handKey).status).toBe('reconciled');
      const relabelled = selectedCase('flo8', false);
      settleHorseExecutionWitness(relabelled.w, {
        applied: true,
        acceptedActions: relabelled.f.w.acceptedActions,
      });
      relabelled.w.phase12Authority!.selection = 'selected';
      relabelled.f.w = relabelled.w;
      expect(reconcileHorseJournalHand(relabelled.f.rows(), handKey).status).toBe('incomplete');
    });
  });

  describe('P13.3 joint multiway selection reconciliation', () => {
    type JointCaseVariant = 'nlh' | 'plo4' | 'flo8' | 'short_deck';
    function selectedCase(variant: JointCaseVariant = 'nlh', selected = true) {
      const f = fixture(variant, [], false, false, false, false, true);
      // The real joint receipt the policy recorded on this snapshot (its
      // binding, packs and response fields), relabelled as the worker would
      // return a selection of a changed proposal.
      const real = (f.d.decision as HorseDecision).jointPolicy!;
      const s = f.d.snapshot;
      const continuation = horsePhase13ContinuationVersion(variant);
      const worker = new HorseQualifiedAuthorityHolder('review-p13-worker', continuation);
      worker.apply(qualifiedPhase13TestAdmission(variant));
      const gate = new HorsePhase8AuthorityGate(
        () => qualifiedPhase13TestAdmission(variant),
        'review-p13-main',
        continuation
      );
      gate.refresh();
      const journaled = selected ? worker.receipt() : null;
      const receipt = (authority: unknown) => ({
        ...structuredClone(real),
        mode: selected ? 'candidate' : 'shadow',
        fired: true,
        changed: true,
        applied: selected,
        selection: selected ? 'selected' : 'shadow_change',
        selectionRefusal: null,
        authority,
        authorityVerdict: null,
        baselineAction: 'call',
        baselineAmount: null,
        proposalAction: 'raise',
        proposalAmount: 4,
        finalAction: selected ? 'raise' : 'call',
        finalAmount: selected ? 4 : null,
        utilityOwner: 'cash',
        executionStatus: 'pending',
      });
      const act = selected ? { action: 'raise' as const, amount: 4 } : { action: 'call' as const };
      // The worker journals its unstamped receipt; the client stamps it.
      f.d.decision = {
        ...act,
        thinkTime: 50,
        jointPolicy: receipt(journaled),
      } as unknown as HorseDecision;
      const delivered = {
        ...f.d.decision,
        jointPolicy: receipt(journaled ? gate.stamp(worker.receipt()) : null),
      } as unknown as HorseDecision;
      const w = createHorseExecutionWitness(s, delivered, {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      });
      return { f, s, w };
    }
    const accept = (f: ReturnType<typeof fixture>, action: 'raise' | 'call', amount: number) => {
      const last = f.a.actions.at(-1) as Record<string, unknown>;
      f.a.actions[f.a.actions.length - 1] = { ...last, action, amount } as never;
      return [
        {
          record: { ...f.w.acceptedActions[0]!.record, action, amount },
          intended: true,
        },
      ];
    };

    it.each(['nlh', 'plo4', 'flo8', 'short_deck'] as const)(
      'reconciles an accepted %s joint selection: the reviewer recomputes the selected and baseline actions',
      (variant) => {
        const { f, w } = selectedCase(variant);
        recordHorsePhase13Verdict(w, 'usable');
        settleHorseExecutionWitness(w, { applied: true, acceptedActions: accept(f, 'raise', 4) });
        f.w = w;
        expect(w.executionStatus).toBe('intended');
        expect(w.phase13Authority).toMatchObject({
          selection: 'controller_accepted',
          verdict: 'usable',
          candidate: { action: 'raise', amount: 4 },
          reference: { action: 'call', amount: null },
        });
        expect(w).not.toHaveProperty('phase12Authority');
        expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
          status: 'reconciled',
          matchedActions: 1,
          gaps: [],
          activationAllowed: false,
        });
      }
    );

    it.each([
      [
        'a changed shadow baseline',
        (w: any): void => {
          w.phase13Authority.reference = { action: 'fold', amount: null };
        },
      ],
      [
        'a changed selected proposal',
        (w: any): void => {
          w.phase13Authority.candidate = { action: 'raise', amount: 6 };
        },
      ],
      [
        'acceptance without a usable verdict',
        (w: any): void => {
          w.phase13Authority.verdict = 'withdrawn';
        },
      ],
      [
        'a forged worker authority',
        (w: any): void => {
          w.phase13Authority.authority = { ...w.phase13Authority.authority, generation: 9 };
        },
      ],
      [
        'another receipt version',
        (w: any): void => {
          w.phase13Authority.continuationVersion = 'joint-multiway-round1-v3';
        },
      ],
      [
        'a dropped binding',
        (w: any): void => {
          delete w.phase13Authority;
        },
      ],
      [
        'the binding moved to the Phase 12 slot',
        (w: any): void => {
          w.phase12Authority = w.phase13Authority;
          delete w.phase13Authority;
        },
      ],
      [
        'the binding moved to the Phase 10 slot',
        (w: any): void => {
          w.phase10Authority = w.phase13Authority;
          delete w.phase13Authority;
        },
      ],
    ] as const)('rejects %s even when the accepted action matches', (_name, tamper) => {
      const { f, w } = selectedCase();
      recordHorsePhase13Verdict(w, 'usable');
      settleHorseExecutionWitness(w, { applied: true, acceptedActions: accept(f, 'raise', 4) });
      tamper(w);
      f.w = w;
      const report = reconcileHorseJournalHand(f.rows(), handKey);
      expect(report.status).toBe('incomplete');
      expect(report.matchedActions).toBe(0);
    });

    it.each([
      'honest',
      'tampered_reference',
      'claims_acceptance',
      'unusable_verdict_missing',
    ] as const)('reconciles a joint selection withdrawn before acceptance (%s)', (mode) => {
      const { f, s, w } = selectedCase();
      withdrawHorsePhase13Selection(w, s, 'withdrawn');
      if (mode === 'tampered_reference')
        (w as { selected: unknown }).selected = { action: 'raise', amount: 4 };
      settleHorseExecutionWitness(w, { applied: true, acceptedActions: f.w.acceptedActions });
      if (mode === 'claims_acceptance') w.phase13Authority!.selection = 'controller_accepted';
      if (mode === 'unusable_verdict_missing') w.phase13Authority!.verdict = null;
      f.w = w;
      expect(w.selected).toEqual(
        mode === 'tampered_reference'
          ? { action: 'raise', amount: 4 }
          : { action: 'call', amount: null }
      );
      expect(reconcileHorseJournalHand(f.rows(), handKey).status).toBe(
        mode === 'honest' ? 'reconciled' : 'incomplete'
      );
    });

    it('reconciles a joint shadow change and rejects one relabelled as selected', () => {
      const honest = selectedCase('plo4', false);
      settleHorseExecutionWitness(honest.w, {
        applied: true,
        acceptedActions: honest.f.w.acceptedActions,
      });
      honest.f.w = honest.w;
      expect(honest.w.phase13Authority).toMatchObject({
        mode: 'shadow',
        selection: 'shadow_change',
        authority: null,
      });
      expect(reconcileHorseJournalHand(honest.f.rows(), handKey).status).toBe('reconciled');
      const relabelled = selectedCase('plo4', false);
      settleHorseExecutionWitness(relabelled.w, {
        applied: true,
        acceptedActions: relabelled.f.w.acceptedActions,
      });
      relabelled.w.phase13Authority!.selection = 'selected';
      relabelled.f.w = relabelled.w;
      expect(reconcileHorseJournalHand(relabelled.f.rows(), handKey).status).toBe('incomplete');
    });
  });

  it('reconciles a coerced controller amount without calling it the intended wager', () => {
    const f = fixture();
    f.w.executionStatus = 'pending';
    const accepted = {
      ...f.w.acceptedActions[0]!,
      record: { ...f.w.acceptedActions[0]!.record, amount: 2 },
    };
    settleHorseExecutionWitness(f.w, { applied: true, acceptedActions: [accepted] });
    f.a.actions.at(-1)!.amount = 2;
    expect(f.w.executionStatus).toBe('coerced');
    expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
      status: 'reconciled',
      matchedActions: 1,
    });
  });
  it.each([false, true])(
    'checks the original deep RNG and request identity (changed=%s)',
    (changed) => {
      const f = fixture();
      const s = {
        ...f.d.snapshot,
        type: 'DECIDE_DEEP' as const,
        rngBefore: changed ? 99 : f.d.rngBefore,
        deepEquity: 2,
      };
      const { effects: _effects, ...deepCapture } = f.d;
      const d = { ...deepCapture, snapshot: s };
      const w = createHorseExecutionWitness(s, d.decision, {
        requestId: s.requestId,
        lane: 'deep',
        computeMs: 1,
        governorScale: 1,
      });
      settleHorseExecutionWitness(w, { applied: true, acceptedActions: f.w.acceptedActions });
      const report = reconcileHorseJournalHand(
        [f.make('decision', 1, d), f.make('execution', 2, w), f.rows()[2]!],
        handKey
      );
      expect(report.status).toBe(changed ? 'incomplete' : 'reconciled');
    }
  );
  it('will not merge evidence from different worker producers or trust an unknown action origin', () => {
    const f = fixture(),
      rows = f.rows();
    rows[1] = makeHorseJournalRecord({ ...rows[1]!, producerId: table }, f.w);
    expect(reconcileHorseJournalHand(rows, handKey).gaps).toEqual(
      expect.arrayContaining(['execution_missing', 'decision_missing', 'unmatched_horse_action'])
    );
    f.a.actions.at(-1)!.origin = 'unknown';
    expect(reconcileHorseJournalHand(f.rows(), handKey).gaps).toContain(
      'action_origin_unavailable'
    );
  });
  it('refuses invalid input, oversized populations and record identity conflicts', () => {
    const f = fixture(),
      rows = f.rows();
    for (const changed of [
      [{ ...rows[0]!, sha256: 'bad' }],
      Array(257).fill(rows[0]),
      [...rows, f.make('decision', 1, { changed: true })],
    ])
      expect(reconcileHorseJournalHand(changed, handKey).status).toBe('unavailable');
    expect(reconcileHorseJournalHand([], handKey)).toMatchObject({
      status: 'unavailable',
      gaps: ['accepted_hand_missing'],
    });
  });
});

describe('readHorseJournalHandRecords shard fan-out', () => {
  // A hand's records live in exactly one decision-shard's catalog. These
  // records are deliberately minimal (a bare 'decision' record) - the
  // fan-out under test only cares which shard directory holds a given
  // handKey, not whether a full hand reconciles.
  const shardProducer = '40000000-0000-4000-8000-000000000009';
  const record = (forHandKey: string, sequence: number): HorseJournalRecord =>
    makeHorseJournalRecord(
      {
        producerId: shardProducer,
        sequence,
        atMs: 1000,
        sourceRelease: null,
        kind: 'decision',
        handKey: forHandKey,
        turnKey: journalHash(`shard-fanout-turn:${forHandKey}:${sequence}`),
      },
      { shardFanoutFixture: true, sequence }
    );
  const openArchive = (dir: string, index: number) =>
    new HorseDecisionJournalStore(dir, {
      archive: runtimeHorseJournalArchiveOptions(dir, {}, { index }),
    });

  it('finds a hand whose records live in a later shard, not shard 0', () => {
    const dir = directory();
    const handInShard0 = journalHash('shard-fanout:lives-in-shard-0'),
      handInShard1 = journalHash('shard-fanout:lives-in-shard-1');
    const s0 = openArchive(dir, 0);
    try {
      s0.appendBatch([record(handInShard0, 1)]);
    } finally {
      s0.close();
    }
    const s1 = openArchive(dir, 1);
    try {
      s1.appendBatch([record(handInShard1, 1)]);
    } finally {
      s1.close();
    }
    expect(readHorseJournalHandRecords(dir, handInShard0)).toEqual([record(handInShard0, 1)]);
    expect(readHorseJournalHandRecords(dir, handInShard1)).toEqual([record(handInShard1, 1)]);
  });

  it('finds a hand in a later shard even when shard 0 has never been written', () => {
    const dir = directory();
    const handKeyHere = journalHash('shard-fanout:only-shard-1-exists');
    const s1 = openArchive(dir, 1);
    try {
      s1.appendBatch([record(handKeyHere, 1)]);
    } finally {
      s1.close();
    }
    expect(readHorseJournalHandRecords(dir, handKeyHere)).toEqual([record(handKeyHere, 1)]);
  });

  it('returns empty, not an error, when every existing shard is readable but none holds the hand', () => {
    const dir = directory();
    const s0 = openArchive(dir, 0);
    try {
      s0.appendBatch([record(journalHash('shard-fanout:present'), 1)]);
    } finally {
      s0.close();
    }
    expect(readHorseJournalHandRecords(dir, journalHash('shard-fanout:absent'))).toEqual([]);
  });

  it('is byte-for-byte the single-store behavior when only the unsharded archive exists', () => {
    const dir = directory();
    const handKeyHere = journalHash('shard-fanout:unsharded');
    const s0 = openArchive(dir, 0);
    try {
      s0.appendBatch([record(handKeyHere, 1)]);
    } finally {
      s0.close();
    }
    const reader = new HorseDecisionJournalStore(dir, {
      readOnly: true,
      archive: runtimeHorseJournalArchiveOptions(dir, {}, { index: 0 }),
    });
    let direct: readonly HorseJournalRecord[];
    try {
      direct = reader.readHand(handKeyHere);
    } finally {
      reader.close();
    }
    expect(readHorseJournalHandRecords(dir, handKeyHere)).toEqual(direct);
  });

  it('throws rather than silently returning nothing when no shard can be read at all', () => {
    const dir = join(directory(), 'never-created');
    expect(() =>
      readHorseJournalHandRecords(dir, journalHash('shard-fanout:no-storage'))
    ).toThrow();
  });
});

describe('Phase 15.1 plan-effect ledger from authoritative receipts', () => {
  const planProducer = '40000000-0000-4000-8000-000000000009';
  const planHand = journalHash('plan-ledger-hand');
  const planTurn = journalHash('plan-ledger-turn');
  async function issuedAndAccepted() {
    HorseMind.reset();
    const receipts: HorsePlanEffectReceipt[] = [];
    const h = planWorkerHarness({
      journalPlanReceipt: (_request, receipt) => {
        receipts.push(receipt);
      },
    });
    try {
      const result = await h.fast();
      h.runtime.receive(planCommitOf(result, 2));
      await h.runtime.drain();
      return { result, capture: h.captures[0]!, receipt: receipts[0]! };
    } finally {
      await h.close();
      HorseMind.reset();
    }
  }
  const witnessOf = (
    result: Awaited<ReturnType<typeof issuedAndAccepted>>['result'],
    amount = 6
  ) => ({
    identity: { requestId: result.requestId, decisionKey: result.planBinding.decisionKey },
    acceptedActions: [
      { record: { seat: 1, action: 'bet', amount, stage: 'flop' }, intended: true },
    ],
  });
  let sequence = 0;
  const row = (kind: HorseJournalRecord['kind'], payload: unknown, turnKey = planTurn) =>
    makeHorseJournalRecord(
      {
        producerId: planProducer,
        sequence: ++sequence,
        atMs: 1,
        sourceRelease: null,
        kind,
        handKey: planHand,
        turnKey,
      },
      payload
    );

  it('counts issued, accepted, durable and applied, and verifies application only from the receipt', async () => {
    const f = await issuedAndAccepted();
    const rows = [
      row('decision', f.capture),
      row('execution', witnessOf(f.result)),
      row('plan_receipt', f.receipt),
      row('accepted_hand', { hand: 'retained' }),
    ];
    expect(reviewHorsePlanEffects(rows, planHand)).toEqual({
      version: 1,
      scope: 'single_retained_hand',
      acceptedHandRetained: true,
      issued: 1,
      accepted: 1,
      durable: 1,
      applied: 1,
      failed: 0,
      unknown: 0,
      gaps: [],
      applicationVerified: true,
      replayVerified: false,
      completePopulation: false,
      activationAllowed: false,
    });
    // The existing turn join never mistakes a receipt for an execution.
    expect(reconcileHorseJournalHand(rows, planHand).gaps).not.toContain('turn_conflict');
  });

  it('keeps a failed receipt failed and an accepted batch without a receipt accepted, then unknown once the hand is retained', async () => {
    const f = await issuedAndAccepted();
    const failed = createHorsePlanEffectReceipt({ ...f.receipt, disposition: 'failed' });
    expect(
      reviewHorsePlanEffects(
        [
          row('decision', f.capture),
          row('execution', witnessOf(f.result)),
          row('plan_receipt', failed),
          row('accepted_hand', {}),
        ],
        planHand
      )
    ).toMatchObject({ durable: 1, applied: 0, failed: 1, applicationVerified: false });
    const pending = [row('decision', f.capture), row('execution', witnessOf(f.result))];
    expect(reviewHorsePlanEffects(pending, planHand)).toMatchObject({
      issued: 1,
      accepted: 1,
      durable: 0,
      unknown: 0,
      gaps: [],
      applicationVerified: false,
    });
    expect(reviewHorsePlanEffects([...pending, row('accepted_hand', {})], planHand)).toMatchObject({
      unknown: 1,
      gaps: ['plan_receipt_missing'],
      applicationVerified: false,
    });
    expect(reviewHorsePlanEffects([row('decision', f.capture)], planHand)).toMatchObject({
      issued: 1,
      accepted: 0,
      durable: 0,
    });
  });

  it('journal-only forged application never counts as applied', async () => {
    const f = await issuedAndAccepted();
    const forgedDigest = { ...structuredClone(f.receipt), issuedBatchDigest: 'f'.repeat(64) };
    const coerced = createHorsePlanEffectReceipt({
      ...f.receipt,
      acceptance: { ...f.receipt.acceptance, amount: 8 },
    });
    for (const rows of [
      // A receipt with no decision or execution behind it.
      [row('plan_receipt', f.receipt), row('accepted_hand', {})],
      // A receipt whose digest does not bind the retained batch.
      [
        row('decision', f.capture),
        row('execution', witnessOf(f.result)),
        row('plan_receipt', forgedDigest),
        row('accepted_hand', {}),
      ],
      // A receipt naming a wager the controller did not accept.
      [
        row('decision', f.capture),
        row('execution', witnessOf(f.result)),
        row('plan_receipt', coerced),
        row('accepted_hand', {}),
      ],
      // A receipt without the controller's acceptance.
      [row('decision', f.capture), row('plan_receipt', f.receipt), row('accepted_hand', {})],
    ]) {
      const review = reviewHorsePlanEffects(rows, planHand);
      expect(review.applied).toBe(0);
      expect(review.applicationVerified).toBe(false);
      expect(review.gaps).toContain('plan_receipt_unbound');
    }
    const conflict = reviewHorsePlanEffects(
      [
        row('decision', f.capture),
        row('execution', witnessOf(f.result)),
        row('plan_receipt', f.receipt),
        row('plan_receipt', createHorsePlanEffectReceipt({ ...f.receipt, disposition: 'failed' })),
        row('accepted_hand', {}),
      ],
      planHand
    );
    expect(conflict).toMatchObject({ applied: 0, unknown: 1, applicationVerified: false });
    expect(conflict.gaps).toContain('plan_receipt_conflict');
    expect(
      reviewHorsePlanEffects(
        [{ ...row('plan_receipt', f.receipt), sha256: '0'.repeat(64) }],
        planHand
      )
    ).toMatchObject({ gaps: ['invalid_records'], applied: 0 });
  });
});
