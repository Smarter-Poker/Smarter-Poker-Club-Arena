/** Isolated paired adapter through the unmodified actual worker and its
 * original independent observer view, issue owner and accepted-effect path.
 * No authority injection, database loader, persistence, journal or timer. */
import type { ActionRecord, HorseDecision } from '../types.js';
import { drainFires, restoreFires } from '../engine/BrainTelemetry.js';
import {
  horsePlanAcceptanceFromController,
  horsePlanWagerAcceptedExactly,
} from '../engine/HorsePlanEffectReceipt.js';
import { horsePhase6AttributionMismatch } from '../engine/HorsePhase6Attribution.js';
import {
  horseDecisionReceiptRefusal,
  horsePhase7EvidenceMismatch,
  horseComputeMetadataIsValid,
} from '../engine/horseDecision/responseValidation.js';
import { captureHorseHandJournalContext } from '../engine/HorseDecisionHandBinding.js';
import { saveFastRandom, restoreFastRandom } from '../engine/HorseEval.js';
import {
  HorseDecisionWorkerRuntime,
  defaultHorseDecisionWorkerDependencies,
} from '../engine/horseDecision/workerRuntime.js';
import {
  buildHorseDecisionKey,
  validatedHorsePolicySamplingKey,
  type FastHorseDecisionRequest,
  type FastHorseDecisionResult,
  type LiveHorseDecideOpts,
  type HorseDecisionWorkerResponse,
} from '../engine/horseDecision/protocol.js';
import type { HorseOwnPublicHistoryPacket } from '../engine/horseDecision/ownPublicHistory.js';
import {
  mirrorFeatureAblationAcceptance,
  forgetFeatureAblationWorkerMirrors,
} from './FeatureAblationAcceptance.js';
import type { HorseObserverReadReceipt } from '../engine/horseDecision/observerReads.js';
import type { Plo4AblationBrain } from './Plo4PolicyLeague.js';
export interface FeatureAblationWorkerReceipt {
  acceptance: { appliedAuthorityChecks: number; phase14Rechecked: boolean };
  observerReads: HorseObserverReadReceipt | null;
  decisionKey: string;
  actorSeat: number;
  inputFlags: { v24PloDefense?: boolean; v53Pressure?: boolean };
  naturalSamplingKey: string;
  naturalRngBefore: number;
  controlledRngBefore: number;
  restoredCanonical: boolean;
  policyReceipts: {
    phase10?: HorseDecision['plo4Policy'];
    phase11?: HorseDecision['omahaVariantPolicy'];
    phase12?: HorseDecision['remainingVariantPolicy'];
    phase13?: HorseDecision['jointPolicy'];
    phase14?: HorseDecision['correctivePolicy'];
    fallback?: HorseDecision['policyFallback'];
  };
  phase8Authority: FastHorseDecisionResult['phase8Authority'];
  phase10Authority: FastHorseDecisionResult['phase10Authority'];
  phase11Authority: FastHorseDecisionResult['phase11Authority'];
  phase12Authority: FastHorseDecisionResult['phase12Authority'];
  phase13Authority: FastHorseDecisionResult['phase13Authority'];
  phase14Authority: FastHorseDecisionResult['phase14Authority'];
}
export function validateFeatureAblationPlanAck(
  response: HorseDecisionWorkerResponse | undefined,
  expected: {
    requestId: number;
    generation: number;
    fence: string;
    operation: 'COMMIT_DECISION_EFFECTS' | 'RETIRE_DECISION_EFFECTS';
  }
): string {
  if (
    response?.type !== 'ACK' ||
    response.requestId !== expected.requestId ||
    response.generation !== expected.generation ||
    response.fence !== expected.fence ||
    response.operation !== expected.operation
  )
    throw Error('Offline plan terminal identity mismatch');
  const allowed =
    expected.operation === 'COMMIT_DECISION_EFFECTS'
      ? ['applied_volatile', 'already_applied_volatile']
      : ['retired', 'already_retired', 'already_applied_volatile'];
  if (!response.planDisposition || !allowed.includes(response.planDisposition))
    throw Error(`Offline plan refused: ${response.planDisposition ?? 'missing'}`);
  return response.planDisposition;
}
export function createFeatureAblationWorker(
  onReceipt: (r: FeatureAblationWorkerReceipt) => void = () => {},
  onPlanResolved: (disposition: string, effects: number) => void = () => {},
  collectEvaluationFires = false,
  historyForRequest?: (request: FastHorseDecisionRequest) => HorseOwnPublicHistoryPacket | undefined
): Plo4AblationBrain {
  let runtime: HorseDecisionWorkerRuntime | undefined,
    active = false,
    nextId = 0;
  let messages: HorseDecisionWorkerResponse[] = [],
    evaluationFires: Record<string, number> = {};
  let canonical = 0,
    armed = false,
    restores = 0,
    actualSeed: number | undefined,
    naturalRestoreSeed: number | undefined;
  let observationClockMs = 0;
  let lastFast: FastHorseDecisionResult | undefined;
  let observedReads: HorseObserverReadReceipt | null = null;
  let planDispositions: Record<string, number> = {};
  const loadedHistories = new Set<string>();
  let pending: { request: FastHorseDecisionRequest; result: FastHorseDecisionResult } | undefined;
  const terminal = async (
    commit: boolean,
    decision?: HorseDecision,
    records: readonly Readonly<ActionRecord>[] = []
  ) => {
    if (!pending) return;
    if (!runtime) throw Error('Original offline worker unavailable');
    const { request, result } = pending;
    messages = [];
    const submitted = {
      action: decision?.action ?? result.decision.action,
      amount: decision?.amount ?? null,
    };
    const exact =
      commit &&
      decision &&
      horsePlanWagerAcceptedExactly({
        issued: result.decision,
        submitted,
        acceptedActions: records.map((record) => ({ intended: true, record })),
        witness: null,
      });
    const terminalId = ++nextId;
    const operation =
      exact && (decision.action === 'bet' || decision.action === 'raise')
        ? 'COMMIT_DECISION_EFFECTS'
        : 'RETIRE_DECISION_EFFECTS';
    if (operation === 'COMMIT_DECISION_EFFECTS')
      runtime.receive({
        type: 'COMMIT_DECISION_EFFECTS',
        requestId: terminalId,
        generation: request.generation,
        fence: request.fence,
        planBinding: result.planBinding,
        effects: result.effects,
        acceptance: horsePlanAcceptanceFromController(records[0], submitted, null),
      });
    else
      runtime.receive({
        type: 'RETIRE_DECISION_EFFECTS',
        requestId: terminalId,
        generation: request.generation,
        fence: request.fence,
        planBinding: result.planBinding,
        reason: 'decision_finalized',
      });
    try {
      await runtime.drain();
      const failure = messages.find((m) => m.type === 'ERROR'),
        ack = messages.find((m) => m.type === 'ACK');
      if (failure?.type === 'ERROR') {
        onPlanResolved(`refused:${failure.planRefusal ?? failure.message}`, result.effects.length);
        throw Error(
          `Offline accepted plan effect refused: ${failure.planRefusal ?? failure.message}`
        );
      }
      const disposition = validateFeatureAblationPlanAck(ack, {
        requestId: terminalId,
        generation: request.generation,
        fence: request.fence,
        operation,
      });
      planDispositions[disposition] = (planDispositions[disposition] ?? 0) + result.effects.length;
      onPlanResolved(disposition, result.effects.length);
    } finally {
      pending = undefined;
    }
  };
  return {
    id: 'current-worker-original-observer-controlled-crn-v1',
    takePlanDispositions() {
      const out = planDispositions;
      planDispositions = {};
      return out;
    },
    takeEvaluationFires() {
      const out = evaluationFires;
      evaluationFires = {};
      return out;
    },
    async beginHand() {
      if (runtime || active || pending) throw Error('Offline worker physical hands must be serial');
      loadedHistories.clear();
      planDispositions = {};
      const readiness = defaultHorseDecisionWorkerDependencies.workerReadiness();
      // HorseObserverReads captures Date.now in its original constructor.
      // Bind only that process-local observation clock, synchronously, then
      // restore the real clock before admissions/start/any awaited work.
      const wallClock = Date.now;
      try {
        Date.now = () => observationClockMs;
        runtime = new HorseDecisionWorkerRuntime((m) => messages.push(m), {
          ...defaultHorseDecisionWorkerDependencies,
          startServices: async () => readiness,
          stopServices: async () => {},
          // Capture only the original worker's public read receipt in memory;
          // every durable writer/service remains absent.
          journalEnabled: () => true,
          journalDecision: (_request, capture) => {
            if (capture && typeof capture === 'object' && 'observerReads' in capture)
              observedReads =
                (capture as { observerReads?: HorseObserverReadReceipt | null }).observerReads ??
                null;
          },
          journalExecution: undefined,
          journalAcceptedHand: undefined,
          journalDiscard: undefined,
          journalDiscardExecution: undefined,
          journalLifecycle: undefined,
          journalPlanReceipt: undefined,
          noteFeature: () => {},
          // All ordinary internal read and issued-view ownership is retained.
          restoreRng(state) {
            if (!armed) throw Error('Unexpected RNG restore outside one offline decision');
            restores++;
            if (restores === 1) {
              naturalRestoreSeed = state;
              restoreFastRandom(canonical);
              actualSeed = saveFastRandom();
            } else if (restores === 2 && state === canonical) restoreFastRandom(state);
            else throw Error('Unexpected worker RNG restore sequence');
          },
          decide: (p, gs, s, mods, opts) =>
            defaultHorseDecisionWorkerDependencies.decide(p, gs, s, mods, {
              ...opts,
              telemetry: collectEvaluationFires,
            }),
        });
      } finally {
        Date.now = wallClock;
      }
      await runtime.start();
    },
    async decide(player, gameState, style, opts, _sandbox, coordinate) {
      if (!runtime || active || pending)
        throw Error('Offline decision requires its serial original hand worker');
      active = true;
      canonical = saveFastRandom();
      restores = 0;
      actualSeed = undefined;
      naturalRestoreSeed = undefined;
      const parked = collectEvaluationFires ? drainFires() : [];
      messages = [];
      observedReads = null;
      try {
        const { decisionTimeMs = 0, telemetry: _telemetry, ...liveOpts } = opts;
        const generation = gameState.actionHistory?.length ?? 0;
        const request: FastHorseDecisionRequest = {
          handJournalContext: captureHorseHandJournalContext(gameState.actionHistory ?? []),
          type: 'DECIDE_FAST',
          requestId: ++nextId,
          generation,
          fence: `${coordinate.tableId}:${coordinate.handNumber}:${player.seat}:00000000-0000-4000-8000-000000000001:${generation}`,
          decisionTimeMs,
          decisionKey: '',
          player,
          gameState,
          style,
          mods: {},
          opts: liveOpts as LiveHorseDecideOpts,
        };
        const history = historyForRequest?.(request);
        if (history) {
          if (!loadedHistories.has(history.digest)) request.ownPublicHistory = history;
          request.ownPublicHistoryState = 'available';
        }
        request.decisionKey = buildHorseDecisionKey(request);
        observationClockMs = request.decisionTimeMs;
        armed = true;
        runtime.receive(request);
        await runtime.drain();
        armed = false;
        const error = messages.find((m) => m.type === 'ERROR');
        if (error?.type === 'ERROR')
          throw Error(`Offline current worker refused: ${error.message}`);
        const result = messages.find((m) => m.type === 'FAST_RESULT');
        if (
          result?.type !== 'FAST_RESULT' ||
          result.requestId !== request.requestId ||
          result.generation !== request.generation ||
          result.fence !== request.fence ||
          result.planBinding.decisionKey !== request.decisionKey ||
          result.planBinding.fastRequestId !== request.requestId ||
          !horseComputeMetadataIsValid(result) ||
          result.governorScale !== 1 ||
          restores !== 2 ||
          result.rngBefore !== naturalRestoreSeed ||
          actualSeed !== canonical ||
          saveFastRandom() !== canonical
        )
          throw Error('Offline current worker missing exact controlled/restored RNG receipt');
        const refusal =
          horseDecisionReceiptRefusal(result.decision, request.gameState.gameVariant, {
            player: request.player,
            gameState: request.gameState,
          }) ??
          horsePhase6AttributionMismatch(result.decision, request) ??
          horsePhase7EvidenceMismatch(result.decision, request);
        if (refusal !== null)
          throw Error(`Original client refused scientific worker receipt: ${refusal}`);
        const readReceipt = observedReads as HorseObserverReadReceipt | null;
        if (history) {
          if (
            result.observerHistoryAckDigest !== history.digest ||
            readReceipt?.disposition !== 'independent' ||
            readReceipt.history !== 'own_public_window' ||
            readReceipt.historyDigest !== history.digest
          )
            throw Error(
              'Original worker history refusal: ' +
                JSON.stringify({
                  disposition: readReceipt?.disposition,
                  history: readReceipt?.history,
                  ack: result.observerHistoryAckDigest ?? null,
                  observedDigest: readReceipt?.historyDigest ?? null,
                  expectedDigest: history.digest,
                  cutoffMs: request.decisionTimeMs,
                  learnedThroughMs: readReceipt?.learnedThroughMs,
                  handNumber: coordinate.handNumber,
                  actorSeat: player.seat,
                  generation,
                })
            );
          loadedHistories.add(history.digest);
        }
        lastFast = result;
        const acceptance = mirrorFeatureAblationAcceptance(result);
        onReceipt({
          acceptance: {
            appliedAuthorityChecks: acceptance.appliedAuthorityChecks,
            phase14Rechecked: acceptance.phase14Rechecked,
          },
          observerReads: readReceipt,
          decisionKey: request.decisionKey,
          actorSeat: player.seat,
          inputFlags: {
            v24PloDefense: request.opts?.v24PloDefense,
            v53Pressure: request.opts?.v53Pressure,
          },
          naturalSamplingKey: validatedHorsePolicySamplingKey(request),
          naturalRngBefore: result.rngBefore,
          controlledRngBefore: actualSeed,
          restoredCanonical: true,
          policyReceipts: {
            phase10: result.decision.plo4Policy,
            phase11: result.decision.omahaVariantPolicy,
            phase12: result.decision.remainingVariantPolicy,
            phase13: result.decision.jointPolicy,
            phase14: result.decision.correctivePolicy,
            fallback: result.decision.policyFallback,
          },
          phase8Authority: result.phase8Authority,
          phase10Authority: result.phase10Authority,
          phase11Authority: result.phase11Authority,
          phase12Authority: result.phase12Authority,
          phase13Authority: result.phase13Authority,
          phase14Authority: result.phase14Authority,
        });
        if (result.effects.length) pending = { request, result };
        return result.decision;
      } finally {
        armed = false;
        if (collectEvaluationFires) {
          evaluationFires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
          restoreFires(parked);
        }
        restoreFastRandom(canonical);
        active = false;
      }
    },
    async accepted(decision, records) {
      await terminal(true, decision, records);
    },
    async endHand() {
      if (active) throw Error('Cannot end a computing offline physical hand');
      if (!runtime) return;
      try {
        await terminal(false);
        runtime.receive({ type: 'SHUTDOWN' });
        await runtime.drain();
      } finally {
        if (lastFast) forgetFeatureAblationWorkerMirrors(lastFast);
        lastFast = undefined;
        runtime = undefined;
        pending = undefined;
        messages = [];
      }
    },
  };
}
