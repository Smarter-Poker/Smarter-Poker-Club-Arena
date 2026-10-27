/**
 * Phase 6C step (c): run the reconstructed request through the same
 * HorseDecisionWorkerRuntime production uses for a live FAST decision.
 *
 * The runtime is given production's HorseLogic, HorseMind capture and the
 * HorseEval stream, with three replay-specific bindings that production's own
 * deep second look also uses (workerRuntime.executeDeep):
 *   - the opponent reads come from the journaled read frame, in a HorseMind
 *     sandbox, and observation is off (the frame was captured after the
 *     original observation, so observing again would count the hand twice),
 *     and the read frame the runtime encodes after the decision is taken from
 *     that same sandbox, not from this process's own HorseMind;
 *   - the equity governor is pinned to the journaled scale;
 *   - nothing is journaled and no plan effect is applied.
 * Everything else, including envelope validation, the canonical-state and
 * Phase 6 M assertions, the RNG seed derivation and the compute clock, is the
 * runtime's own code path.
 */
import { performance } from 'node:perf_hooks';
import { HorseLogic } from '../../HorseLogic.js';
import { HorseMind } from '../../HorseMind.js';
import { equityGovernor } from '../../EquityLoadGovernor.js';
import { restoreFastRandom, saveFastRandom, equityWorkCounters } from '../../HorseEval.js';
import { drainFires, enableBrainTelemetry, restoreFires } from '../../BrainTelemetry.js';
import { decodeHorseDecisionReads } from '../../HorseDecisionReadFrame.js';
import { horsePlanHandKey } from '../../HorseDecisionEffects.js';
import { horsePlanBatchBindingFromRequest } from '../../HorsePlanHandIdentity.js';
import { prepareTournamentFutureHandFacts } from '../../HorseTournamentFutureHand.js';
import { solverPolicyArtifactStatus } from '../../../gto/SolverPolicyArtifactLoader.js';
import { liveHorsePhase8Safety } from '../../HorsePhase8Safety.js';
import {
  horseDecisionReplayAdmission,
  horseCorrectiveReplayState,
  type HorseCorrectiveReplayState,
  type HorseDecisionReplayAdmission,
} from '../replayState.js';
import type {
  FastHorseDecisionResult,
  DeepHorseDecisionResult,
  HorseDecisionWorkerError,
  HorseDecisionWorkerReadiness,
  HorseDecisionWorkerResponse,
} from '../protocol.js';
import {
  HorseDecisionWorkerRuntime,
  type HorseDecisionWorkerDependencies,
} from '../workerRuntime.js';
import { currentReplaySolverStores } from './references.js';
import type { HorseReplayInput } from './reconstruct.js';
import {
  qualifiedReplayAdmissions,
  qualifiedReplayAuthorityHolders,
} from './qualifiedAuthority.js';

export type HorseRuntimeReplayResult = Omit<
  FastHorseDecisionResult,
  'type' | 'planBinding' | 'planIssueDisposition'
> & {
  type: 'FAST_RESULT' | 'DEEP_RESULT';
  planBinding: FastHorseDecisionResult['planBinding'] | null;
  planIssueDisposition?: FastHorseDecisionResult['planIssueDisposition'];
  planContext?: DeepHorseDecisionResult['planContext'];
};
export interface HorseRuntimeReplayOutcome {
  result: HorseRuntimeReplayResult | null;
  error: HorseDecisionWorkerError | null;
  wallMs: number;
  features: string[];
  work: { equityCalls: number; equitySamples: number; telemetryFires: number };
  /** The optional-owner modes this replay's runtime passed to decide (null: not reached). */
  admission: HorseDecisionReplayAdmission | null;
  corrective: HorseCorrectiveReplayState | null;
  /** Private local observation, absent unless explicitly requested. */
  v56PressureRangeFires?: number | null;
}

/** P15-A exact replay: worker-owned state restored from the record, not read live. */
export interface HorseRuntimeReplayBindings {
  /** The Phase 8 safety sentinel the original decision read; restored afterwards. */
  phase8SafetyDisabledReason?: string | null;
  /** Private counterfactual arm only; never forwarded from an original request. */
  v56PressureCounterfactual?: 'off';
  captureV56PressureWitness?: boolean;
}

const readiness = (): HorseDecisionWorkerReadiness => {
  const { identity, charts, postflop, postflopV31, postflopV31Dataset } =
    currentReplaySolverStores();
  return {
    solverStores: { charts, postflop, postflopV31, postflopV31Dataset },
    solverStoreIdentity: identity,
    solverPolicyArtifact: solverPolicyArtifactStatus(),
    governor: equityGovernor.snapshot(),
  };
};

/** Drives one FAST request through a fresh runtime and returns its terminal message. */
export async function replayThroughWorkerRuntime(
  input: HorseReplayInput,
  bindings: HorseRuntimeReplayBindings = {}
): Promise<HorseRuntimeReplayOutcome> {
  if (bindings.v56PressureCounterfactual === 'off' && input.deepRequest)
    throw new Error('V56 counterfactual supports original FAST only');
  const request = input.request;
  const planContext = horsePlanBatchBindingFromRequest(request).planContext;
  const readView = decodeHorseDecisionReads(
    input.readFrame,
    request.gameState.players,
    horsePlanHandKey(request.gameState.actionHistory, planContext),
    planContext
  );
  const messages: HorseDecisionWorkerResponse[] = [];
  const features: string[] = [];
  let admission: HorseDecisionReplayAdmission | null = null;
  let v56WitnessCaptured = false;
  let corrective: HorseCorrectiveReplayState | null = null;
  let deepRngAfter: number | null = null;
  const deps: HorseDecisionWorkerDependencies = {
    ...qualifiedReplayAdmissions,
    // Local capture only, never an external writer. DEEP has no RNG/effects
    // fields on IPC; use the production journal capture before RNG restoration.
    journalEnabled: () => !!input.deepRequest,
    journalDecision: (snapshot, body) => {
      if (
        'type' in snapshot &&
        snapshot.type === 'DECIDE_DEEP' &&
        body &&
        typeof body === 'object' &&
        'rngAfter' in body &&
        typeof body.rngAfter === 'number'
      )
        deepRngAfter = body.rngAfter;
    },
    async startServices() {
      prepareTournamentFutureHandFacts();
      return readiness();
    },
    async stopServices() {},
    // runDecisionReadView below already installs the historical sandbox
    // around FAST; a second sandbox here would be refused as nested.
    prepareOriginalReads: (player, gameState, opts) =>
      HorseLogic.prepareOriginalReads(player, gameState, { ...opts, observeMind: false }),
    decide: (player, gameState, style, mods, opts) => {
      admission = horseDecisionReplayAdmission(opts);
      v56WitnessCaptured = opts?.telemetry === true;
      corrective = horseCorrectiveReplayState(gameState, opts?.phase14, opts?.phase14Corrective);
      return HorseLogic.decide(player, gameState, style, mods, {
        ...opts,
        observeMind: false,
        ...(bindings.v56PressureCounterfactual === 'off' ? { v56OmahaPressureRange: false } : {}),
      });
    },
    decideDiscard: HorseLogic.decideDiscard.bind(HorseLogic),
    runDecisionReadView: (_request, fn) => HorseMind.runInSandbox(readView, fn),
    captureDecisionEffects: (fn) => HorseMind.captureDecisionEffects(fn),
    applyDecisionEffects: () => {
      throw new Error('a replay never applies plan effects');
    },
    // The frame is re-encoded from the view the replay decided in, never from
    // whatever this process's own HorseMind holds.
    snapshotDecisionReads: (players, handKey) => HorseMind.snapshotDecisionReads(players, handKey),
    saveRng: saveFastRandom,
    restoreRng: restoreFastRandom,
    governorScale: () => equityGovernor.current(),
    atGovernorScale: (fn) => equityGovernor.withDecisionScale(fn),
    workerReadiness: readiness,
    observeCompletedHand: () => {},
    noteDecision: () => {},
    noteFeature: (feature) => {
      features.push(feature);
    },
    now: () => performance.now(),
  };
  const runtime = new HorseDecisionWorkerRuntime(
    (message) => messages.push(message),
    deps,
    undefined,
    qualifiedReplayAuthorityHolders(input.original, request.gameState.gameVariant ?? 'nlh')
  );
  // Qualification/refusal happens before touching process telemetry. The
  // same production telemetry paths run only after a holder can be rebuilt.
  enableBrainTelemetry();
  const parkedFires = drainFires();
  const before = equityWorkCounters();
  const canonicalRng = saveFastRandom();
  const parkedSafety = liveHorsePhase8Safety.disabledReason;
  equityGovernor.__setScaleForTest(input.originalFast?.governorScale ?? input.governorScale);
  const startedAt = performance.now();
  let fires: ReturnType<typeof drainFires> = [];
  try {
    if (bindings.phase8SafetyDisabledReason !== undefined)
      liveHorsePhase8Safety.disabledReason = bindings.phase8SafetyDisabledReason;
    await runtime.start();
    runtime.receive(request);
    await runtime.drain();
    if (input.deepRequest) {
      equityGovernor.__setScaleForTest(input.governorScale);
      runtime.receive(input.deepRequest);
      await runtime.drain();
    }
  } finally {
    liveHorsePhase8Safety.disabledReason = parkedSafety;
    equityGovernor.__setScaleForTest(null);
    restoreFastRandom(canonicalRng);
    fires = drainFires();
    restoreFires(parkedFires);
  }
  const wallMs = performance.now() - startedAt;
  const after = equityWorkCounters();

  const fastResult =
    messages.find(
      (m): m is FastHorseDecisionResult =>
        m.type === 'FAST_RESULT' && m.requestId === request.requestId
    ) ?? null;
  const deepResult = input.deepRequest
    ? messages.find(
        (m): m is DeepHorseDecisionResult =>
          m.type === 'DEEP_RESULT' && m.requestId === input.deepRequest!.requestId
      )
    : null;
  const result: HorseRuntimeReplayResult | null = input.deepRequest
    ? deepResult && deepRngAfter !== null
      ? {
          ...deepResult,
          rngBefore: input.deepRequest.rngBefore,
          rngAfter: deepRngAfter,
          effects: [],
          planBinding: null,
        }
      : null
    : fastResult;
  const error = messages.find((m): m is HorseDecisionWorkerError => m.type === 'ERROR') ?? null;
  return {
    result,
    error,
    wallMs,
    features,
    admission,
    corrective,
    ...(bindings.captureV56PressureWitness
      ? {
          v56PressureRangeFires:
            v56WitnessCaptured && !input.deepRequest
              ? (fires.find((row) => row.feature === 'v56_omaha_pressure_range')?.fires ?? 0)
              : null,
        }
      : {}),
    work: {
      equityCalls: after.calls - before.calls,
      equitySamples: after.samples - before.samples,
      telemetryFires: fires.reduce((n, row) => n + row.fires, 0),
    },
  };
}
