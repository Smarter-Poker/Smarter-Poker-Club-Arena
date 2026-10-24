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

/**
 * ═══ A PROFILE IS EVIDENCE BEFORE ITS BACK-FILL (2026-10-24) ═══════════════
 * `initialized` means the one-time legacy back-fill (hands played before the
 * durable memory existed) has been folded in. That back-fill runs one player
 * per read request behind one database-wide lock, and on 2026-10-24 5,965 of
 * 15,199 profiles were still waiting - 730 of them with 240+ hands of their
 * own, 24 of them human players - while every reader dropped them. So a horse
 * met those players, on the first hand at every new table, with no read.
 *
 * The counters in an uninitialized row are exact for every hand since the
 * memory began; the back-fill only adds OLDER hands, which the 30-hand (and
 * 8-hand fast-window) decay weighs least. Leaving them out is a smaller
 * sample, never a biased one, and the Bayesian credibility gate already
 * prices sample size. So a row is used as soon as it exists, and a row that
 * later completes its back-fill supersedes the version without it.
 */
export function opponentProfileVersion(
  p: Pick<DurableOpponentProfile, 'observed_hands' | 'initialized'>
): number {
  return p.observed_hands * 2 + (p.initialized ? 1 : 0);
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

/**
 * ═══ A NEW TABLE IS NOT A NEW PLAYER (2026-10-24) ═══════════════════════════
 * The durable read is filed by exact game context: variant, cash or
 * tournament, and table size (heads-up, short, full). That is right - a
 * heads-up VPIP is not a six-max VPIP - but it made the first hand against a
 * player in a NEW context a cold read even when the horse had hundreds of
 * hands on them one size over. Lightning makes that the common case: seats
 * fill one at a time, so the same pool swings between short and full.
 *
 * When the exact bucket is thin, the other multiway bucket for the same
 * variant and the same mode stands in, at reduced weight (short for full, full
 * for short). Two separations are kept on purpose: heads-up never mixes with a
 * multiway bucket in either direction (the V45 reason for scoping at all), and
 * cash never mixes with tournament play (stack depth and ICM change what a
 * frequency means; HorseOpponentMemory.test pins that isolation). A donor's
 * counters are scaled, which keeps every rate and shrinks the evidence, so the
 * Bayesian credibility gate engages a read from borrowed hands only on a
 * clearer deviation.
 */
export const OPPONENT_MEMORY_THIN_HANDS = 12;
export const OPPONENT_MEMORY_DONOR_WEIGHT = 0.6;

export function opponentMemoryDonors(
  mode: MemoryMode,
  size: MemorySize
): ReadonlyArray<readonly [MemoryMode, MemorySize]> {
  if (size === 'hu') return [];
  return [[mode, size === 'full' ? 'short' : 'full']];
}

/**
 * The counters a read should use for (player, exact context): the exact row
 * when it is not thin, otherwise the exact row plus the richest donor at
 * OPPONENT_MEMORY_DONOR_WEIGHT. Undefined when nothing is known. Pure.
 */
export function blendOpponentMemory(
  exact: ExploitCounters | undefined,
  donors: ReadonlyArray<ExploitCounters | undefined>
): ExploitCounters | undefined {
  if (exact && exact.hands >= OPPONENT_MEMORY_THIN_HANDS) return exact;
  let best: ExploitCounters | undefined;
  for (const row of donors) if (row && row.hands > (best?.hands ?? 0)) best = row;
  if (!best) return exact;
  const out = {} as ExploitCounters;
  for (const f of EXPLOIT_COUNTER_FIELDS)
    out[f] = (exact?.[f] ?? 0) + OPPONENT_MEMORY_DONOR_WEIGHT * (best[f] ?? 0);
  return out;
}
