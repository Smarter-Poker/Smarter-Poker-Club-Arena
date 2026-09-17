import type { HorsePlanBatchBinding, HorsePlanContext } from '../HorsePlanHandIdentity.js';
/**
 * Structured-clone-safe messages for the one live HorseLogic compute lane.
 *
 * Every decision carries both the engine lifecycle generation and its exact
 * hand/turn fence.  They are echoed unchanged in every terminal response so
 * the table can discard work that finished after ownership, hand or turn
 * authority moved.  A request id orders the process-wide FIFO; it is not an
 * authority token by itself.
 */

import { createHash } from 'node:crypto';
import { HORSE_REVIEW_SIGNAL_KEYS } from '../HorseReviewSignals.js';

import type { HorseDecideOpts, HorseGameStateV2, HorseProfileMods } from '../HorseLogic.js';
import type { HorseMindDecisionEffect, ReadScope } from '../HorseMind.js';
import type { GovernorSnapshot } from '../EquityLoadGovernor.js';
import type { Card, HorseDecision, HorseStyle, SeatPlayer } from '../../types.js';
import type { solverPolicyArtifactStatus } from '../../gto/SolverPolicyArtifactLoader.js';

export interface HorseDecisionFence {
  generation: number;
  fence: string;
}

/** Options the live caller may pass. Worker ownership fixes telemetry/depth. */
export type LiveHorseDecideOpts = Omit<
  HorseDecideOpts,
  | 'telemetry'
  | 'deepEquity'
  | 'decisionTimeMs'
  | 'observeMind'
  | 'mindObservationHand'
  | 'mindPlanContext'
  | 'gtoV31DatasetChecksum'
  | 'onGtoV31Decision'
>;

export interface LiveHorseDecisionSnapshot extends HorseDecisionFence {
  /** Private accepted-history prefix captured beside the live turn. Diagnostic
   * binding only; excluded from strategy sampling, included in input validation. */
  handJournalContext?: import('../HorseDecisionHandBinding.js').HorseHandJournalContext | null;
  /** Epoch captured while this turn snapshot was authoritative, before FIFO wait. */
  decisionTimeMs: number;
  /** Full input digest, including diagnostic evidence, validated by the worker. */
  decisionKey: string;
  player: SeatPlayer;
  gameState: HorseGameStateV2;
  style?: HorseStyle;
  mods?: HorseProfileMods;
  opts?: LiveHorseDecideOpts;
}

type HorseDecisionKeyInput = Pick<
  LiveHorseDecisionSnapshot,
  | 'fence'
  | 'decisionTimeMs'
  | 'player'
  | 'gameState'
  | 'style'
  | 'mods'
  | 'opts'
  | 'handJournalContext'
>;

/** JSON-compatible canonicalizer with sorted object keys and finite numbers. */
function canonicalDecisionValue(value: unknown, path = '$'): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error(`decision key contains non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalDecisionValue(item, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      // Structured clone cannot carry functions or symbols. Undefined object
      // fields are behaviorally identical to omission when options are spread.
      if (item !== undefined) out[key] = canonicalDecisionValue(item, `${path}.${key}`);
    }
    return out;
  }
  throw new Error(`decision key contains unsupported value at ${path}`);
}

/**
 * Bind worker validation to every supplied decision input, including diagnostics.
 * The raw millisecond clock is reduced to the exact hour bucket used by
 * moodOf(), so same-hour replay is stable while an actual strategy input is
 * not omitted. The digest keeps hero cards and public hand history out of log
 * keys without weakening worker-side equality validation.
 */
export function buildHorseDecisionKey(input: HorseDecisionKeyInput): string {
  const material = canonicalDecisionValue({
    schemaVersion: 1,
    fence: input.fence,
    decisionHour: Math.floor(input.decisionTimeMs / 3_600_000),
    player: input.player,
    gameState: input.gameState,
    style: input.style ?? null,
    mods: input.mods ?? null,
    opts: input.opts ?? null,
    ...(input.handJournalContext !== undefined
      ? { handJournalContext: input.handJournalContext }
      : {}),
  });
  const digest = createHash('sha256').update(JSON.stringify(material)).digest('hex');
  return `phase5-v1:${digest}`;
}

/**
 * Sampling excludes observational evidence; the FULL decision key above still
 * validates it. Empty option/modifier bags normalize to absent, so adding only
 * review metadata cannot choose another mixed strategy. Authored modifiers,
 * persona, state, fence, decision hour and all other options remain bound.
 * Reuse the digest only after the caller has validated the full request key.
 */
export function validatedHorsePolicySamplingKey(
  input: HorseDecisionKeyInput & { decisionKey: string }
): string {
  function project<T extends object>(
    value: T | undefined,
    excluded: readonly string[]
  ): T | undefined {
    if (!value) return undefined;
    const entries = Object.entries(value).filter(
      ([key, item]) => item !== undefined && !excluded.includes(key)
    );
    if (!entries.length) return undefined;
    return entries.length === Object.keys(value).length
      ? value
      : (Object.fromEntries(entries) as T);
  }
  const mods = project(input.mods, HORSE_REVIEW_SIGNAL_KEYS);
  // Legacy v41Leaks now controls diagnostic telemetry only.
  const opts = project(input.opts, ['v41Leaks']);
  return mods === input.mods && opts === input.opts && input.handJournalContext === undefined
    ? input.decisionKey
    : buildHorseDecisionKey({ ...input, mods, opts, handJournalContext: undefined });
}

export interface FastHorseDecisionRequest extends LiveHorseDecisionSnapshot {
  type: 'DECIDE_FAST';
  requestId: number;
}

export interface DeepHorseDecisionRequest extends LiveHorseDecisionSnapshot {
  type: 'DECIDE_DEEP';
  requestId: number;
  /** RNG snapshot returned by the corresponding fast decision. */
  rngBefore: number;
  /** V44 sample multiplier. Must be finite and greater than one. */
  deepEquity: number;
}

export interface CompletedHandObservation extends HorseDecisionFence {
  /** UUID returned by the accepted hand transaction; absent on legacy replay. */
  committedHandId?: string;
  handKey: string;
  actions:
    | Array<{
        seat?: number;
        userId?: string;
        action: string;
        amount?: number;
        stage: string;
        timestamp?: number;
        isFullRaise?: boolean;
        publicNode?: import('../HorsePublicActionNode.js').HorsePublicActionNode;
        origin?: import('../../types.js').AcceptedActionOrigin;
        observationIdentity?: import('../HorseObservationIdentity.js').HorseObservationIdentity;
      }>
    | undefined;
  bigBlind: number;
  showdown?: Array<{ user_id: string; mucked: boolean; hand_name?: string }> | null;
  scope?: ReadScope | null;
}

export interface ObserveCompletedHandRequest extends CompletedHandObservation {
  type: 'OBSERVE_COMPLETED_HAND';
  requestId: number;
}

export interface CommitDecisionEffectsRequest extends HorseDecisionFence {
  type: 'COMMIT_DECISION_EFFECTS';
  requestId: number;
  /** Original FAST issue identity; this requestId is only the new FIFO job. */
  planBinding: HorsePlanBatchBinding;
  effects: HorseMindDecisionEffect[];
}

export interface ObserveHorseExecutionRequest extends HorseDecisionFence {
  type: 'OBSERVE_EXECUTION';
  requestId: number;
  witness: import('../HorseExecutionWitness.js').HorseExecutionWitness;
}

export interface ObserveHorseDiscardExecutionRequest extends HorseDecisionFence {
  type: 'OBSERVE_DISCARD_EXECUTION';
  requestId: number;
  execution: import('../../services/horseDecisionJournal/discard.js').HorseDiscardExecutionObservation;
}

/** Private client queue retirement only. The worker revalidates the original
 * snapshot without running its policy. This cannot authorize a live action. */
export interface ObserveHorseRequestRetirement extends HorseDecisionFence {
  type: 'OBSERVE_REQUEST_RETIREMENT';
  requestId: number;
  retiredRequest:
    | FastHorseDecisionRequest
    | DeepHorseDecisionRequest
    | DecidePineappleDiscardRequest;
  outcome: 'cancelled' | 'expired';
}

export interface HorseDecisionStatusRequest extends HorseDecisionFence {
  type: 'STATUS';
  requestId: number;
}

/** Private evidence only. This context must never enter a public table event
 * or alter the discard fence / policy sampling seed. */
export interface PineappleDiscardJournalContext {
  version: 1;
  tableId: string;
  handNumber: number;
  leaseGeneration: string;
  actorId: string;
  seat: number;
  requestedAtMs: number;
  lane: 'choice' | 'forced_runout';
  priorActions: import('../HorseDecisionHandBinding.js').HorseHandJournalContext;
}

export interface PineappleDiscardSnapshot extends HorseDecisionFence {
  /** Null means attribution was unavailable; gameplay still uses its original fence. */
  journalContext?: PineappleDiscardJournalContext | null;
  cards: Card[];
  communityCards: Card[];
  gameVariant: string;
}

export interface DecidePineappleDiscardRequest extends PineappleDiscardSnapshot {
  type: 'DECIDE_DISCARD';
  requestId: number;
}

export type HorseDecisionJobRequest =
  | ObserveHorseRequestRetirement
  | ObserveHorseDiscardExecutionRequest
  | ObserveHorseExecutionRequest
  | FastHorseDecisionRequest
  | DeepHorseDecisionRequest
  | ObserveCompletedHandRequest
  | CommitDecisionEffectsRequest
  | HorseDecisionStatusRequest
  | DecidePineappleDiscardRequest;

export type HorseDecisionWorkerRequest =
  | HorseDecisionJobRequest
  | { type: 'CANCEL'; requestId: number; reason?: 'cancelled' | 'expired' }
  | { type: 'SHUTDOWN' };

export interface HorseDecisionWorkerReady {
  type: 'READY';
  solverStores: {
    charts: number;
    postflop: number;
    postflopV31: number;
    /** Exact promoted corpus currently owned by this worker; null iff empty. */
    postflopV31Dataset: { id: string; checksum: string } | null;
  };
  /** Worker-owned snapshot; the main-thread module store is intentionally empty. */
  solverPolicyArtifact: ReturnType<typeof solverPolicyArtifactStatus>;
  /** Governor for the worker event loop where live Monte Carlo actually runs. */
  governor: GovernorSnapshot;
}

const SOLVER_STORE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOLVER_STORE_CHECKSUM = /^[0-9a-f]{64}$/;

/**
 * Runtime guard for the structured-clone boundary.
 *
 * TypeScript types disappear before a worker message arrives. In particular,
 * a positive V31 cell count without the exact promoted dataset identity must
 * never leave the engine in READY or let nightly evidence compare two
 * anonymous stores that merely have the same size.
 */
export function horseDecisionSolverStoresAreValid(
  value: unknown
): value is HorseDecisionWorkerReady['solverStores'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stores = value as Record<string, unknown>;
  if (
    Object.keys(stores).length !== 4 ||
    !['charts', 'postflop', 'postflopV31', 'postflopV31Dataset'].every((key) =>
      Object.prototype.hasOwnProperty.call(stores, key)
    ) ||
    !['charts', 'postflop', 'postflopV31'].every(
      (key) => Number.isSafeInteger(stores[key]) && (stores[key] as number) >= 0
    )
  ) {
    return false;
  }

  const count = stores.postflopV31 as number;
  const dataset = stores.postflopV31Dataset;
  if (count === 0) return dataset === null;
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) return false;
  const identity = dataset as Record<string, unknown>;
  return (
    Object.keys(identity).length === 2 &&
    typeof identity.id === 'string' &&
    SOLVER_STORE_UUID.test(identity.id) &&
    typeof identity.checksum === 'string' &&
    SOLVER_STORE_CHECKSUM.test(identity.checksum) &&
    identity.checksum !== '0'.repeat(64)
  );
}

export type HorseDecisionWorkerReadiness = Omit<HorseDecisionWorkerReady, 'type'>;

export interface FastHorseDecisionResult extends HorseDecisionFence {
  type: 'FAST_RESULT';
  requestId: number;
  planBinding: HorsePlanBatchBinding;
  decision: HorseDecision;
  rngBefore: number;
  rngAfter: number;
  computeMs: number;
  governorScale: number;
  /** Applied only after this exact intended action is accepted at the table. */
  effects: HorseMindDecisionEffect[];
}

export interface DeepHorseDecisionResult extends HorseDecisionFence {
  type: 'DEEP_RESULT';
  requestId: number;
  planContext: HorsePlanContext;
  decision: HorseDecision;
  computeMs: number;
  governorScale: number;
}

export interface HorseDecisionWorkerAck extends HorseDecisionFence {
  type: 'ACK';
  requestId: number;
  /** FIFO acceptance only. Journal durability has its own private writer ACK. */
  operation:
    | 'OBSERVE_REQUEST_RETIREMENT'
    | 'OBSERVE_COMPLETED_HAND'
    | 'COMMIT_DECISION_EFFECTS'
    | 'OBSERVE_EXECUTION'
    | 'OBSERVE_DISCARD_EXECUTION';
}

export interface HorseDecisionWorkerStatusResult extends HorseDecisionFence {
  type: 'STATUS_RESULT';
  requestId: number;
  solverStores: HorseDecisionWorkerReady['solverStores'];
  solverPolicyArtifact: HorseDecisionWorkerReady['solverPolicyArtifact'];
  governor: GovernorSnapshot;
}

export interface PineappleDiscardResult extends HorseDecisionFence {
  type: 'DISCARD_RESULT';
  requestId: number;
  cardIndex: number;
  computeMs: number;
  governorScale: number;
}

export interface HorseDecisionWorkerCancelled extends HorseDecisionFence {
  type: 'CANCELLED';
  requestId: number;
}

export interface HorseDecisionWorkerError {
  type: 'ERROR';
  requestId: number | null;
  generation?: number;
  fence?: string;
  message: string;
  /**
   * The worker rejected this one request at its structured-clone validation
   * boundary and remains safe to use. Missing means terminal runtime failure.
   */
  recoverable?: true;
}

export type HorseDecisionWorkerResponse =
  | HorseDecisionWorkerReady
  | FastHorseDecisionResult
  | DeepHorseDecisionResult
  | HorseDecisionWorkerAck
  | HorseDecisionWorkerStatusResult
  | PineappleDiscardResult
  | HorseDecisionWorkerCancelled
  | HorseDecisionWorkerError
  | { type: 'STOPPED' };
