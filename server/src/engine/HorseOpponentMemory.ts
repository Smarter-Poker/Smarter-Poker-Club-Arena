import { EXPLOIT_COUNTER_FIELDS, type ExploitCounters } from './HorseOpponentExploit.js';

export const MEMORY_VARIANTS = ['nlh', 'plo4', 'plo5', 'plo6', 'plo8'] as const;
export type MemoryVariant = (typeof MEMORY_VARIANTS)[number];
export type MemoryMode = 'cash' | 'tournament';
export type MemorySize = 'hu' | 'short' | 'full';
export interface DurableOpponentProfile {
  user_id: string;
  variant: MemoryVariant;
  mode: MemoryMode;
  size: MemorySize;
  observed_hands: number;
  initialized: boolean;
  counters: ExploitCounters;
}

export function memoryVariant(value: unknown): MemoryVariant | null {
  return typeof value === 'string' && MEMORY_VARIANTS.includes(value as MemoryVariant)
    ? (value as MemoryVariant)
    : null;
}

export function opponentMemoryKey(
  userId: string,
  variant: MemoryVariant,
  mode: MemoryMode,
  size: MemorySize
): string {
  return `${variant}:${mode}:${size}|${userId}`;
}

export function validOpponentProfile(value: unknown): value is DurableOpponentProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as DurableOpponentProfile;
  return (
    typeof p.user_id === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(p.user_id) &&
    memoryVariant(p.variant) !== null &&
    ['cash', 'tournament'].includes(p.mode) &&
    ['hu', 'short', 'full'].includes(p.size) &&
    Number.isSafeInteger(p.observed_hands) &&
    p.observed_hands >= 0 &&
    typeof p.initialized === 'boolean' &&
    !!p.counters &&
    typeof p.counters === 'object' &&
    Object.keys(p.counters).length === EXPLOIT_COUNTER_FIELDS.length &&
    EXPLOIT_COUNTER_FIELDS.every((f) => Number.isFinite(p.counters[f]) && p.counters[f] >= 0) &&
    (
      [
        ['vpip', 'hands'],
        ['pfr', 'hands'],
        ['rfi', 'rfiOpp'],
        ['threeBet', 'threeBetOpp'],
        ['foldTo3Bet', 'foldTo3BetOpp'],
        ['betCheckedTo', 'betCheckedToOpp'],
        ['foldToBet', 'foldToBetOpp'],
        ['riverCall', 'riverCallOpp'],
        ['fPfr', 'fHands'],
        ['fRfi', 'fRfiOpp'],
        ['fThreeBet', 'fThreeBetOpp'],
        ['fBetCheckedTo', 'fBetCheckedToOpp'],
        ['fFoldToBet', 'fFoldToBetOpp'],
        ['fRiverCall', 'fRiverCallOpp'],
      ] as const
    ).every(([success, opportunity]) => p.counters[success] <= p.counters[opportunity] + 1e-9)
  );
}
