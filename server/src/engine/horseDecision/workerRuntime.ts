import { performance } from 'node:perf_hooks';

import { HorseLogic } from '../HorseLogic.js';
import { HorseMind } from '../HorseMind.js';
import type { CapturedHorseMindDecision, HorseMindDecisionEffect } from '../HorseMind.js';
import { restoreFastRandom, saveFastRandom } from '../HorseEval.js';
import { equityGovernor } from '../EquityLoadGovernor.js';
import { bettingStructureFor } from '../BettingStructure.js';
import { calculateContestablePot } from '../PokerEngine.js';
import { horseVariantRulesFor, isKnownVariant } from '../VariantRules.js';
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
  HorseDecisionStatusRequest,
} from './protocol.js';
import { buildHorseDecisionKey } from './protocol.js';

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
    if (
      (request.type === 'DECIDE_FAST' || request.type === 'DECIDE_DEEP') &&
      request.opts &&
      ('gtoV31DatasetChecksum' in request.opts ||
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
    if (request.type === 'COMMIT_DECISION_EFFECTS') {
      if (!Array.isArray(request.effects) || request.effects.length > 16) {
        throw new Error('decision effects must be an array of at most 16 entries');
      }
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
    if (!isKnownVariant(gs.gameVariant)) throw new Error('horse state gameVariant is unknown');
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
