import { horseTournamentProvenanceMatchesSnapshot } from '../HorseTournamentContextProvenance.js';
import {
  horsePlanContextFromDecision,
  horsePlanBatchBindingFromRequest,
  horsePlanBatchBindingIsValid,
  horsePlanBatchBindingKey,
  type HorsePlanBatchBinding,
  type HorsePlanIssueDisposition,
  type HorsePlanRefusal,
} from '../HorsePlanHandIdentity.js';
import { performance } from 'node:perf_hooks';
import {
  startHorseDecisionJournal,
  stopHorseDecisionJournal,
  journalHorseDecision,
  journalHorseExecution,
  journalHorseAcceptedHand,
  journalHorseDiscard,
  journalHorseDiscardExecution,
  journalHorseRequestLifecycle,
  horseDecisionJournalConfigured,
} from '../../services/HorseDecisionJournal.js';
import { horseJournalJson } from '../../services/horseDecisionJournal/record.js';
import { validateHorseDiscardExecution } from '../../services/horseDecisionJournal/discard.js';
import {
  horseLifecycleKeys,
  horseLifecycleRequestDigest,
  isHorseLifecycleRequest,
  type HorseLifecycleRequest,
  type HorseLifecycleOutcome,
  type HorseLifecycleOrigin,
} from '../../services/horseDecisionJournal/lifecycle.js';

import { HorseLogic } from '../HorseLogic.js';
import { HorseMind } from '../HorseMind.js';
import { completedHandActionsForMind } from './completedHandActions.js';
import {
  horseMindHandFromDecision,
  horseMindHandFromCompletion,
} from '../HorseMindHandIdentity.js';
import {
  encodeHorseDecisionReads,
  decodeHorseDecisionReads,
  type HorseDecisionReadFrame,
} from '../HorseDecisionReadFrame.js';
import {
  horseDecisionEffectsAreValid,
  horseDecisionEffectsKey,
  horseDecisionEffectsMatchRequest,
  horsePlanHandKey,
  horseReferenceWagerWasRetained,
} from '../HorseDecisionEffects.js';
import { prepareTournamentFutureHandFacts } from '../HorseTournamentFutureHand.js';
import type { CapturedHorseMindDecision, HorseMindDecisionEffect } from '../HorseMind.js';
import { restoreFastRandom, saveFastRandom } from '../HorseEval.js';
import { equityGovernor } from '../EquityLoadGovernor.js';
import { bettingStructureFor } from '../BettingStructure.js';
import { calculateContestablePot } from '../PokerEngine.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import { horsePolicyRegistration } from '../HorsePolicyRegistry.js';
import { buildJointCardLayout, type JointCardLayoutInput } from '../multiway/JointCardLayout.js';
import { validateDealtSeatCensus } from '../multiway/DealtSeatCensus.js';
import { buildTournamentMState, TOURNAMENT_CONTEXT_INCOMPLETE } from '../HorseTournamentPreflop.js';
import { noteDecisionMs, noteFire } from '../BrainTelemetry.js';
import { gtoChartCount } from '../GtoCharts.js';
import { gtoPostflopCount } from '../GtoPostflop.js';
import { gtoPostflopV31Count, gtoPostflopV31Dataset } from '../GtoPostflopV31.js';
import { hydrateHorseMind } from '../../services/HorseMindHydrator.js';
import {
  hydrateHorseMindFromDb,
  startHorseMindPersistence,
  stopHorseMindPersistence,
} from '../../services/HorseMindPersistence.js';
import {
  startBrainTelemetryFlush,
  stopBrainTelemetryFlush,
} from '../../services/BrainTelemetryFlush.js';
import {
  loadGtoCharts,
  startGtoChartLoader,
  stopGtoChartLoader,
} from '../../services/GtoChartLoader.js';
import {
  loadGtoPostflop,
  startGtoPostflopLoader,
  stopGtoPostflopLoader,
} from '../../services/GtoPostflopLoader.js';
import {
  loadGtoPostflopV31,
  startGtoPostflopV31Loader,
  stopGtoPostflopV31Loader,
} from '../../services/GtoPostflopV31Loader.js';
import {
  solverPolicyArtifactStatus,
  startSolverPolicyArtifactLoader,
  stopSolverPolicyArtifactLoader,
} from '../../gto/SolverPolicyArtifactLoader.js';
import type {
  DeepHorseDecisionRequest,
  DecidePineappleDiscardRequest,
  FastHorseDecisionRequest,
  HorseDecisionJobRequest,
  HorseDecisionWorkerRequest,
  HorseDecisionWorkerReadiness,
  HorseDecisionWorkerResponse,
  ObserveCompletedHandRequest,
  CommitDecisionEffectsRequest,
  RetireDecisionEffectsRequest,
  HorseDecisionStatusRequest,
} from './protocol.js';
import { buildHorseDecisionKey, validatedHorsePolicySamplingKey } from './protocol.js';

export interface HorseDecisionWorkerDependencies {
  journalEnabled?: () => boolean;
  journalDecision?: typeof journalHorseDecision;
  journalExecution?: typeof journalHorseExecution;
  journalAcceptedHand?: typeof journalHorseAcceptedHand;
  journalDiscard?: typeof journalHorseDiscard;
  journalDiscardExecution?: typeof journalHorseDiscardExecution;
  journalLifecycle?: typeof journalHorseRequestLifecycle;
  startServices(): Promise<HorseDecisionWorkerReadiness>;
  stopServices(): Promise<void>;
  decide: typeof HorseLogic.decide;
  decideDiscard: typeof HorseLogic.decideDiscard;
  captureDecisionEffects<T>(fn: () => T): CapturedHorseMindDecision<T>;
  applyDecisionEffects(effects: readonly HorseMindDecisionEffect[]): void;
  saveRng(): number;
  restoreRng(state: number): void;
  governorScale(): number;
  workerReadiness(): HorseDecisionWorkerReadiness;
  observeCompletedHand(request: ObserveCompletedHandRequest): void;
  noteDecision(scope: string, ms: number): void;
  noteFeature(feature: string): void;
  now(): number;
}

let ownedServicesStarted = false;

/**
 * Start every mutable service consumed by HorseLogic inside the worker that
 * owns HorseLogic. READY is withheld until the durable mind and all solver
 * stores have completed their initial hydration.
 */
async function startOwnedServices(): Promise<HorseDecisionWorkerReadiness> {
  if (ownedServicesStarted) {
    return {
      solverStores: {
        charts: gtoChartCount(),
        postflop: gtoPostflopCount(),
        postflopV31: gtoPostflopV31Count(),
        postflopV31Dataset: gtoPostflopV31Dataset(),
      },
      solverPolicyArtifact: solverPolicyArtifactStatus(),
      governor: equityGovernor.snapshot(),
    };
  }
  ownedServicesStarted = true;

  try {
    // Persistence starts before hydration, matching the production invariant:
    // a slow read may never prevent newly learned rows from becoming flushable.
    startHorseMindPersistence();
    startBrainTelemetryFlush();
    startHorseDecisionJournal();
    equityGovernor.startSampling();
    startSolverPolicyArtifactLoader();

    const lastFlush = await hydrateHorseMindFromDb();
    await Promise.all([
      hydrateHorseMind(lastFlush),
      loadGtoCharts(),
      loadGtoPostflop(),
      loadGtoPostflopV31(),
    ]);

    // The fixed rollout population belongs to this worker. Prepare its card
    // facts before READY so the first eligible decisions pay no scoring cost.
    prepareTournamentFutureHandFacts();

    // Periodic refresh begins only after the first authoritative load. The
    // loader start functions are idempotent and own unref'd timers.
    startGtoChartLoader();
    startGtoPostflopLoader();
    startGtoPostflopV31Loader();

    return {
      solverStores: {
        charts: gtoChartCount(),
        postflop: gtoPostflopCount(),
        postflopV31: gtoPostflopV31Count(),
        postflopV31Dataset: gtoPostflopV31Dataset(),
      },
      solverPolicyArtifact: solverPolicyArtifactStatus(),
      governor: equityGovernor.snapshot(),
    };
  } catch (error) {
    await stopOwnedServices();
    throw error;
  }
}

/** Stop clocks first, then drain the two durable writers. Idempotent. */
async function stopOwnedServices(): Promise<void> {
  if (!ownedServicesStarted) return;
  ownedServicesStarted = false;
  stopGtoPostflopV31Loader();
  stopGtoPostflopLoader();
  stopGtoChartLoader();
  stopSolverPolicyArtifactLoader();
  equityGovernor.stopSampling();
  await stopHorseDecisionJournal();
  await Promise.all([stopBrainTelemetryFlush(), stopHorseMindPersistence()]);
}

export const defaultHorseDecisionWorkerDependencies: HorseDecisionWorkerDependencies = {
  journalEnabled: horseDecisionJournalConfigured,
  journalDecision: journalHorseDecision,
  journalExecution: journalHorseExecution,
  journalAcceptedHand: journalHorseAcceptedHand,
  journalDiscard: journalHorseDiscard,
  journalDiscardExecution: journalHorseDiscardExecution,
  journalLifecycle: journalHorseRequestLifecycle,
  startServices: startOwnedServices,
  stopServices: stopOwnedServices,
  decide: HorseLogic.decide.bind(HorseLogic),
  decideDiscard: HorseLogic.decideDiscard.bind(HorseLogic),
  captureDecisionEffects: (fn) => HorseMind.captureDecisionEffects(fn),
  applyDecisionEffects: (effects) => HorseMind.applyDecisionEffects(effects),
  saveRng: saveFastRandom,
  restoreRng: restoreFastRandom,
  governorScale: () => equityGovernor.current(),
  workerReadiness: () => ({
    solverStores: {
      charts: gtoChartCount(),
      postflop: gtoPostflopCount(),
      postflopV31: gtoPostflopV31Count(),
      postflopV31Dataset: gtoPostflopV31Dataset(),
    },
    solverPolicyArtifact: solverPolicyArtifactStatus(),
    governor: equityGovernor.snapshot(),
  }),
  observeCompletedHand: (request) => {
    // Complete the action stream after the last Horse decision. Forced posts
    // must not shift observe()'s controller sequence positions.
    const completed = completedHandActionsForMind(request.actions, request.scope);
    const identity = horseMindHandFromCompletion(request);
    if (completed && identity) {
      const previousScope = HorseMind.currentScope();
      HorseMind.setDecisionScope(completed.scope);
      try {
        HorseMind.observe(completed.actions, [], identity);
      } finally {
        HorseMind.setDecisionScope(previousScope);
      }
    }
    HorseMind.observeHandComplete(
      request.handKey,
      request.actions,
      request.bigBlind,
      request.showdown,
      request.scope
    );
  },
  noteDecision: noteDecisionMs,
  noteFeature: noteFire,
  now: () => performance.now(),
};

/**
 * Resolve on a later event-loop turn (setImmediate's check phase), never inside
 * the macrotask that queued it. See HorseDecisionWorkerRuntime.receive.
 */
function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Worker-side FIFO. The promise chain is the sole execution lane: no two
 * HorseLogic calls can interleave while they temporarily install their
 * fence-derived RNG stream or read and update worker-owned HorseMind state.
 */
export class HorseDecisionWorkerRuntime {
  /** Private, actor-bounded read views; never included in IPC or telemetry.
   * Repeated identical fast identities are ambiguous and disable that second
   * look. Eviction/expiry retains the already-returned fast decision.
   */
  private readonly secondLookReads = new Map<
    string,
    { at: number; frame: HorseDecisionReadFrame | null }
  >();
  private static readonly MAX_SECOND_LOOK_READS = 128;
  private static readonly SECOND_LOOK_READ_TTL_MS = 60_000;

  /** Pending ownership cannot be displaced by later traffic or elapsed compute
   * time. Only explicit retirement/application makes an entry reclaimable.
   * Still volatile: worker loss is not durable application/replay proof. */
  private readonly issuedPlanBatches = new Map<
    string,
    {
      at: number;
      binding: HorsePlanBatchBinding;
      bindingKey: string;
      effects: HorseMindDecisionEffect[];
      effectsKey: string;
      state: 'issued' | 'ambiguous' | 'applied' | 'failed' | 'retired' | 'no_effects';
    }
  >();
  private static readonly MAX_ISSUED_PLAN_BATCHES = 128;
  private static readonly ISSUED_PLAN_BATCH_TTL_MS = 60_000;

  private issuePlanBatch(
    binding: HorsePlanBatchBinding,
    effects: HorseMindDecisionEffect[],
    at: number
  ): HorsePlanIssueDisposition {
    for (const [key, entry] of this.issuedPlanBatches) {
      if (
        entry.state !== 'issued' &&
        at - entry.at > HorseDecisionWorkerRuntime.ISSUED_PLAN_BATCH_TTL_MS
      ) {
        this.issuedPlanBatches.delete(key);
        this.deps.noteFeature('phase15_plan_terminal_expired');
      }
    }
    const key = JSON.stringify([binding.generation, binding.fence]);
    const old = this.issuedPlanBatches.get(key);
    if (old) {
      // Neither identical nor conflicting FAST reissue can replace its original
      // local occurrence. An already applied original may still ACK idempotently.
      if (old.state === 'issued') old.state = 'ambiguous';
      return 'reissue_unavailable';
    }
    if (this.issuedPlanBatches.size >= HorseDecisionWorkerRuntime.MAX_ISSUED_PLAN_BATCHES) {
      const terminal = [...this.issuedPlanBatches].find(([, entry]) => entry.state !== 'issued');
      if (!terminal) return effects.length ? 'capacity_unavailable' : 'no_effects';
      this.issuedPlanBatches.delete(terminal[0]);
      this.deps.noteFeature('phase15_plan_terminal_evicted');
    }
    this.issuedPlanBatches.set(key, {
      at,
      binding,
      bindingKey: horsePlanBatchBindingKey(binding)!,
      effects: deepFreeze(structuredClone(effects)),
      effectsKey: horseDecisionEffectsKey(effects)!,
      state: effects.length ? 'issued' : 'no_effects',
    });
    return effects.length ? 'issued' : 'no_effects';
  }

  private readViewKey(
    request: FastHorseDecisionRequest | DeepHorseDecisionRequest,
    rng: number
  ): string {
    return JSON.stringify([
      request.generation,
      request.fence,
      request.decisionKey,
      request.decisionTimeMs,
      rng,
    ]);
  }
  private operation: Promise<void> = Promise.resolve();
  private readonly cancelled = new Map<number, 'cancelled' | 'expired'>();
  /** Requests received but not yet terminal, independent of numeric order. */
  private readonly pendingRequestIds = new Set<number>();
  private accepting = true;
  private started = false;
  private stopped = false;
  private readyPromise: Promise<HorseDecisionWorkerReadiness> | null = null;
  constructor(
    private readonly send: (message: HorseDecisionWorkerResponse) => void,
    private readonly deps: HorseDecisionWorkerDependencies = defaultHorseDecisionWorkerDependencies,
    /** Test seam; production always yields to a real event-loop turn. */
    private readonly turnEventLoop: () => Promise<void> = nextEventLoopTurn
  ) {}

  start(): Promise<HorseDecisionWorkerReadiness> {
    if (this.readyPromise) return this.readyPromise;
    this.started = true;
    this.readyPromise = this.deps.startServices();
    void this.readyPromise
      .then((readiness) => this.send({ type: 'READY', ...readiness }))
      .catch((error) => {
        this.accepting = false;
        this.send({ type: 'ERROR', requestId: null, message: asMessage(error) });
      });
    return this.readyPromise;
  }

  receive(message: HorseDecisionWorkerRequest): void {
    if (message.type === 'CANCEL') {
      // A cancellation delivered after synchronous work returned is a normal
      // race. Retain it only while that exact request is known pending. This
      // remains correct when a priority effect commit overtakes queued work.
      if (
        this.pendingRequestIds.has(message.requestId) &&
        !this.cancelled.has(message.requestId) &&
        (message.reason === undefined || ['cancelled', 'expired'].includes(message.reason))
      )
        this.cancelled.set(message.requestId, message.reason ?? 'cancelled');
      return;
    }

    if (message.type === 'SHUTDOWN') {
      if (this.stopped) return;
      this.accepting = false;
      this.operation = this.operation
        .then(() => this.shutdown())
        .catch((error) => {
          this.send({ type: 'ERROR', requestId: null, message: asMessage(error) });
        });
      return;
    }

    if (!this.accepting) {
      this.send({
        type: 'ERROR',
        requestId: message.requestId,
        generation: message.generation,
        fence: message.fence,
        message: 'horse decision worker is stopping',
      });
      return;
    }

    if (!this.started) void this.start();
    if (this.pendingRequestIds.has(message.requestId)) {
      this.send({
        type: 'ERROR',
        requestId: message.requestId,
        generation: message.generation,
        fence: message.fence,
        message: 'duplicate horse decision worker request id',
      });
      return;
    }
    this.pendingRequestIds.add(message.requestId);
    /*
     * ONE JOB PER EVENT-LOOP TURN (2026-09-11)
     *
     * The client now posts several jobs ahead of the one running (client.ts,
     * "ONE LANE, NOT ONE MESSAGE AT A TIME"). Node hands a port's queued
     * messages to JS back to back - up to max(queued, 1000) per wake-up,
     * draining microtasks after each - so chaining execute() straight onto
     * this promise would run a whole window of synchronous HorseLogic without
     * a single event-loop turn in between. The governor's one-second sampler,
     * the mind-persistence and telemetry flush timers and every CANCEL would
     * wait behind it, and under a standing backlog the port need never empty.
     * Each job therefore starts on its own turn, after timers and newly
     * arrived messages have run - exactly the rhythm this worker had when the
     * client posted one job at a time. FIFO is unchanged: the chain is still
     * the only execution lane. The yield can never reject the chain.
     */
    this.operation = this.operation
      .then(async () => {
        try {
          await this.turnEventLoop();
        } catch {
          /* a failed yield must never stall or reject the only lane */
        }
      })
      .then(() => this.execute(message));
  }

  /** Test seam and graceful-worker close join. */
  async drain(): Promise<void> {
    await this.operation;
  }

  private async execute(request: HorseDecisionJobRequest): Promise<void> {
    let admitted: HorseLifecycleRequest | undefined;
    try {
      await this.readyPromise;
      try {
        this.assertEnvelope(request);
      } catch (error) {
        // A malformed snapshot belongs to one table/turn. Marking this
        // rejection explicitly lets the client take that caller's legal
        // fail-safe action without restarting the process-wide worker. Errors
        // after this boundary still mean runtime/execution corruption and are
        // deliberately emitted without `recoverable` below.
        this.send({
          type: 'ERROR',
          requestId: request.requestId,
          generation: request.generation,
          fence: request.fence,
          message: asMessage(error),
          recoverable: true,
        });
        return;
      }
      if (isHorseLifecycleRequest(request))
        admitted = this.admitLifecycle(request, 'worker_compute');
      const cancellation = this.cancelled.get(request.requestId);
      if (cancellation) {
        if (admitted) this.terminalLifecycle(admitted, cancellation);
        this.send({
          type: 'CANCELLED',
          requestId: request.requestId,
          generation: request.generation,
          fence: request.fence,
        });
        return;
      }

      let outcome: HorseLifecycleOutcome = 'success';
      if (request.type === 'DECIDE_FAST') outcome = this.executeFast(request);
      else if (request.type === 'DECIDE_DEEP') outcome = this.executeDeep(request);
      else if (request.type === 'OBSERVE_REQUEST_RETIREMENT') {
        // Canonical shape and attribution are checked without executing a
        // policy. The origin explicitly says it never reached compute dispatch.
        admitted = this.admitLifecycle(request.retiredRequest, 'client_not_dispatched');
        outcome = request.outcome;
        this.send({
          type: 'ACK',
          requestId: request.requestId,
          generation: request.generation,
          fence: request.fence,
          operation: 'OBSERVE_REQUEST_RETIREMENT',
        });
      } else if (request.type === 'OBSERVE_COMPLETED_HAND') this.executeObservation(request);
      else if (request.type === 'COMMIT_DECISION_EFFECTS') this.executeEffectCommit(request);
      else if (request.type === 'RETIRE_DECISION_EFFECTS') this.executeEffectRetirement(request);
      else if (request.type === 'OBSERVE_EXECUTION') {
        try {
          this.deps.journalExecution?.(request.witness);
        } catch {
          this.deps.noteFeature('phase15_journal_capture_unavailable');
        }
        this.send({
          type: 'ACK',
          requestId: request.requestId,
          generation: request.generation,
          fence: request.fence,
          operation: 'OBSERVE_EXECUTION',
        });
      } else if (request.type === 'OBSERVE_DISCARD_EXECUTION') {
        try {
          this.deps.journalDiscardExecution?.(request.execution);
        } catch {
          this.deps.noteFeature('phase15_journal_discard_capture_unavailable');
        }
        this.send({
          type: 'ACK',
          requestId: request.requestId,
          generation: request.generation,
          fence: request.fence,
          operation: 'OBSERVE_DISCARD_EXECUTION',
        });
      } else if (request.type === 'DECIDE_DISCARD') this.executeDiscard(request);
      else this.executeStatus(request);
      if (admitted) this.terminalLifecycle(admitted, outcome);
    } catch (error) {
      if (admitted) this.terminalLifecycle(admitted, 'exception');
      this.send({
        type: 'ERROR',
        requestId: request.requestId,
        generation: request.generation,
        fence: request.fence,
        message: asMessage(error),
      });
    } finally {
      this.cancelled.delete(request.requestId);
      this.pendingRequestIds.delete(request.requestId);
    }
  }

  private admitLifecycle(
    request: HorseLifecycleRequest,
    origin: HorseLifecycleOrigin
  ): HorseLifecycleRequest | undefined {
    if (!(this.deps.journalEnabled?.() ?? true) || !this.deps.journalLifecycle) return;
    try {
      // Capture the original validated bytes before mutable policy work.
      const snapshot: HorseLifecycleRequest = JSON.parse(horseJournalJson(request));
      horseLifecycleKeys(snapshot);
      this.deps.journalLifecycle(snapshot, {
        version: 1,
        phase: 'requested',
        request: snapshot,
        requestDigest: horseLifecycleRequestDigest(snapshot),
        origin,
      });
      return snapshot;
    } catch {
      this.deps.noteFeature('phase15_journal_capture_unavailable');
      return;
    }
  }

  private terminalLifecycle(request: HorseLifecycleRequest, outcome: HorseLifecycleOutcome): void {
    try {
      this.deps.journalLifecycle?.(request, {
        version: 1,
        phase: 'terminal',
        requestDigest: horseLifecycleRequestDigest(request),
        outcome,
      });
    } catch {
      this.deps.noteFeature('phase15_journal_capture_unavailable');
    }
  }

  private assertEnvelope(request: HorseDecisionJobRequest): void {
    if (!Number.isSafeInteger(request.requestId) || request.requestId <= 0) {
      throw new Error('requestId must be a positive safe integer');
    }
    if (!Number.isSafeInteger(request.generation) || request.generation < 0) {
      throw new Error('generation must be a non-negative safe integer');
    }
    if (typeof request.fence !== 'string' || request.fence.length === 0) {
      throw new Error('fence must be a non-empty string');
    }
    if (request.type === 'OBSERVE_REQUEST_RETIREMENT') {
      if (
        !request.retiredRequest ||
        !isHorseLifecycleRequest(request.retiredRequest) ||
        !['cancelled', 'expired'].includes(request.outcome) ||
        request.retiredRequest.requestId >= request.requestId ||
        request.retiredRequest.generation !== request.generation ||
        request.retiredRequest.fence !== request.fence ||
        this.pendingRequestIds.has(request.retiredRequest.requestId)
      )
        throw Error('invalid private Horse request retirement');
      this.assertEnvelope(request.retiredRequest);
      horseLifecycleKeys(request.retiredRequest);
    }
    if (
      (request.type === 'DECIDE_FAST' || request.type === 'DECIDE_DEEP') &&
      (!Number.isFinite(request.decisionTimeMs) || request.decisionTimeMs < 0)
    ) {
      throw new Error('decisionTimeMs must be a finite epoch');
    }
    if (
      (request.type === 'DECIDE_FAST' || request.type === 'DECIDE_DEEP') &&
      request.opts &&
      ('mindObservationHand' in request.opts ||
        'mindPlanContext' in request.opts ||
        'gtoV31DatasetChecksum' in request.opts ||
        'onGtoV31Decision' in request.opts ||
        request.opts.phase8Postflop === 'candidate' ||
        request.opts.phase10Plo4 === 'candidate' ||
        request.opts.phase11Omaha === 'candidate' ||
        request.opts.phase12Remaining === 'candidate' ||
        'phase12EvidenceMode' in request.opts ||
        request.opts.phase13Joint === 'candidate' ||
        'phase13EvidenceMode' in request.opts ||
        'phase11EvidenceMode' in request.opts ||
        'phase10EvidenceMode' in request.opts)
    ) {
      throw new Error('offline candidate controls are forbidden in live decision requests');
    }
    if (request.type === 'DECIDE_FAST' || request.type === 'DECIDE_DEEP') {
      this.assertCanonicalDecisionSnapshot(request);
    }
    if (
      request.type === 'DECIDE_DEEP' &&
      (!Number.isInteger(request.rngBefore) ||
        request.rngBefore < 0 ||
        request.rngBefore > 0xffffffff)
    ) {
      throw new Error('rngBefore must be an unsigned 32-bit integer');
    }
    if (
      request.type === 'DECIDE_DEEP' &&
      (!Number.isFinite(request.deepEquity) || request.deepEquity <= 1)
    )
      throw Error('deepEquity must be finite and greater than one');
    if (request.type === 'COMMIT_DECISION_EFFECTS') {
      if (
        !horseDecisionEffectsAreValid(request.effects) ||
        !horsePlanBatchBindingIsValid(request.planBinding) ||
        request.planBinding.fastRequestId >= request.requestId ||
        request.planBinding.generation !== request.generation ||
        request.planBinding.fence !== request.fence
      ) {
        throw new Error('invalid decision effects: expected at most 16 bounded plan records');
      }
    }
    if (
      request.type === 'RETIRE_DECISION_EFFECTS' &&
      (!horsePlanBatchBindingIsValid(request.planBinding) ||
        request.planBinding.fastRequestId >= request.requestId ||
        request.planBinding.generation !== request.generation ||
        request.planBinding.fence !== request.fence ||
        !['decision_finalized', 'caller_settled', 'commit_unconfirmed'].includes(request.reason))
    )
      throw Error('invalid Horse plan retirement');
    if (request.type === 'OBSERVE_EXECUTION') {
      const witness = request.witness;
      if (
        !witness ||
        witness.version !== 'horse-execution-witness-v4' ||
        witness.executionStatus === 'pending' ||
        witness.identity?.fence !== request.fence ||
        witness.identity?.generation !== request.generation ||
        horseJournalJson(witness).length > 65536
      )
        throw Error('invalid terminal Horse execution journal record');
    }
    if (request.type === 'DECIDE_DISCARD') {
      if (!Array.isArray(request.cards) || request.cards.length !== 3) {
        throw new Error('pineapple discard requires exactly three cards');
      }
      if (!Array.isArray(request.communityCards) || request.communityCards.length !== 3) {
        throw new Error('pineapple discard requires the exact three-card flop');
      }
      if (request.gameVariant !== 'pineapple') {
        throw new Error('pineapple discard requires the canonical pineapple variant');
      }
      const ranks = new Set(['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']);
      const suits = new Set(['clubs', 'diamonds', 'hearts', 'spades']);
      const known = [...request.cards, ...request.communityCards];
      if (
        known.some((card) => !card || !ranks.has(card.rank) || !suits.has(card.suit)) ||
        new Set(known.map((card) => `${card.rank}:${card.suit}`)).size !== known.length
      ) {
        throw new Error('pineapple discard requires six distinct physical cards');
      }
    }
    if (request.type === 'OBSERVE_DISCARD_EXECUTION') {
      validateHorseDiscardExecution(request.execution);
      if (
        request.execution.request.generation !== request.generation ||
        request.execution.request.fence !== request.fence ||
        horseJournalJson(request.execution).length > 65536
      )
        throw Error('invalid private Horse discard execution envelope');
    }
  }

  /** Runtime law at the structured-clone boundary; TypeScript cannot enforce it. */
  private assertCanonicalDecisionSnapshot(
    request: FastHorseDecisionRequest | DeepHorseDecisionRequest
  ): void {
    const gs = request.gameState;
    if (!/^phase5-v1:[0-9a-f]{64}$/.test(request.decisionKey)) {
      throw new Error('decisionKey must be a Phase 5 canonical state digest');
    }
    if (gs.stateSchemaVersion !== 1) throw new Error('horse state schema version 1 is required');
    if (gs.heroSeat !== request.player.seat || gs.currentPlayerSeat !== request.player.seat) {
      throw new Error('horse state hero/current seat does not match the decision player');
    }
    if (!Array.isArray(gs.players) || gs.players.length < 1) {
      throw new Error('horse state must include every public seat including hero');
    }
    const seats = new Set<number>();
    const userIds = new Set<string>();
    for (const seat of gs.players) {
      if (!Number.isSafeInteger(seat.seat) || seat.seat < 1 || seats.has(seat.seat)) {
        throw new Error('horse state public seats must be unique positive integers');
      }
      if (
        typeof seat.user_id !== 'string' ||
        seat.user_id.length === 0 ||
        userIds.has(seat.user_id)
      ) {
        throw new Error('horse state public user ids must be unique and non-empty');
      }
      seats.add(seat.seat);
      userIds.add(seat.user_id);
      if (
        !Number.isFinite(seat.stack) ||
        seat.stack < 0 ||
        !Number.isFinite(seat.bet) ||
        seat.bet < 0 ||
        !Number.isFinite(seat.totalInvested) ||
        seat.totalInvested < 0
      ) {
        throw new Error('horse state public chip values must be finite and non-negative');
      }
    }
    const publicHero = gs.players.find((seat) => seat.seat === gs.heroSeat);
    if (gs.dealtSeatIds !== undefined)
      validateDealtSeatCensus(gs.players, request.player.seat, gs.dealtSeatIds);
    if (
      (gs.chipUnit !== undefined || gs.asset !== undefined) &&
      (!['chips', 'diamonds'].includes(gs.asset ?? '') ||
        gs.chipUnit !== (gs.asset === 'diamonds' || gs.gameMode === 'tournament' ? 1 : 0.01))
    )
      throw new Error('horse state settlement chip rules are invalid');
    if (!publicHero || publicHero.user_id !== request.player.user_id) {
      throw new Error('horse state must include the same public hero identity');
    }
    if (
      !Number.isFinite(request.player.stack) ||
      request.player.stack < 0 ||
      !Number.isFinite(request.player.bet) ||
      request.player.bet < 0 ||
      !Number.isFinite(request.player.totalInvested) ||
      request.player.totalInvested < 0 ||
      Math.abs(publicHero.stack - request.player.stack) > 0.005 ||
      Math.abs(publicHero.bet - request.player.bet) > 0.005 ||
      Math.abs(publicHero.totalInvested - request.player.totalInvested) > 0.005 ||
      publicHero.is_folded !== request.player.is_folded ||
      publicHero.is_all_in !== request.player.is_all_in ||
      publicHero.is_sitting_out !== request.player.is_sitting_out
    ) {
      throw new Error('horse state public hero does not match the private decision player');
    }
    if (
      gs.players.some(
        (seat) =>
          !Array.isArray(seat.cards) ||
          seat.cards.length !== 0 ||
          (seat.knownDeadCards !== undefined &&
            (!Array.isArray(seat.knownDeadCards) || seat.knownDeadCards.length !== 0))
      )
    ) {
      throw new Error('horse state contains private seat cards');
    }
    if (!horsePolicyRegistration(gs.gameVariant))
      throw new Error('horse state gameVariant has no canonical policy owner');
    const expectedRules = horseVariantRulesFor(gs.gameVariant);
    const rules = gs.variantRules;
    if (
      !rules ||
      !Number.isSafeInteger(rules.holeCardsDealt) ||
      !['any', 'exactly_two', 'discard_to_two'].includes(rules.holeCardsUse) ||
      !['any', 'exactly_three'].includes(rules.boardCardsUse) ||
      !Number.isSafeInteger(rules.deckSize) ||
      typeof rules.splitLow8OrBetter !== 'boolean' ||
      rules.holeCardsDealt !== expectedRules.holeCardsDealt ||
      rules.holeCardsUse !== expectedRules.holeCardsUse ||
      rules.boardCardsUse !== expectedRules.boardCardsUse ||
      rules.deckSize !== expectedRules.deckSize ||
      rules.splitLow8OrBetter !== expectedRules.splitLow8OrBetter
    ) {
      throw new Error('horse state variant rules do not match gameVariant');
    }
    if (!Array.isArray(request.player.cards)) {
      throw new Error('horse state requires hero private cards');
    }
    if (gs.gameVariant === 'pineapple' && gs.stage === 'pineapple_discard') {
      throw new Error('horse fast decisions cannot run during the pineapple discard round');
    }
    // Crazy Pineapple deals three cards preflop, then returns to the ordinary
    // FLOP betting stage after every live seat has discarded to two. The
    // previous validator only recognized turn/river as post-discard streets,
    // so the first legal flop decision killed the process-wide worker. Bind
    // the two-card state to the controller's authoritative discard record;
    // accepting either card count generically would hide a real wiring fault.
    const pineapplePostDiscard =
      gs.gameVariant === 'pineapple' &&
      (gs.stage === 'flop' || gs.stage === 'turn' || gs.stage === 'river');
    const expectedHoleCards = pineapplePostDiscard ? 2 : expectedRules.holeCardsDealt;
    if (request.player.cards.length !== expectedHoleCards) {
      throw new Error('horse state hero card count does not match variant/street rules');
    }
    if (
      pineapplePostDiscard &&
      (!Array.isArray(gs.actionHistory) ||
        !gs.actionHistory.some(
          (action) =>
            action.userId === request.player.user_id &&
            action.action === 'discard' &&
            action.stage === 'pineapple_discard'
        ))
    ) {
      throw new Error('horse state pineapple post-discard cards lack authoritative discard proof');
    }
    const validRanks = new Set(['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']);
    const validSuits = new Set(['clubs', 'diamonds', 'hearts', 'spades']);
    const knownDead = request.player.knownDeadCards ?? [];
    if (
      !Array.isArray(knownDead) ||
      !Array.isArray(gs.communityCards) ||
      knownDead.length !== (pineapplePostDiscard ? 1 : 0)
    ) {
      throw new Error('horse state known discard or physical cards are invalid');
    }
    const physicalKnown = [...request.player.cards, ...knownDead, ...gs.communityCards];
    if (
      physicalKnown.some(
        (card) => !card || !validRanks.has(card.rank) || !validSuits.has(card.suit)
      ) ||
      new Set(physicalKnown.map((card) => `${card.rank}:${card.suit}`)).size !==
        physicalKnown.length
    ) {
      throw new Error('horse state known discard or physical cards are invalid');
    }
    const boardPresent = (board: unknown) =>
      board !== undefined && (!Array.isArray(board) || board.length > 0);
    const secondBoard = boardPresent(gs.communityCards2);
    const thirdBoard = boardPresent(gs.communityCards3);
    if (gs.boardCount !== undefined && ![1, 2, 3].includes(gs.boardCount))
      throw new Error('joint_cards_invalid_board_count');
    if ((gs.boardCount ?? 1) > 1 || secondBoard || thirdBoard) {
      const boardCount = gs.boardCount ?? (thirdBoard ? 3 : 2);
      if ((boardCount < 3 && thirdBoard) || (boardCount < 2 && secondBoard))
        throw new Error('joint_cards_invalid_board_count');
      // A betting decision uses distinct bomb boards. Shared-prefix all-in
      // runouts have no remaining betting decision and belong to settlement.
      buildJointCardLayout({
        variant: gs.gameVariant,
        stage: gs.stage as JointCardLayoutInput['stage'],
        heroCards: request.player.cards,
        knownDeadCards: knownDead,
        dealtSeats: validateDealtSeatCensus(gs.players, request.player.seat, gs.dealtSeatIds)
          .length,
        boards: [
          gs.communityCards,
          gs.communityCards2!,
          ...(boardCount === 3 ? [gs.communityCards3!] : []),
        ],
        layout: 'independent',
      });
    }
    if (
      request.player.cards.some(
        (card) => !card || !validRanks.has(card.rank) || !validSuits.has(card.suit)
      ) ||
      new Set(request.player.cards.map((card) => `${card.rank}:${card.suit}`)).size !==
        request.player.cards.length
    ) {
      throw new Error('horse state hero cards are invalid');
    }
    const actions = gs.legalActions;
    const legalValues = new Set(['fold', 'check', 'call', 'bet', 'raise', 'all_in', 'discard']);
    if (
      !Array.isArray(actions) ||
      actions.length === 0 ||
      new Set(actions).size !== actions.length ||
      actions.some((action) => !legalValues.has(action))
    ) {
      throw new Error('horse state legalActions is invalid');
    }
    if (
      !Number.isFinite(gs.pot) ||
      gs.pot < 0 ||
      !Number.isFinite(gs.currentBet) ||
      gs.currentBet < 0 ||
      !Number.isFinite(gs.minRaise) ||
      gs.minRaise < 0 ||
      !Number.isFinite(gs.bigBlind) ||
      gs.bigBlind <= 0 ||
      !Number.isFinite(gs.toCall) ||
      (gs.toCall as number) < 0
    ) {
      throw new Error('horse state toCall must be finite and non-negative');
    }
    const expectedToCall = Math.round(Math.max(0, gs.currentBet - request.player.bet) * 100) / 100;
    if (Math.abs((gs.toCall as number) - expectedToCall) > 0.005) {
      throw new Error('horse state toCall does not match currentBet and hero bet');
    }
    if (
      !actions.includes('fold') ||
      ((gs.toCall as number) <= 0.005 && !actions.includes('check')) ||
      ((gs.toCall as number) <= 0.005 && actions.includes('call')) ||
      ((gs.toCall as number) > 0.005 && actions.includes('check')) ||
      (actions.includes('bet') && gs.currentBet > 0.005) ||
      (actions.includes('raise') && gs.currentBet <= 0.005)
    ) {
      throw new Error('horse state legalActions do not match the call state');
    }
    const sized = actions.includes('bet') || actions.includes('raise');
    const validBound = (value: number | null | undefined): boolean =>
      value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
    if (
      !validBound(gs.minRaiseTo) ||
      !validBound(gs.maxRaiseTo) ||
      (sized && (gs.minRaiseTo === null || gs.maxRaiseTo === null)) ||
      (!sized && (gs.minRaiseTo !== null || gs.maxRaiseTo !== null)) ||
      (typeof gs.minRaiseTo === 'number' &&
        typeof gs.maxRaiseTo === 'number' &&
        gs.maxRaiseTo < gs.minRaiseTo - 0.005)
    ) {
      throw new Error('horse state wager bounds are inconsistent with legalActions');
    }
    if (
      !['no_limit', 'pot_limit', 'fixed_limit'].includes(gs.bettingStructure ?? '') ||
      gs.bettingStructure !== bettingStructureFor(gs.gameVariant)
    ) {
      throw new Error('horse state bettingStructure is invalid');
    }
    if (
      (gs.bettingStructure === 'fixed_limit' &&
        (!Number.isFinite(gs.fixedBetSize) || (gs.fixedBetSize as number) <= 0)) ||
      (gs.bettingStructure !== 'fixed_limit' && gs.fixedBetSize !== null)
    ) {
      throw new Error('horse state fixedBetSize is inconsistent with bettingStructure');
    }
    if (
      typeof gs.wagersCapped !== 'boolean' ||
      (gs.commitmentCapRemaining !== null &&
        (!Number.isFinite(gs.commitmentCapRemaining) ||
          (gs.commitmentCapRemaining as number) < 0)) ||
      (typeof gs.commitmentCapRemaining === 'number' &&
        (gs.toCall as number) > gs.commitmentCapRemaining + 0.005 &&
        actions.includes('call'))
    ) {
      throw new Error('horse state commitment cap is inconsistent with legalActions');
    }
    if (!Array.isArray(gs.actionHistory) || !Array.isArray(gs.pots)) {
      throw new Error('horse state requires action history and live side pots');
    }
    if (
      gs.pots.some(
        (pot) =>
          !Number.isFinite(pot.amount) ||
          pot.amount < 0 ||
          !Array.isArray(pot.eligiblePlayers) ||
          pot.eligiblePlayers.length === 0 ||
          new Set(pot.eligiblePlayers).size !== pot.eligiblePlayers.length ||
          pot.eligiblePlayers.some(
            (userId) =>
              !userIds.has(userId) || gs.players.find((seat) => seat.user_id === userId)?.is_folded
          )
      )
    ) {
      throw new Error('horse state side-pot eligibility is invalid');
    }
    const potTotal = gs.pots.reduce((sum, pot) => sum + pot.amount, 0);
    if (Math.abs(potTotal - gs.pot) > 0.01) {
      throw new Error('horse state side pots do not conserve the live pot');
    }
    const expectedContestable = calculateContestablePot(
      gs.players,
      request.player.user_id,
      gs.toCall as number
    );
    if (
      !Number.isFinite(gs.contestablePot) ||
      (gs.contestablePot as number) < 0 ||
      (gs.contestablePot as number) > gs.pot + 0.005 ||
      Math.abs((gs.contestablePot as number) - expectedContestable) > 0.01
    ) {
      throw new Error('horse state contestable pot is invalid');
    }
    if (
      !gs.rakeConfig ||
      !Number.isFinite(gs.rakeConfig.percent) ||
      !Number.isFinite(gs.rakeConfig.cap) ||
      typeof gs.rakeConfig.noFlopNoDrop !== 'boolean'
    ) {
      throw new Error('horse state requires the exact rake config');
    }
    if (gs.gameMode !== 'cash' && gs.gameMode !== 'tournament') {
      throw new Error('horse state gameMode must be explicit');
    }
    if (gs.gameMode === 'cash') {
      if (gs.format !== 'cash' || gs.tournament !== undefined) {
        throw new Error('cash horse state cannot carry tournament context');
      }
    } else {
      if (!['mtt', 'sng', 'spin', 'hu_sng'].includes(gs.format ?? '')) {
        throw new Error('tournament horse state format is invalid');
      }
      this.assertPhase6TournamentSnapshot(request);
    }
    if (request.decisionKey !== buildHorseDecisionKey(request)) {
      throw new Error('decisionKey does not bind the canonical decision snapshot');
    }
  }

  /** Phase 6 law: a live tournament can be incomplete, but never implicit. */
  private assertPhase6TournamentSnapshot(
    request: FastHorseDecisionRequest | DeepHorseDecisionRequest
  ): void {
    const gs = request.gameState;
    const tournament = gs.tournament;
    if (!tournament || tournament.schemaVersion !== 1) {
      throw new Error('Phase 6 tournament context schema version 1 is required');
    }
    if (!horseTournamentProvenanceMatchesSnapshot(request)) {
      throw new Error('Phase 6 tournament provenance does not bind the current hand snapshot');
    }
    const status = tournament.contextStatus;
    if (!['complete', 'incomplete', 'warming', 'stale'].includes(status ?? '')) {
      throw new Error('Phase 6 tournament context status is invalid');
    }
    if (
      !Array.isArray(tournament.contextIssues) ||
      tournament.contextIssues.some((issue) => typeof issue !== 'string' || issue.length === 0) ||
      new Set(tournament.contextIssues).size !== tournament.contextIssues.length ||
      (status === 'complete' && tournament.contextIssues.length !== 0) ||
      (status !== 'complete' && !tournament.contextIssues.includes(TOURNAMENT_CONTEXT_INCOMPLETE))
    ) {
      throw new Error('Phase 6 tournament context issues do not match its status');
    }

    const nonNegative = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const positive = (value: unknown): value is number => nonNegative(value) && value > 0;
    const nullableNonNegative = (value: unknown): boolean => value === null || nonNegative(value);
    const nullablePositive = (value: unknown): boolean => value === null || positive(value);
    const requiredBooleans = [
      tournament.nearBubble,
      tournament.inMoney,
      tournament.registrationOpen,
      tournament.lateRegistrationOpen,
      tournament.registrationRequiresAuthorization,
      tournament.isPko,
      tournament.isBounty,
      tournament.isMysteryBounty,
      tournament.reentryAllowed,
      tournament.reentryOpen,
      tournament.rebuyAllowed,
      tournament.rebuyOpen,
      tournament.addOnAvailable,
      tournament.addOnPeriodOpen,
      tournament.onBreak,
      tournament.handForHand,
      tournament.handForHandExpected,
      tournament.mysteryTopLive,
      tournament.finalTable,
      tournament.satellite,
    ];
    if (requiredBooleans.some((value) => typeof value !== 'boolean')) {
      throw new Error('Phase 6 tournament context boolean state is incomplete');
    }
    const mysteryBountyStage = tournament.mysteryBountyStage ?? 'none';
    if (
      !['none', 'pending', 'active', 'complete'].includes(mysteryBountyStage) ||
      (tournament.isMysteryBounty === true && mysteryBountyStage === 'none') ||
      (tournament.isMysteryBounty === false && mysteryBountyStage !== 'none')
    ) {
      throw new Error('Phase 7 mystery bounty stage is invalid');
    }
    if (
      !nonNegative(tournament.entrants) ||
      !nonNegative(tournament.playersLeft) ||
      !nonNegative(tournament.spotsPaid) ||
      !nonNegative(tournament.avgStackChips) ||
      !nonNegative(tournament.medianStackChips) ||
      !Number.isSafeInteger(tournament.seatsPerTable) ||
      (tournament.seatsPerTable as number) < 2 ||
      (tournament.seatsPerTable as number) > 10 ||
      !Number.isSafeInteger(tournament.playersAtTable) ||
      // Tournament sit-outs are still dealt and post every forced contribution;
      // they count in orbit-cost M even though covering pressure excludes them.
      tournament.playersAtTable !== Math.max(2, gs.players.length) ||
      !Number.isSafeInteger(tournament.currentLevel) ||
      (tournament.currentLevel as number) < 0 ||
      !positive(tournament.currentSmallBlind) ||
      !positive(tournament.currentBigBlind) ||
      Math.abs((tournament.currentBigBlind as number) - gs.bigBlind) > 0.005 ||
      !nonNegative(tournament.currentAnte) ||
      !['none', 'per_player', 'big_blind'].includes(tournament.anteType ?? '') ||
      !nullablePositive(tournament.nextSmallBlind) ||
      !nullablePositive(tournament.nextBigBlind) ||
      !nullableNonNegative(tournament.nextAnte) ||
      !nullableNonNegative(tournament.levelDurationMin) ||
      !nullableNonNegative(tournament.levelElapsedMin) ||
      !nullableNonNegative(tournament.sourceAgeMs) ||
      !nullableNonNegative(tournament.maxReentries) ||
      !nullableNonNegative(tournament.maxRebuys) ||
      !nullableNonNegative(tournament.addOnCost) ||
      !nullableNonNegative(tournament.addOnChips) ||
      !nullableNonNegative(tournament.addOnLevels) ||
      !nullableNonNegative(tournament.nextBlindInMin) ||
      !positive(tournament.nextBlindMult)
    ) {
      throw new Error('Phase 6 tournament context numeric state is invalid');
    }
    if (
      (tournament.nextSmallBlind === null) !== (tournament.nextBigBlind === null) ||
      (typeof gs.ante === 'number' && Math.abs(tournament.currentAnte - gs.ante) > 0.005) ||
      tournament.anteType !==
        (gs.bigBlindAnte === true
          ? 'big_blind'
          : (gs.ante ?? 0) > 0 || (tournament.nextAnte ?? 0) > 0
            ? 'per_player'
            : 'none')
    ) {
      throw new Error('Phase 6 tournament blind and ante state is inconsistent');
    }
    if (
      status === 'complete' &&
      (typeof tournament.tournamentId !== 'string' ||
        tournament.tournamentId.length === 0 ||
        !tournament.tournamentType ||
        !tournament.tournamentStatus ||
        !tournament.gameVariant ||
        tournament.entrants < tournament.playersLeft ||
        tournament.playersLeft <= 0 ||
        tournament.spotsPaid <= 0 ||
        tournament.avgStackChips <= 0 ||
        tournament.medianStackChips <= 0 ||
        (tournament.currentLevel as number) < 0 ||
        !Number.isSafeInteger(gs.dealerSeat) ||
        !gs.players.some((seat) => seat.seat === gs.dealerSeat) ||
        tournament.gameVariant !== gs.gameVariant ||
        !['mtt', 'sng', 'spin', 'hu_sng'].includes(gs.format ?? '') ||
        tournament.levelDurationMin === null ||
        tournament.levelElapsedMin === null ||
        !Array.isArray(tournament.stacks) ||
        tournament.stacks.length === 0 ||
        !Array.isArray(tournament.payoutPct) ||
        tournament.payoutPct.length === 0 ||
        (tournament.addOnAvailable === true &&
          (tournament.addOnCost === null ||
            tournament.addOnChips === null ||
            (tournament.addOnChips as number) <= 0)))
    ) {
      throw new Error('Phase 6 complete tournament context is missing required facts');
    }
    if (
      !Array.isArray(tournament.stacks) ||
      tournament.stacks.some((stack) => !positive(stack)) ||
      (tournament.stackByUser !== undefined &&
        (!tournament.stackByUser ||
          typeof tournament.stackByUser !== 'object' ||
          Array.isArray(tournament.stackByUser) ||
          Object.entries(tournament.stackByUser).some(
            ([userId, stack]) =>
              !gs.players.some((player) => player.user_id === userId) || !positive(stack)
          ))) ||
      !Array.isArray(tournament.payoutPct) ||
      tournament.payoutPct.some((share) => !positive(share)) ||
      !tournament.bountyByUser ||
      typeof tournament.bountyByUser !== 'object' ||
      Array.isArray(tournament.bountyByUser) ||
      Object.entries(tournament.bountyByUser).some(
        ([userId, bounty]) => userId.length === 0 || !nonNegative(bounty)
      ) ||
      !nonNegative(tournament.bountyFactor) ||
      !nonNegative(tournament.mysteryChestsLeft) ||
      !nonNegative(tournament.mysteryMeanCents) ||
      !nonNegative(tournament.mysteryTopCents) ||
      !nonNegative(tournament.meanBountyCents) ||
      !nonNegative(tournament.satelliteSeats) ||
      (tournament.prizePoolCents !== undefined && !nonNegative(tournament.prizePoolCents)) ||
      (tournament.bountyPoolCents !== undefined && !nonNegative(tournament.bountyPoolCents)) ||
      (tournament.buyInCents !== undefined && !nullableNonNegative(tournament.buyInCents)) ||
      (tournament.startingStackChips !== undefined &&
        !nullableNonNegative(tournament.startingStackChips)) ||
      (tournament.rebuyCostCents !== undefined &&
        !nullableNonNegative(tournament.rebuyCostCents)) ||
      (tournament.rebuyChips !== undefined && !nullableNonNegative(tournament.rebuyChips)) ||
      (tournament.rebuyPrizeContributionCents !== undefined &&
        !nullableNonNegative(tournament.rebuyPrizeContributionCents)) ||
      (tournament.rebuyBountyContributionCents !== undefined &&
        !nullableNonNegative(tournament.rebuyBountyContributionCents)) ||
      (tournament.reloadsUsed !== undefined &&
        tournament.reloadsUsed !== null &&
        (!Number.isSafeInteger(tournament.reloadsUsed) || tournament.reloadsUsed < 0)) ||
      (tournament.addOnTaken !== undefined &&
        tournament.addOnTaken !== null &&
        typeof tournament.addOnTaken !== 'boolean') ||
      (tournament.rebuyAffordable !== undefined &&
        tournament.rebuyAffordable !== null &&
        typeof tournament.rebuyAffordable !== 'boolean') ||
      (tournament.addOnAffordable !== undefined &&
        tournament.addOnAffordable !== null &&
        typeof tournament.addOnAffordable !== 'boolean')
    ) {
      throw new Error('Phase 6 tournament payout or bounty state is invalid');
    }

    const m = tournament.m;
    if (!m || m.schemaVersion !== 1) {
      throw new Error('Phase 6 tournament M schema version 1 is required');
    }
    const zones = ['dead', 'red', 'orange', 'yellow', 'green', 'blue'];
    if (!zones.includes(m.zone) || (m.previousZone !== null && !zones.includes(m.previousZone))) {
      throw new Error('Phase 6 tournament M zone is invalid');
    }
    const expectedM = buildTournamentMState({
      stackChips: request.player.stack,
      smallBlind: tournament.currentSmallBlind,
      bigBlind: tournament.currentBigBlind,
      ante: tournament.currentAnte,
      anteType: tournament.anteType,
      playersAtTable: tournament.playersAtTable,
      nextSmallBlind: tournament.nextSmallBlind,
      nextBigBlind: tournament.nextBigBlind,
      nextAnte: tournament.nextAnte,
      minutesToNextLevel: tournament.nextBlindInMin,
      opponentStacks: gs.players
        .filter((seat) => seat.user_id !== request.player.user_id && !seat.is_sitting_out)
        .map((seat) => ({ userId: seat.user_id, stackChips: seat.stack })),
      previousZone: m.previousZone,
    });
    const sameNumber = (left: unknown, right: unknown): boolean => {
      if (left === null || right === null) return left === right;
      return (
        typeof left === 'number' &&
        Number.isFinite(left) &&
        typeof right === 'number' &&
        Number.isFinite(right) &&
        Math.abs(left - right) <= 1e-8
      );
    };
    const numericKeys = [
      'orbitCostChips',
      'realM',
      'effectiveM',
      'projectedOrbitCostChips',
      'projectedM',
      'projectedEffectiveM',
      'projectedStackBB',
      'velocityMPerMinute',
      'coveringOpponentM',
    ] as const;
    const canonicalCovering = (
      value: typeof expectedM.coveringOpponents
    ): typeof expectedM.coveringOpponents =>
      [...value].sort(
        (left, right) =>
          left.stackChips - right.stackChips ||
          (left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0)
      );
    const actualCovering = Array.isArray(m.coveringOpponents)
      ? canonicalCovering(m.coveringOpponents)
      : [];
    const expectedCovering = canonicalCovering(expectedM.coveringOpponents);
    const coveringMatches =
      Array.isArray(m.coveringOpponents) &&
      actualCovering.length === expectedCovering.length &&
      actualCovering.every((actual, index) => {
        const expected = expectedCovering[index];
        return (
          actual.userId === expected.userId &&
          sameNumber(actual.stackChips, expected.stackChips) &&
          sameNumber(actual.realM, expected.realM) &&
          sameNumber(actual.effectiveM, expected.effectiveM)
        );
      });
    if (
      numericKeys.some((key) => !sameNumber(m[key], expectedM[key])) ||
      m.zone !== expectedM.zone ||
      m.previousZone !== expectedM.previousZone ||
      !coveringMatches
    ) {
      throw new Error('Phase 6 tournament M state does not match the canonical snapshot');
    }
  }

  private executeFast(request: FastHorseDecisionRequest): HorseLifecycleOutcome {
    const planBinding = horsePlanBatchBindingFromRequest(request);
    const planContext = planBinding.planContext;
    const canonicalRng = this.deps.saveRng();
    const rngBefore = this.requestRngSeed(
      { ...request, decisionKey: validatedHorsePolicySamplingKey(request) },
      'fast'
    );
    this.deps.restoreRng(rngBefore);
    const startedAt = this.deps.now();
    let captured: CapturedHorseMindDecision<ReturnType<typeof HorseLogic.decide>>;
    let rngAfter: number;
    try {
      const player = deepFreeze(request.player);
      const gameState = deepFreeze(request.gameState);
      this.deps.noteFeature('phase5_canonical_state');
      captured = this.deps.captureDecisionEffects(() =>
        this.deps.decide(player, gameState, request.style, request.mods, {
          ...request.opts,
          decisionTimeMs: request.decisionTimeMs,
          telemetry: true,
          observeMind: true,
          mindObservationHand: horseMindHandFromDecision(request),
          mindPlanContext: planContext,
        })
      );
      rngAfter = this.deps.saveRng();
    } finally {
      this.deps.restoreRng(canonicalRng);
    }
    if (!horseDecisionEffectsAreValid(captured.effects)) {
      throw new Error('Horse decision captured invalid plan effects');
    }
    const effects = horseReferenceWagerWasRetained(captured.value) ? captured.effects : [];
    if (
      !horseDecisionEffectsMatchRequest(effects, {
        userId: request.player.user_id,
        history: request.gameState.actionHistory,
        street: request.gameState.stage,
        brainFallback: captured.value.policyFallback === 'brain_exception',
        planContext,
      })
    )
      throw Error('Horse decision captured mismatched plan effects');
    if (captured.effects.length > 0 && effects.length === 0) {
      this.deps.noteFeature('phase15_reference_plans_retired');
    }
    let readFrame: HorseDecisionReadFrame | null = null;
    try {
      const handKey = horsePlanHandKey(request.gameState.actionHistory, planContext);
      readFrame = encodeHorseDecisionReads(
        HorseMind.snapshotDecisionReads(request.gameState.players, handKey),
        request.gameState.players,
        handKey,
        planContext
      );
    } catch {
      // Missing replay evidence must not discard an already computed fast
      // decision. A later second look will explicitly retain that decision.
      this.deps.noteFeature('phase15_second_look_reads_unavailable');
    }
    const at = startedAt;
    for (const [key, entry] of this.secondLookReads) {
      if (at - entry.at > HorseDecisionWorkerRuntime.SECOND_LOOK_READ_TTL_MS)
        this.secondLookReads.delete(key);
    }
    const readKey = this.readViewKey(request, rngBefore);
    const ambiguous = this.secondLookReads.has(readKey);
    this.secondLookReads.delete(readKey);
    while (this.secondLookReads.size >= HorseDecisionWorkerRuntime.MAX_SECOND_LOOK_READS) {
      this.secondLookReads.delete(this.secondLookReads.keys().next().value!);
    }
    this.secondLookReads.set(readKey, { at, frame: ambiguous ? null : readFrame });
    const computeMs = Math.max(0, this.deps.now() - startedAt);
    const governorScale = this.deps.governorScale();
    this.deps.noteDecision(request.gameState.gameVariant || 'nlh', computeMs);
    try {
      if (this.deps.journalEnabled?.() ?? true)
        this.deps.journalDecision?.(request, {
          snapshot: request,
          readFrame,
          planContext,
          planBinding,
          decision: captured.value,
          effects,
          rngBefore,
          rngAfter,
          computeMs,
          governorScale,
          readiness: this.deps.workerReadiness(),
          runtimePins: 'incomplete',
          lifecycleVersion: 1,
        });
    } catch {
      this.deps.noteFeature('phase15_journal_capture_unavailable');
    }
    // Reserve before promising issuance. The synchronous lane cannot run a
    // commit until send returns; a failed send relinquishes only this reservation.
    const planIssueDisposition = this.issuePlanBatch(planBinding, effects, startedAt);
    try {
      this.send({
        type: 'FAST_RESULT',
        requestId: request.requestId,
        planBinding,
        planIssueDisposition,
        generation: request.generation,
        fence: request.fence,
        decision: captured.value,
        rngBefore,
        rngAfter,
        computeMs,
        governorScale,
        // Retain intent only when the reference wager survived every later
        // policy owner. The client separately binds its hand, horse and street.
        effects,
      });
    } catch (error) {
      const key = JSON.stringify([planBinding.generation, planBinding.fence]);
      const entry = this.issuedPlanBatches.get(key);
      if (
        planIssueDisposition !== 'reissue_unavailable' &&
        entry?.bindingKey === horsePlanBatchBindingKey(planBinding)
      )
        this.issuedPlanBatches.delete(key);
      throw error;
    }
    this.deps.noteFeature(`phase15_plan_issue_${planIssueDisposition}`);
    return captured.value.policyFallback === 'brain_exception' ? 'exception' : 'success';
  }

  private executeDeep(request: DeepHorseDecisionRequest): HorseLifecycleOutcome {
    const planContext = horsePlanContextFromDecision(request);
    if (!Number.isFinite(request.deepEquity) || request.deepEquity <= 1) {
      throw new Error('deepEquity must be finite and greater than one');
    }

    const startedAt = this.deps.now();
    const readKey = this.readViewKey(request, request.rngBefore);
    const retained = this.secondLookReads.get(readKey);
    this.secondLookReads.delete(readKey);
    if (
      !retained?.frame ||
      startedAt - retained.at > HorseDecisionWorkerRuntime.SECOND_LOOK_READ_TTL_MS
    ) {
      this.deps.noteFeature('phase15_second_look_reads_unavailable');
      this.send({
        type: 'ERROR',
        requestId: request.requestId,
        generation: request.generation,
        fence: request.fence,
        message: 'second look original opponent reads unavailable',
        recoverable: true,
      });
      return 'refused';
    }
    let readView;
    try {
      readView = decodeHorseDecisionReads(
        retained.frame,
        request.gameState.players,
        horsePlanHandKey(request.gameState.actionHistory, planContext),
        planContext
      );
    } catch {
      this.deps.noteFeature('phase15_second_look_reads_unavailable');
      this.send({
        type: 'ERROR',
        requestId: request.requestId,
        generation: request.generation,
        fence: request.fence,
        message: 'Horse decision read frame is invalid',
        recoverable: true,
      });
      return 'refused';
    }
    // The latest worker stream is canonical. The second look borrows the fast
    // decision's starting point, then restores the canonical stream even if
    // a future HorseLogic version throws outside its own safety net.
    const canonicalRng = this.deps.saveRng();
    this.deps.restoreRng(request.rngBefore);
    let decision;
    let rngAfter: number | null = null;
    try {
      const player = deepFreeze(request.player);
      const gameState = deepFreeze(request.gameState);
      decision = HorseMind.runInSandbox(
        readView,
        () =>
          this.deps.captureDecisionEffects(() =>
            this.deps.decide(player, gameState, request.style, request.mods, {
              ...request.opts,
              decisionTimeMs: request.decisionTimeMs,
              telemetry: false,
              deepEquity: request.deepEquity,
              observeMind: false,
              mindPlanContext: planContext,
            })
          ).value
      );
      rngAfter = this.deps.saveRng();
    } finally {
      this.deps.restoreRng(canonicalRng);
    }
    const computeMs = Math.max(0, this.deps.now() - startedAt);
    const governorScale = this.deps.governorScale();
    this.deps.noteDecision(`deep:${request.gameState.gameVariant || 'nlh'}`, computeMs);
    this.deps.noteFeature('v44_second_look');
    try {
      if (this.deps.journalEnabled?.() ?? true)
        this.deps.journalDecision?.(request, {
          snapshot: request,
          readFrame: retained.frame,
          planContext,
          decision,
          rngBefore: request.rngBefore,
          rngAfter,
          computeMs,
          governorScale,
          readiness: this.deps.workerReadiness(),
          runtimePins: 'incomplete',
          lifecycleVersion: 1,
        });
    } catch {
      this.deps.noteFeature('phase15_journal_capture_unavailable');
    }
    this.send({
      type: 'DEEP_RESULT',
      requestId: request.requestId,
      planContext,
      generation: request.generation,
      fence: request.fence,
      decision,
      computeMs,
      governorScale,
    });
    return decision.policyFallback === 'brain_exception' ? 'exception' : 'success';
  }

  private executeObservation(request: ObserveCompletedHandRequest): void {
    try {
      this.deps.journalAcceptedHand?.(request);
    } catch {
      this.deps.noteFeature('phase15_journal_capture_unavailable');
    }
    this.deps.observeCompletedHand(request);
    this.send({
      type: 'ACK',
      requestId: request.requestId,
      generation: request.generation,
      fence: request.fence,
      operation: 'OBSERVE_COMPLETED_HAND',
    });
  }

  private executeEffectCommit(request: CommitDecisionEffectsRequest): void {
    const key = JSON.stringify([request.generation, request.fence]);
    const issued = this.issuedPlanBatches.get(key);
    const refusal: HorsePlanRefusal | null = !issued
      ? 'issue_absent'
      : horsePlanBatchBindingKey(request.planBinding) !== issued.bindingKey
        ? 'binding_mismatch'
        : horseDecisionEffectsKey(request.effects) !== issued.effectsKey
          ? 'effects_mismatch'
          : issued.state === 'ambiguous'
            ? 'issue_ambiguous'
            : issued.state === 'failed'
              ? 'issue_failed'
              : issued.state === 'retired'
                ? 'issue_retired'
                : issued.state === 'no_effects'
                  ? 'no_effects'
                  : null;
    if (refusal || !issued) {
      this.refusePlan(request, refusal ?? 'issue_absent');
      return;
    }
    const alreadyApplied = issued.state === 'applied';
    if (issued.state !== 'applied') {
      try {
        // Apply the detached issued records, not the later caller's object.
        this.deps.applyDecisionEffects(issued.effects);
        issued.state = 'applied';
        issued.at = this.deps.now();
      } catch (error) {
        // An unexpected throw can leave partial volatile writes. Never ACK or
        // retry this batch as applied; existing worker failure handling remains.
        issued.state = 'failed';
        issued.at = this.deps.now();
        this.deps.noteFeature('phase15_plan_apply_failed');
        throw error;
      }
    }
    this.send({
      type: 'ACK',
      requestId: request.requestId,
      generation: request.generation,
      fence: request.fence,
      operation: 'COMMIT_DECISION_EFFECTS',
      planDisposition: alreadyApplied ? 'already_applied_volatile' : 'applied_volatile',
    });
    this.deps.noteFeature(
      alreadyApplied ? 'phase15_plan_already_applied_volatile' : 'phase15_plan_applied_volatile'
    );
  }

  private refusePlan(
    request: CommitDecisionEffectsRequest | RetireDecisionEffectsRequest,
    reason: HorsePlanRefusal
  ): void {
    this.deps.noteFeature(`phase15_plan_refused_${reason}`);
    this.send({
      type: 'ERROR',
      requestId: request.requestId,
      generation: request.generation,
      fence: request.fence,
      message: `Horse plan batch refused: ${reason}`,
      recoverable: true,
      planRefusal: reason,
    });
  }

  private executeEffectRetirement(request: RetireDecisionEffectsRequest): void {
    const entry = this.issuedPlanBatches.get(JSON.stringify([request.generation, request.fence]));
    if (entry && horsePlanBatchBindingKey(request.planBinding) !== entry.bindingKey) {
      this.refusePlan(request, 'binding_mismatch');
      return;
    }
    const disposition = !entry
      ? 'issue_absent'
      : entry.state === 'applied'
        ? 'already_applied_volatile'
        : entry.state === 'failed'
          ? 'issue_failed'
          : entry.state === 'retired'
            ? 'already_retired'
            : 'retired';
    if (entry && disposition === 'retired') {
      entry.state = 'retired';
      entry.at = this.deps.now();
    }
    this.deps.noteFeature(`phase15_plan_retirement_${disposition}`);
    this.send({
      type: 'ACK',
      requestId: request.requestId,
      generation: request.generation,
      fence: request.fence,
      operation: 'RETIRE_DECISION_EFFECTS',
      planDisposition: disposition,
    });
  }

  private executeDiscard(request: DecidePineappleDiscardRequest): void {
    let snapshot: DecidePineappleDiscardRequest | undefined;
    try {
      if ((this.deps.journalEnabled?.() ?? true) && this.deps.journalDiscard)
        snapshot = JSON.parse(horseJournalJson(request));
    } catch {
      this.deps.noteFeature('phase15_journal_discard_capture_unavailable');
    }
    const canonicalRng = this.deps.saveRng();
    const rngBefore = this.requestRngSeed(request, 'discard');
    this.deps.restoreRng(rngBefore);
    const startedAt = this.deps.now();
    let cardIndex: number;
    let rngAfter: number;
    try {
      cardIndex = this.deps.decideDiscard(
        request.cards,
        request.communityCards,
        request.gameVariant
      );
      rngAfter = this.deps.saveRng();
    } finally {
      this.deps.restoreRng(canonicalRng);
    }
    if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex > 2) {
      throw new Error('pineapple discard worker returned an invalid card index');
    }
    const computeMs = Math.max(0, this.deps.now() - startedAt);
    const governorScale = this.deps.governorScale();
    if (snapshot) {
      try {
        this.deps.journalDiscard?.({
          version: 1,
          snapshot,
          cardIndex,
          rngBefore,
          rngAfter,
          computeMs,
          governorScale,
          runtimePins: 'incomplete',
          lifecycleVersion: 1,
        });
      } catch {
        this.deps.noteFeature('phase15_journal_discard_capture_unavailable');
      }
    }
    this.send({
      type: 'DISCARD_RESULT',
      requestId: request.requestId,
      generation: request.generation,
      fence: request.fence,
      cardIndex,
      computeMs,
      governorScale,
    });
  }

  /** Stable xorshift seed for one immutable canonical decision state. */
  private requestRngSeed(
    request: Pick<HorseDecisionJobRequest, 'generation' | 'fence'> & { decisionKey?: string },
    operation: 'fast' | 'discard'
  ): number {
    let hash = 0x811c9dc5;
    const material =
      operation === 'fast' && request.decisionKey
        ? `fast:${request.decisionKey}`
        : `${operation}:${request.generation}:${request.fence}`;
    for (let index = 0; index < material.length; index++) {
      hash ^= material.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    // Final avalanche prevents similar canonical state suffixes from producing
    // correlated first draws while remaining identical across worker restarts.
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x7feb352d);
    hash ^= hash >>> 15;
    hash = Math.imul(hash, 0x846ca68b);
    hash ^= hash >>> 16;
    return hash >>> 0 || 1;
  }

  private executeStatus(request: HorseDecisionStatusRequest): void {
    this.send({
      type: 'STATUS_RESULT',
      requestId: request.requestId,
      generation: request.generation,
      fence: request.fence,
      ...this.deps.workerReadiness(),
    });
  }

  private async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.secondLookReads.clear();
    this.issuedPlanBatches.clear();
    // Await boot first so a partially initialized writer is never abandoned.
    if (this.readyPromise) await this.readyPromise.catch(() => undefined);
    await this.deps.stopServices();
    this.send({ type: 'STOPPED' });
  }
}
