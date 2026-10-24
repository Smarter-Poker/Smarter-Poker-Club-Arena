/** Cash horses have no variant/stake persona restriction. Bankroll and the
 * normal player admission rules decide eligibility (owner, October 23). */
export function isHoldemOrPlo(variant: unknown): boolean {
  const value = String(variant ?? '')
    .trim()
    .toLowerCase();
  return value === 'nlh' || value.startsWith('plo');
}

/** Finish filling existing games before opening more sparse games. Human
 * rescue and controller opening reservations remain ahead of this ordering. */
export function compareCashPopulation(
  a: { game_variant?: unknown; occupied: number; max_players: number },
  b: { game_variant?: unknown; occupied: number; max_players: number }
): number {
  return (
    Number(isHoldemOrPlo(b.game_variant)) - Number(isHoldemOrPlo(a.game_variant)) ||
    Number(b.occupied > 0) - Number(a.occupied > 0) ||
    b.occupied / Math.max(1, b.max_players) - a.occupied / Math.max(1, a.max_players)
  );
}
