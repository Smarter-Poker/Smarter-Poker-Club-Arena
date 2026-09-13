import { buildLadder, type GeneratedBlindLevel } from './blindLadder.js';

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
  blind_speed: 'standard' | 'slow' | 'turbo' | 'hyper_turbo';
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
  const speed =
    openingMinutes <= 2
      ? 'hyper_turbo'
      : openingMinutes <= 5
        ? 'turbo'
        : openingMinutes >= 12
          ? 'slow'
          : 'standard';
  return { blind_speed: speed, is_turbo: speed === 'turbo' || speed === 'hyper_turbo' };
}
