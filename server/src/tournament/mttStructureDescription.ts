/** Pure engine-owned tournament structure facts for creation and presentation.
 * These functions do not choose or mutate a funded event's rules. */
export type MttClockSpeed = 'standard' | 'slow' | 'turbo' | 'hyper_turbo';

export function mttSpeedForMinutes(value: number): MttClockSpeed | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value <= 2 ? 'hyper_turbo' : value <= 5 ? 'turbo' : value >= 12 ? 'slow' : 'standard';
}

interface PlayingLevelDescription {
  /** Minutes only. Adapt stored seconds before calling. */
  durationMinutes: number;
  bigBlind: number;
  isBreak: boolean;
}

export function describeMttStructure(
  levels: readonly PlayingLevelDescription[],
  startingChips: number
) {
  const playing = levels.filter((level) => !level.isBreak);
  const opening = playing[0];
  const openingMinutes =
    opening && Number.isFinite(opening.durationMinutes) && opening.durationMinutes > 0
      ? opening.durationMinutes
      : null;
  const openingBigBlind =
    opening && Number.isFinite(opening.bigBlind) && opening.bigBlind > 0 ? opening.bigBlind : null;
  const startingDepthBB =
    openingBigBlind !== null && Number.isFinite(startingChips) && startingChips > 0
      ? startingChips / openingBigBlind
      : null;
  const speed = openingMinutes === null ? null : mttSpeedForMinutes(openingMinutes);
  const speedLabel =
    speed === 'hyper_turbo'
      ? 'Hyper Turbo'
      : speed === 'turbo'
        ? 'Turbo'
        : speed === 'slow'
          ? 'Slow'
          : speed === 'standard'
            ? 'Regular'
            : null;
  const allDurationsKnown =
    playing.length > 0 &&
    playing.every((level) => Number.isFinite(level.durationMinutes) && level.durationMinutes > 0);
  const durations = playing.map((level) => level.durationMinutes);
  return {
    speed,
    speedLabel,
    openingMinutes,
    openingBigBlind,
    startingDepthBB:
      startingDepthBB !== null && Number.isFinite(startingDepthBB) ? startingDepthBB : null,
    minimumMinutes: allDurationsKnown
      ? durations.reduce((minimum, value) => Math.min(minimum, value), Infinity)
      : null,
    maximumMinutes: allDurationsKnown
      ? durations.reduce((maximum, value) => Math.max(maximum, value), -Infinity)
      : null,
  };
}

export type MttStructureDescription = ReturnType<typeof describeMttStructure>;

/** Read stored structures without estimating clocks from names or treating
 * stored seconds as minutes. Duration precedence matches the engine creator.
 * Invalid entries keep their position, so later evidence cannot become opening
 * evidence merely because an earlier row is malformed. */
export function describeStoredMttStructure(
  raw: unknown,
  startingChips: unknown
): MttStructureDescription {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const number = (value: unknown): number =>
    typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  const levels = Array.isArray(parsed)
    ? Array.from(parsed, (entry: unknown) => {
        const row =
          entry !== null && typeof entry === 'object' && !Array.isArray(entry)
            ? (entry as Record<string, unknown>)
            : {};
        const validBreakFlag = row.isBreak === undefined || typeof row.isBreak === 'boolean';
        const minutes = validBreakFlag ? number(row.durationMinutes ?? row.duration_minutes) : NaN;
        const seconds = validBreakFlag ? number(row.duration) : NaN;
        return {
          durationMinutes:
            Number.isFinite(minutes) && minutes > 0
              ? minutes
              : Number.isFinite(seconds) && seconds > 0
                ? seconds / 60
                : 0,
          bigBlind: validBreakFlag ? number(row.bigBlind ?? row.big_blind) : NaN,
          isBreak: row.isBreak === true,
        };
      })
    : [];
  return describeMttStructure(levels, number(startingChips));
}

export function mttClockDescription(structure: MttStructureDescription): string {
  if (structure.openingMinutes === null) return 'Unconfirmed';
  if (structure.minimumMinutes === null || structure.maximumMinutes === null)
    return `${structure.openingMinutes} Min Opening`;
  if (structure.minimumMinutes !== structure.maximumMinutes)
    return `${structure.openingMinutes} Min Opening · ${structure.minimumMinutes}-${structure.maximumMinutes} Min Range`;
  return `${structure.openingMinutes} Min`;
}
