/** Read the engine's exact-level amounts without deriving another blind ladder. */
export function readCommittedTournamentBlinds(index: number, snapshot: unknown) {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot)
  )
    return null;
  const state = snapshot as Record<string, unknown>;
  // Same amount bounds as TournamentManagerBase.resolveCommittedBlindLevel.
  const amounts = [state.small_blind, state.big_blind, state.ante];
  if (
    state.index !== index ||
    !amounts.every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 10_000_000
    ) ||
    (state.big_blind as number) <= 0 ||
    (state.small_blind as number) > (state.big_blind as number)
  )
    return null;
  return {
    level: index + 1,
    smallBlind: state.small_blind as number,
    bigBlind: state.big_blind as number,
    small_blind: state.small_blind as number,
    big_blind: state.big_blind as number,
    ante: state.ante as number,
    isBreak: false as const,
  };
}
