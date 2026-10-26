/** Preference only: callers supply candidates that passed every normal seat door.
 * No horse is removed, funded, moved or admitted by this ordering. */
export interface PloPerformance {
  hands: number;
  bb100: number;
}

/** Existing PLO qualification uses 5,000 hands. Shrink a small sample toward
 * neutral by that sample weight, rather than treating a short heater as proven
 * skill. This is an advisory estimate, not a confidence interval or solver grade. */
export function measuredPloPreference(record: PloPerformance | undefined): number {
  if (
    !record ||
    !Number.isFinite(record.hands) ||
    record.hands <= 0 ||
    !Number.isFinite(record.bb100)
  )
    return 0;
  return record.bb100 * (record.hands / (record.hands + 5_000));
}

export function orderMadnessCandidates<T extends { h: { id: string }; w: number }>(
  candidates: readonly T[],
  table: {
    game_variant?: unknown;
    bomb_pot_enabled?: unknown;
    big_blind_ante_enabled?: unknown;
    nit_game?: unknown;
    maintain_percent_min?: unknown;
  },
  performance: ReadonlyMap<string, PloPerformance>
): T[] {
  const madness =
    String(table.game_variant ?? '').toLowerCase() === 'plo5' &&
    table.bomb_pot_enabled === true &&
    table.big_blind_ante_enabled === true &&
    table.nit_game === true &&
    Number(table.maintain_percent_min) === 50;
  return candidates
    .map((candidate) => ({
      candidate,
      preference: madness ? measuredPloPreference(performance.get(candidate.h.id)) : 0,
    }))
    .sort((a, b) => b.preference - a.preference || b.candidate.w - a.candidate.w)
    .map(({ candidate }) => candidate);
}
