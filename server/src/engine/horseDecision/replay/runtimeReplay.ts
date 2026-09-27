/**
 * Phase 6C step (c): run the reconstructed request through the same
 * HorseDecisionWorkerRuntime production uses for a live FAST decision.
 *
 * The runtime is given production's HorseLogic, HorseMind capture and the
 * HorseEval stream, with three replay-specific bindings that production's own
 * deep second look also uses (workerRuntime.executeDeep):
 *   - the opponent reads come from the journaled read frame, in a HorseMind
 *     sandbox, and observation is off (the frame was captured after the
 *     original observation, so observing again would count the hand twice);
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
import type {
  FastHorseDecisionResult,
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

export interface HorseRuntimeReplayOutcome {
  result: FastHorseDecisionResult | null;
  error: HorseDecisionWorkerError | null;
  wallMs: number;
  features: string[];
  work: { equityCalls: number; equitySamples: number; telemetryFires: number };
}

const readiness = (): HorseDecisionWorkerReadiness => ({
  solverStores: currentReplaySolverStores(),
  solverPolicyArtifact: solverPolicyArtifactStatus(),
  governor: equityGovernor.snapshot(),
});

/** Drives one FAST request through a fresh runtime and returns its terminal message. */
export async function replayThroughWorkerRuntime(
  input: HorseReplayInput
): Promise<HorseRuntimeReplayOutcome> {
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
  const deps: HorseDecisionWorkerDependencies = {
    journalEnabled: () => false,
    async startServices() {
      prepareTournamentFutureHandFacts();
      return readiness();
    },
    async stopServices() {},
    decide: (player, gameState, style, mods, opts) =>
      HorseLogic.decide(player, gameState, style, mods, { ...opts, observeMind: false }),
    decideDiscard: HorseLogic.decideDiscard.bind(HorseLogic),
    captureDecisionEffects: (fn) =>
      HorseMind.runInSandbox(readView, () => HorseMind.captureDecisionEffects(fn)),
    applyDecisionEffects: () => {
      throw new Error('a replay never applies plan effects');
    },
    saveRng: saveFastRandom,
    restoreRng: restoreFastRandom,
    governorScale: () => equityGovernor.current(),
    workerReadiness: readiness,
    observeCompletedHand: () => {},
    noteDecision: () => {},
    noteFeature: (feature) => {
      features.push(feature);
    },
    now: () => performance.now(),
  };
  // Production arms telemetry at boot and the FAST path decides with it on;
  // the same code paths must be taken here (utility budgets, safety gates).
  enableBrainTelemetry();
  const parkedFires = drainFires();
  const before = equityWorkCounters();
  const runtime = new HorseDecisionWorkerRuntime((message) => messages.push(message), deps);
  const canonicalRng = saveFastRandom();
  equityGovernor.__setScaleForTest(input.governorScale);
  const startedAt = performance.now();
  try {
    await runtime.start();
    runtime.receive(request);
    await runtime.drain();
  } finally {
    equityGovernor.__setScaleForTest(null);
    restoreFastRandom(canonicalRng);
  }
  const wallMs = performance.now() - startedAt;
  const after = equityWorkCounters();
  const fires = drainFires();
  restoreFires(parkedFires);
  const result =
    messages.find(
      (m): m is FastHorseDecisionResult =>
        m.type === 'FAST_RESULT' && m.requestId === request.requestId
    ) ?? null;
  const error = messages.find((m): m is HorseDecisionWorkerError => m.type === 'ERROR') ?? null;
  return {
    result,
    error,
    wallMs,
    features,
    work: {
      equityCalls: after.calls - before.calls,
      equitySamples: after.samples - before.samples,
      telemetryFires: fires.reduce((n, row) => n + row.fires, 0),
    },
  };
}
