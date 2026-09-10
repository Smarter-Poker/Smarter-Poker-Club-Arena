/**
 * Prospective atomic-clock duration authority. Raw advertised duration and the
 * effective epoch duration are separate: acceleration is applied exactly once.
 * Not wired into a live manager until the atomic clock adoption is reviewed.
 */
export interface ClockDurationRow {
  durationMinutes?: unknown;
  duration_minutes?: unknown;
  duration?: unknown;
  isBreak?: unknown;
}
export interface ClockDuration {
  rawDurationMs: number;
  durationMs: number;
  sourceIndex: number;
  accelerated: boolean;
}
function durationNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  // Duration metadata is a JSON scalar. Arrays/objects are not duration units.
  if (!['number', 'string', 'boolean'].includes(typeof value)) return 0;
  if (typeof value === 'string') {
    const decimal = value.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');
    if (!/^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$/.test(decimal)) return 0;
    value = decimal;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
export function rawClockLevelMs(row: ClockDurationRow | undefined): number {
  const camel = durationNumber(row?.durationMinutes);
  const snake = durationNumber(row?.duration_minutes);
  if (camel > 0 && snake > 0 && camel !== snake) {
    throw new Error('Conflicting advertised level durations');
  }
  const minutes = durationNumber(row?.durationMinutes ?? row?.duration_minutes);
  const seconds = durationNumber(row?.duration);
  const ms = minutes > 0 ? minutes * 60 * 1000 : seconds > 0 ? seconds * 1000 : 600000;
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('Level duration is not finite and positive');
  return ms;
}
export function clockDurationForLevel(
  structure: readonly ClockDurationRow[],
  levelIndex: number,
  shortFormat: boolean,
  accelerated: boolean,
  entryClosed: boolean
): ClockDuration {
  if (
    !Array.isArray(structure) ||
    !structure.length ||
    !Number.isInteger(levelIndex) ||
    levelIndex < 0
  ) {
    throw new Error('Clock level requires a persisted structure and nonnegative index');
  }
  let sourceIndex = Math.min(levelIndex, structure.length - 1);
  if (levelIndex >= structure.length && !shortFormat) {
    while (sourceIndex > 0 && structure[sourceIndex]?.isBreak === true) sourceIndex--;
  }
  let rawDurationMs = rawClockLevelMs(structure[sourceIndex]);
  // Preserve the existing generic-overflow floor, before applying acceleration.
  if (levelIndex >= structure.length && !shortFormat)
    rawDurationMs = Math.max(rawDurationMs, 120000);
  const applyAcceleration = accelerated === true && entryClosed === true;
  const durationMs = applyAcceleration
    ? Math.max(1, Math.ceil(rawDurationMs / 60000 / 2)) * 60000
    : rawDurationMs;
  return { rawDurationMs, durationMs, sourceIndex, accelerated: applyAcceleration };
}
