import { buildLadder, type GeneratedBlindLevel } from './blindLadder.js';
import { mttSpeedForMinutes, type MttClockSpeed } from './mttStructureDescription.js';
import { isSupportedMttPayoutDepth } from './mttPayoutDepth.js';

/** One engine-owned definition for both scheduled and recurring MTT creators.
 * Existing advertised ladders are preserved; speed and stack depth are separate.
 * Changing these defaults applies only to newly created, unfunded events. */
export const MTT_BLIND_PRESETS: Record<string, GeneratedBlindLevel[]> = {
  SLOW: buildLadder({
    startBigBlind: 50,
    speed: 'SLOW',
    levels: 40,
    openingMinutes: 12,
    floorMinutes: 6,
    anteFromLevel: 3,
  }),
  STANDARD: buildLadder({
    startBigBlind: 50,
    speed: 'STANDARD',
    levels: 40,
    openingMinutes: 10,
    floorMinutes: 5,
    anteFromLevel: 2,
  }),
  TURBO: buildLadder({
    startBigBlind: 50,
    speed: 'TURBO',
    levels: 24,
    openingMinutes: 4,
    floorMinutes: 2,
    anteFromLevel: 1,
  }),
  HYPER_TURBO: buildLadder({
    startBigBlind: 100,
    speed: 'HYPER_TURBO',
    levels: 16,
    openingMinutes: 2,
    floorMinutes: 1,
    anteFromLevel: 1,
  }),
};
// These names already exist in published schedule configurations.
MTT_BLIND_PRESETS.DEEP = MTT_BLIND_PRESETS.SLOW;
MTT_BLIND_PRESETS.DEEPSTACK = MTT_BLIND_PRESETS.SLOW;

/** Speed metadata follows the actual opening clock, including custom arrays.
 * It cannot come from the event's name, its stack, or a preset overridden by
 * an explicit ladder. Later tapering/acceleration does not relabel the event.
 * Duration precedence and fallback match TournamentManagerBase's clock. */
export function mttSpeedColumns(structure: readonly unknown[]): {
  blind_speed: MttClockSpeed;
  is_turbo: boolean;
} {
  const opening = structure.find(
    (entry) =>
      entry !== null && typeof entry === 'object' && !(entry as { isBreak?: boolean }).isBreak
  ) as Record<string, unknown> | undefined;
  const minutes = Number(opening?.durationMinutes ?? opening?.duration_minutes);
  const seconds = Number(opening?.duration);
  const openingMinutes =
    Number.isFinite(minutes) && minutes > 0
      ? minutes
      : Number.isFinite(seconds) && seconds > 0
        ? seconds / 60
        : 10;
  const speed = mttSpeedForMinutes(openingMinutes)!;
  return { blind_speed: speed, is_turbo: speed === 'turbo' || speed === 'hyper_turbo' };
}

/** Matches the creator RPC's 10/15/20 paid-depth selection and 10% fallback.
 * This selects field depth only; the database derives the final funded ladder. */
export function mttPayoutPercent(value: unknown): 10 | 15 | 20 {
  if (typeof value === 'string' && !/^[+-]?\d+$/.test(value.trim())) return 10;
  if (typeof value !== 'string' && typeof value !== 'number') return 10;
  const depth = Number(value);
  return isSupportedMttPayoutDepth(depth) ? depth : 10;
}

/** Nominal playing minutes through the indexed registration cutoff. The engine
 * skips structure break markers and extends the final playable clock beyond the
 * ladder. Its level gate stays authoritative; maintenance credits are separate.
 * The persisted minute column is an integer, so never truncate a partial minute.
 * Call after validating the authored MTT structure, before inserting the event. */
export function mttLateRegistrationMinutes(structure: readonly unknown[], levels: number): number {
  if (!Number.isSafeInteger(levels) || levels < 0) {
    throw new Error('Invalid tournament late-registration level count');
  }
  if (levels === 0) return 0;
  let totalMs = 0;
  let lastPlayableMs = 0;
  for (const [index, entry] of structure.entries()) {
    const level = entry as Record<string, unknown>;
    if (level?.isBreak === true) continue;
    const minutes = Number(level?.durationMinutes ?? level?.duration_minutes);
    const seconds = Number(level?.duration);
    const duration = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : seconds * 1000;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Invalid tournament late-registration clock');
    }
    lastPlayableMs = duration;
    if (index < levels) totalMs += duration;
  }
  if (lastPlayableMs <= 0) throw new Error('Missing tournament late-registration clock');
  if (levels > structure.length) totalMs += (levels - structure.length) * lastPlayableMs;
  const result = Math.ceil(totalMs / 60_000);
  if (!Number.isSafeInteger(result) || result > 2_147_483_647) {
    throw new Error('Tournament late-registration minutes exceed the database range');
  }
  return result;
}
