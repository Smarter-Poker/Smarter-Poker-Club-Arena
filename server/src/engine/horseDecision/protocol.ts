/**
 * Structured-clone-safe messages for the one live HorseLogic compute lane.
 *
 * Every decision carries both the engine lifecycle generation and its exact
 * hand/turn fence.  They are echoed unchanged in every terminal response so
 * the table can discard work that finished after ownership, hand or turn
 * authority moved.  A request id orders the process-wide FIFO; it is not an
 * authority token by itself.
 */

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
  | 'gtoV31DatasetChecksum'
  | 'onGtoV31Decision'
>;

export interface LiveHorseDecisionSnapshot extends HorseDecisionFence {
  /** Epoch captured while this turn snapshot was authoritative, before FIFO wait. */
  decisionTimeMs: number;
  player: SeatPlayer;
  gameState: HorseGameStateV2;
  style?: HorseStyle;
  mods?: HorseProfileMods;
  opts?: LiveHorseDecideOpts;
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
  handKey: string;
  actions:
    | Array<{
        userId?: string;
        action: string;
        amount?: number;
        stage: string;
        timestamp?: number;
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
  effects: HorseMindDecisionEffect[];
}

export interface HorseDecisionStatusRequest extends HorseDecisionFence {
  type: 'STATUS';
  requestId: number;
}

export interface PineappleDiscardSnapshot extends HorseDecisionFence {
  cards: Card[];
  communityCards: Card[];
  gameVariant: string;
}

export interface DecidePineappleDiscardRequest extends PineappleDiscardSnapshot {
  type: 'DECIDE_DISCARD';
  requestId: number;
}

export type HorseDecisionJobRequest =
  | FastHorseDecisionRequest
  | DeepHorseDecisionRequest
  | ObserveCompletedHandRequest
  | CommitDecisionEffectsRequest
  | HorseDecisionStatusRequest
  | DecidePineappleDiscardRequest;

export type HorseDecisionWorkerRequest =
  | HorseDecisionJobRequest
  | { type: 'CANCEL'; requestId: number }
  | { type: 'SHUTDOWN' };

export interface HorseDecisionWorkerReady {
  type: 'READY';
  solverStores: {
    charts: number;
    postflop: number;
    postflopV31: number;
  };
  /** Worker-owned snapshot; the main-thread module store is intentionally empty. */
  solverPolicyArtifact: ReturnType<typeof solverPolicyArtifactStatus>;
  /** Governor for the worker event loop where live Monte Carlo actually runs. */
  governor: GovernorSnapshot;
}

export type HorseDecisionWorkerReadiness = Omit<HorseDecisionWorkerReady, 'type'>;

export interface FastHorseDecisionResult extends HorseDecisionFence {
  type: 'FAST_RESULT';
  requestId: number;
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
  decision: HorseDecision;
  computeMs: number;
  governorScale: number;
}

export interface HorseDecisionWorkerAck extends HorseDecisionFence {
  type: 'ACK';
  requestId: number;
  operation: 'OBSERVE_COMPLETED_HAND' | 'COMMIT_DECISION_EFFECTS';
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
