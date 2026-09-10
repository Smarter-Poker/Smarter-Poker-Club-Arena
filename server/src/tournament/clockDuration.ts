/**
 * Prospective atomic-clock duration authority. Explicit JSON number terms must
 * agree at database microsecond precision. Acceleration applies exactly once.
 * Not wired into a live manager until atomic clock adoption is reviewed.
 */
export interface ClockDurationRow {
  durationMinutes?: unknown;
  duration_minutes?: unknown;
  duration?: unknown;
  isBreak?: unknown;
}
export interface ClockDuration {
  rawDurationMs: number;
  rawDurationMicros: number;
  durationMs: number;
  durationMicros: number;
  sourceIndex: number;
  accelerated: boolean;
}
function durationMicros(milliseconds: number): number {
  const micros = Math.round(milliseconds * 1000);
  if (!Number.isSafeInteger(micros) || micros <= 0) {
    throw new Error('Clock duration exceeds finite microsecond precision');
  }
  return micros;
}
function rawClockLevelMicros(row: ClockDurationRow | undefined): number {
  let raw: number | undefined;
  for (const key of ['durationMinutes', 'duration_minutes', 'duration'] as const) {
    if (!row || !Object.prototype.hasOwnProperty.call(row, key)) continue;
    const term = row[key];
    if (typeof term !== 'number' || !Number.isFinite(term) || term <= 0) {
      throw new Error('Invalid advertised level duration');
    }
    const micros = durationMicros(key === 'duration' ? term * 1000 : term * 60 * 1000);
    if (raw !== undefined && raw !== micros)
      throw new Error('Conflicting advertised level durations');
    raw = micros;
  }
  if (raw === undefined) throw new Error('Advertised level duration is required');
  return raw;
}
export function rawClockLevelMs(row: ClockDurationRow | undefined): number {
  return rawClockLevelMicros(row) / 1000;
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
  const rawDurationMicros = rawClockLevelMicros(structure[sourceIndex]);
  const rawDurationMs = rawDurationMicros / 1000;
  const applyAcceleration = accelerated === true && entryClosed === true;
  const effectiveMicros = applyAcceleration
    ? durationMicros(Math.max(1, Math.ceil(rawDurationMs / 60000 / 2)) * 60000)
    : rawDurationMicros;
  return {
    rawDurationMs,
    rawDurationMicros,
    durationMs: effectiveMicros / 1000,
    durationMicros: effectiveMicros,
    sourceIndex,
    accelerated: applyAcceleration,
  };
}
