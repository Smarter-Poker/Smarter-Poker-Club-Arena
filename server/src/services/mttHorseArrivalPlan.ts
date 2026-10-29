/** Owner 2026-10-29: half the planned field before the gun, half during late entry. */
export function mttPlannedField(guarantee: number, prizeShare: number): number {
  // A house-funded pool is not evidence that entrants have arrived.
  const funded = guarantee > 0 && prizeShare > 0 ? Math.ceil(guarantee / prizeShare) : 0;
  return Math.max(48, Number.isSafeInteger(funded) ? funded : 0);
}

export function mttPrizeShare(row: { buy_in_amount?: unknown; bounty_amount?: unknown }): number {
  return Math.max(0, (Number(row.buy_in_amount) || 0) - (Number(row.bounty_amount) || 0));
}

export function mttPrestartPlan(field: number, maxPlayers: number | null): number {
  const goal = Math.ceil(field / 2);
  return maxPlayers === null ? goal : Math.min(maxPlayers - 1, goal);
}

/** Stored schedules use JSON text and durationMinutes; legacy ladders use seconds. */
export function mttLevelWindowMs(raw: unknown, levels: number): number | undefined {
  let ladder: unknown = raw;
  if (typeof ladder === 'string') {
    try {
      ladder = JSON.parse(ladder);
    } catch {
      return undefined;
    }
  }
  if (
    !Array.isArray(ladder) ||
    !Number.isSafeInteger(levels) ||
    levels <= 0 ||
    ladder.length < levels
  )
    return undefined;
  let total = 0;
  for (const level of ladder.slice(0, levels)) {
    const seconds =
      level && typeof level === 'object'
        ? Number(level.durationMinutes ?? 0) * 60 || Number(level.duration)
        : NaN;
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    total += seconds * 1000;
  }
  return Number.isSafeInteger(total) ? total : undefined;
}
