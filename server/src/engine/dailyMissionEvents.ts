export type DailyMissionHandEvent = {
  user_id: string;
  amounts: Record<string, number>;
  magnitudes: Record<string, number>;
};

/** Build immutable mission facts from one settled hand for every dealt player, including horses. */
export function buildDailyMissionHandEvents(input: {
  dealtPlayerIds: Iterable<string>;
  roster: Array<{ userId: string; isHorse: boolean }>;
  winners: Array<{ userId: string; amount: number }>;
  showdownResults: Array<{ userId: string; handRanking: number }>;
}): DailyMissionHandEvent[] {
  const players = new Set(input.roster.map((player) => player.userId));
  return [...input.dealtPlayerIds]
    .filter((userId) => players.has(userId))
    .map((userId) => {
      const potWon = Math.max(
        0,
        Math.floor(
          input.winners
            .filter((winner) => winner.userId === userId)
            .reduce((total, winner) => total + (Number(winner.amount) || 0), 0)
        )
      );
      const showdown = input.showdownResults.some((result) => result.userId === userId);
      const handRank = Math.max(
        0,
        ...input.showdownResults
          .filter((result) => result.userId === userId)
          .map((result) => Number(result.handRanking) || 0)
      );
      const won = potWon > 0;
      return {
        user_id: userId,
        amounts: {
          hands_played: 1,
          ...(won ? { hands_won: 1, chips_won: potWon, big_pots: 1 } : {}),
          ...(showdown ? { showdowns: 1 } : {}),
          ...(won && showdown ? { showdowns_won: 1 } : {}),
          ...(won && !showdown ? { hands_won_no_showdown: 1 } : {}),
          ...(won && handRank > 0 ? { strong_hands: 1 } : {}),
        },
        magnitudes: {
          ...(won ? { big_pots: potWon } : {}),
          ...(won && handRank > 0 ? { strong_hands: handRank } : {}),
        },
      };
    });
}
