/**
 * Shared poker-evaluation shape types.
 *
 * Extracted 2026-04-23 (Phase U2 Stage A.3) from `src/engine/PokerEngine.ts`
 * so that non-engine consumers (BBJService, etc.) can reference the hand
 * evaluation shape without pulling in the client-side engine. The Hetzner
 * game server is authoritative for actual evaluation; these are pure data
 * shapes for display and persistence.
 */

import type { Card } from '../database.types';

export interface EvaluatedHand {
  ranking: number;
  name: string;
  cards: Card[]; // Best 5 cards
  kickers: number[];
}

export interface Pot {
  amount: number;
  eligiblePlayers: string[]; // user_ids
}

export interface Winner {
  userId: string;
  amount: number;
  hand?: EvaluatedHand;
}

export interface ShowdownResult {
  seat: number;
  userId: string;
  cards: Card[];
  hand: EvaluatedHand;
}
