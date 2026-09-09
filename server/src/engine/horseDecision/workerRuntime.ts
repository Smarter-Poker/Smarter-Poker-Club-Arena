import { performance } from 'node:perf_hooks';

import { HorseLogic } from '../HorseLogic.js';
import { HorseMind } from '../HorseMind.js';
import type { CapturedHorseMindDecision, HorseMindDecisionEffect } from '../HorseMind.js';
import { restoreFastRandom, saveFastRandom } from '../HorseEval.js';
import { equityGovernor } from '../EquityLoadGovernor.js';
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
  HorseDecisionStatusRequest,
} from './protocol.js';

export interface HorseDecisionWorkerDependencies {
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
    equityGovernor.startSampling();
    startSolverPolicyArtifactLoader();

    const lastFlush = await hydrateHorseMindFromDb();
    await Promise.all([
      hydrateHorseMind(lastFlush),
      loadGtoCharts(),
      loadGtoPostflop(),
      loadGtoPostflopV31(),
    ]);

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
  await Promise.all([stopBrainTelemetryFlush(), stopHorseMindPersistence()]);
}

export const defaultHorseDecisionWorkerDependencies: HorseDecisionWorkerDependencies = {
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
  observeCompletedHand: (request) =>
    HorseMind.observeHandComplete(
      request.handKey,
      request.actions,
      request.bigBlind,
      request.showdown,
      request.scope
    ),
  noteDecision: noteDecisionMs,
  noteFeature: noteFire,
  now: () => performance.now(),
};

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
  private operation: Promise<void> = Promise.resolve();
  private readonly cancelled = new Set<number>();
  /** Requests received but not yet terminal, independent of numeric order. */
  private readonly pendingRequestIds = new Set<number>();
  private accepting = true;
  private started = false;
  private stopped = false;
  private readyPromise: Promise<HorseDecisionWorkerReadiness> | null = null;
  constructor(
    private readonly send: (message: HorseDecisionWorkerResponse) => void,
    private readonly deps: HorseDecisionWorkerDependencies = defaultHorseDecisionWorkerDependencies
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
      if (this.pendingRequestIds.has(message.requestId)) this.cancelled.add(message.requestId);
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
    this.operation = this.operation.then(() => this.execute(message));
  }

  /** Test seam and graceful-worker close join. */
  async drain(): Promise<void> {
    await this.operation;
  }

  private async execute(request: HorseDecisionJobRequest): Promise<void> {
    try {
      await this.readyPromise;
      this.assertEnvelope(request);
      if (this.cancelled.delete(request.requestId)) {
        this.send({
          type: 'CANCELLED',
          requestId: request.requestId,
          generation: request.generation,
          fence: request.fence,
        });
        return;
      }

      if (request.type === 'DECIDE_FAST') this.executeFast(request);
      else if (request.type === 'DECIDE_DEEP') this.executeDeep(request);
      else if (request.type === 'OBSERVE_COMPLETED_HAND') this.executeObservation(request);
      else if (request.type === 'COMMIT_DECISION_EFFECTS') this.executeEffectCommit(request);
      else if (request.type === 'DECIDE_DISCARD') this.executeDiscard(request);
      else this.executeStatus(request);
    } catch (error) {
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
    if (
      (request.type === 'DECIDE_FAST' || request.type === 'DECIDE_DEEP') &&
      (!Number.isFinite(request.decisionTimeMs) || request.decisionTimeMs < 0)
    ) {
      throw new Error('decisionTimeMs must be a finite epoch');
    }
    if (request.type === 'DECIDE_FAST' || request.type === 'DECIDE_DEEP') {
      this.assertCanonicalDecisionSnapshot(request);
    }
    if (
      (request.type === 'DECIDE_FAST' || request.type === 'DECIDE_DEEP') &&
      request.opts &&
      ('gtoV31DatasetChecksum' in request.opts || 'onGtoV31Decision' in request.opts)
    ) {
      throw new Error('offline V31 candidate controls are forbidden in live decision requests');
    }
    if (
      request.type === 'DECIDE_DEEP' &&
      (!Number.isInteger(request.rngBefore) ||
        request.rngBefore < 0 ||
        request.rngBefore > 0xffffffff)
    ) {
      throw new Error('rngBefore must be an unsigned 32-bit integer');
    }
    if (request.type === 'COMMIT_DECISION_EFFECTS') {
      if (!Array.isArray(request.effects) || request.effects.length > 16) {
        throw new Error('decision effects must be an array of at most 16 entries');
      }
    }
    if (request.type === 'DECIDE_DISCARD') {
      if (!Array.isArray(request.cards) || request.cards.length !== 3) {
        throw new Error('pineapple discard requires exactly three cards');
      }
      if (!Array.isArray(request.communityCards) || request.communityCards.length > 5) {
        throw new Error('pineapple discard communityCards must contain at most five cards');
      }
      if (typeof request.gameVariant !== 'string' || request.gameVariant.length === 0) {
        throw new Error('pineapple discard gameVariant must be non-empty');
      }
    }
  }

  /** Runtime law at the structured-clone boundary; TypeScript cannot enforce it. */
  private assertCanonicalDecisionSnapshot(
    request: FastHorseDecisionRequest | DeepHorseDecisionRequest
  ): void {
    const gs = request.gameState;
    if (typeof request.decisionKey !== 'string' || request.decisionKey.length === 0) {
      throw new Error('decisionKey must be a non-empty canonical state key');
    }
    if (gs.stateSchemaVersion !== 1) throw new Error('horse state schema version 1 is required');
    if (gs.heroSeat !== request.player.seat || gs.currentPlayerSeat !== request.player.seat) {
      throw new Error('horse state hero/current seat does not match the decision player');
    }
    if (!Array.isArray(gs.players) || !gs.players.some((seat) => seat.seat === gs.heroSeat)) {
      throw new Error('horse state must include every public seat including hero');
    }
    if (gs.players.some((seat) => !Array.isArray(seat.cards) || seat.cards.length !== 0)) {
      throw new Error('horse state contains private seat cards');
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
    if (!Number.isFinite(gs.toCall) || (gs.toCall as number) < 0) {
      throw new Error('horse state toCall must be finite and non-negative');
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
    if (!['no_limit', 'pot_limit', 'fixed_limit'].includes(gs.bettingStructure ?? '')) {
      throw new Error('horse state bettingStructure is invalid');
    }
    if (!Array.isArray(gs.actionHistory) || !Array.isArray(gs.pots)) {
      throw new Error('horse state requires action history and live side pots');
    }
    if (
      gs.pots.some(
        (pot) =>
          !Number.isFinite(pot.amount) || pot.amount < 0 || !Array.isArray(pot.eligiblePlayers)
      )
    ) {
      throw new Error('horse state side-pot eligibility is invalid');
    }
    if (
      !gs.rakeConfig ||
      !Number.isFinite(gs.rakeConfig.percent) ||
      !Number.isFinite(gs.rakeConfig.cap) ||
      typeof gs.rakeConfig.noFlopNoDrop !== 'boolean'
    ) {
      throw new Error('horse state requires the exact rake config');
    }
    if (
      !gs.variantRules ||
      !Number.isSafeInteger(gs.variantRules.holeCardsDealt) ||
      !Number.isSafeInteger(gs.variantRules.deckSize)
    ) {
      throw new Error('horse state requires explicit variant rules');
    }
  }

  private executeFast(request: FastHorseDecisionRequest): void {
    const canonicalRng = this.deps.saveRng();
    const rngBefore = this.requestRngSeed(request, 'fast');
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
        })
      );
      rngAfter = this.deps.saveRng();
    } finally {
      this.deps.restoreRng(canonicalRng);
    }
    const computeMs = Math.max(0, this.deps.now() - startedAt);
    const governorScale = this.deps.governorScale();
    this.deps.noteDecision(request.gameState.gameVariant || 'nlh', computeMs);
    this.send({
      type: 'FAST_RESULT',
      requestId: request.requestId,
      generation: request.generation,
      fence: request.fence,
      decision: captured.value,
      rngBefore,
      rngAfter,
      computeMs,
      governorScale,
      effects: captured.effects,
    });
  }

  private executeDeep(request: DeepHorseDecisionRequest): void {
    if (!Number.isFinite(request.deepEquity) || request.deepEquity <= 1) {
      throw new Error('deepEquity must be finite and greater than one');
    }

    // The latest worker stream is canonical. The replay borrows the fast
    // decision's starting point, then restores the canonical stream even if
    // a future HorseLogic version throws outside its own safety net.
    const canonicalRng = this.deps.saveRng();
    this.deps.restoreRng(request.rngBefore);
    const startedAt = this.deps.now();
    let decision;
    try {
      const player = deepFreeze(request.player);
      const gameState = deepFreeze(request.gameState);
      decision = this.deps.captureDecisionEffects(() =>
        this.deps.decide(player, gameState, request.style, request.mods, {
          ...request.opts,
          decisionTimeMs: request.decisionTimeMs,
          telemetry: false,
          deepEquity: request.deepEquity,
          observeMind: false,
        })
      ).value;
    } finally {
      this.deps.restoreRng(canonicalRng);
    }
    const computeMs = Math.max(0, this.deps.now() - startedAt);
    const governorScale = this.deps.governorScale();
    this.deps.noteDecision(`deep:${request.gameState.gameVariant || 'nlh'}`, computeMs);
    this.deps.noteFeature('v44_second_look');
    this.send({
      type: 'DEEP_RESULT',
      requestId: request.requestId,
      generation: request.generation,
      fence: request.fence,
      decision,
      computeMs,
      governorScale,
    });
  }

  private executeObservation(request: ObserveCompletedHandRequest): void {
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
    this.deps.applyDecisionEffects(request.effects);
    this.send({
      type: 'ACK',
      requestId: request.requestId,
      generation: request.generation,
      fence: request.fence,
      operation: 'COMMIT_DECISION_EFFECTS',
    });
  }

  private executeDiscard(request: DecidePineappleDiscardRequest): void {
    const canonicalRng = this.deps.saveRng();
    this.deps.restoreRng(this.requestRngSeed(request, 'discard'));
    const startedAt = this.deps.now();
    let cardIndex: number;
    try {
      cardIndex = this.deps.decideDiscard(
        request.cards,
        request.communityCards,
        request.gameVariant
      );
    } finally {
      this.deps.restoreRng(canonicalRng);
    }
    if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex > 2) {
      throw new Error('pineapple discard worker returned an invalid card index');
    }
    const computeMs = Math.max(0, this.deps.now() - startedAt);
    this.send({
      type: 'DISCARD_RESULT',
      requestId: request.requestId,
      generation: request.generation,
      fence: request.fence,
      cardIndex,
      computeMs,
      governorScale: this.deps.governorScale(),
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
    // Await boot first so a partially initialized writer is never abandoned.
    if (this.readyPromise) await this.readyPromise.catch(() => undefined);
    await this.deps.stopServices();
    this.send({ type: 'STOPPED' });
  }
}
