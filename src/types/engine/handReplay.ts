/**
 * Hand-replay shape types.
 *
 * Extracted 2026-04-23 (Phase U2 Stage A.2) from `src/engine/HandReplayEngine.ts`
 * so that UI components (HandReplay3D.tsx) can reference these shapes without
 * pulling in the client-side engine class. Replay playback logic stays wherever
 * it currently lives; only the data shapes move.
 */

export interface ReplayAction {
  type: 'deal_hole' | 'deal_community' | 'post_blind' | 'action' | 'showdown' | 'winners';
  playerId?: string;
  action?: string; // fold | check | call | raise | all_in
  amount?: number;
  cards?: string[];
  stage?: string; // preflop | flop | turn | river
  timestamp?: number;
}

export interface ReplayPlayerState {
  userId: string;
  username: string;
  stack: number;
  bet: number;
  cards: string[];
  isFolded: boolean;
  isAllIn: boolean;
  seat: number;
  isWinner?: boolean;
}

export interface ReplaySnapshot {
  stepIndex: number;
  totalSteps: number;
  stage: string;
  pot: number;
  communityCards: string[];
  players: ReplayPlayerState[];
  currentAction: ReplayAction | null;
  isPlaying: boolean;
  isEndOfHand?: boolean;
}

export type ReplaySpeed = 1 | 2 | 4;
