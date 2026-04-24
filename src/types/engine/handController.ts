/**
 * HandController shape + HandEvent discriminated union.
 *
 * Extracted 2026-04-23 (Phase U2 Stage A.5) from `src/engine/HandController.ts`
 * so that `HandPersistenceService` can wire event listeners without importing
 * the client-side HandController class. The Hetzner game server owns the
 * real `HandController`; this module only declares the shape of what it
 * emits so services can type-check their subscribers.
 *
 * HandController here is an `interface` capturing the public API that
 * HandPersistenceService touches (`onEvent`) — not the full class. If another
 * consumer needs more methods, extend this interface rather than reaching
 * back into the engine.
 */

import type { SeatPlayer, Card, HandStage, ActionType } from '../database.types';
import type { EvaluatedHand, Pot, Winner, ShowdownResult } from './poker';

export type { ShowdownResult } from './poker';

export type HandEvent =
  | { type: 'HAND_START'; handNumber: number; players: SeatPlayer[] }
  | { type: 'CARDS_DEALT'; seat: number; cards: Card[] }
  | { type: 'COMMUNITY_CARDS'; stage: HandStage; cards: Card[] }
  | { type: 'PLAYER_ACTION'; seat: number; action: ActionType; amount: number }
  | { type: 'POT_UPDATE'; pot: number; pots: Pot[] }
  | { type: 'TURN_CHANGE'; seat: number; availableActions: ActionType[] }
  | {
      type: 'ALL_IN_RUNOUT_PENDING';
      remainingDeck: Card[];
      existingBoard: Card[];
      pot: number;
      activePlayers: SeatPlayer[];
    }
  | { type: 'SHOWDOWN'; results: ShowdownResult[] }
  | { type: 'WINNERS'; winners: Winner[] }
  | { type: 'HAND_COMPLETE'; handNumber: number; rake: number; pot: number; sawFlop: boolean };

/**
 * Minimum contract HandPersistenceService needs. Extend only when adding new
 * consumers — do NOT mirror the full engine class.
 */
export interface HandController {
  onEvent(handler: (event: HandEvent) => void): () => void;
}

// Silence unused-import warning for re-exports that downstream may need.
export type { EvaluatedHand };
