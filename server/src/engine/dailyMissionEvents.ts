export type DailyMissionHandEvent = {
  user_id: string;
  amounts: Record<string, number>;
  magnitudes: Record<string, number>;
  /**
   * Exact per-occurrence values for thresholded mission categories.
   *
   * `amounts` and `magnitudes` remain scalar for deployed projection
   * consumers. The recorder can use these values to calculate the exact
   * increment for each assignment threshold instead of applying one maximum
   * magnitude to every occurrence in the hand.
   */
  values: Partial<Record<'big_pots' | 'strong_hands', number[]>>;
};

/** Build immutable mission facts from one settled hand for every dealt player, including horses. */
export function buildDailyMissionHandEvents(input: {
  dealtPlayerIds: Iterable<string>;
  roster: Array<{ userId: string; isHorse: boolean }>;
  winners: Array<{ userId: string; amount: number }>;
  showdownResults: Array<{ userId: string; handRanking: number }>;
  pots: ReadonlyArray<{ index: number; amount: number }>;
  perPotAwards: ReadonlyArray<{
    userId: string;
    potIndex: number;
    amount: number;
    low: boolean;
    hand?: { ranking?: number };
    board?: number;
  }>;
}): DailyMissionHandEvent[] {
  const players = new Set(input.roster.map((player) => player.userId));
  const grossPotByIndex = new Map<number, number>();
  for (const pot of input.pots) {
    const index = Number(pot.index);
    const grossAmount = Math.round(Number(pot.amount) * 100) / 100;
    if (
      Number.isSafeInteger(index) &&
      index >= 0 &&
      Number.isFinite(grossAmount) &&
      grossAmount > 0
    ) {
      grossPotByIndex.set(index, grossAmount);
    }
  }

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
      const wonAwards = input.perPotAwards.filter(
        (award) => award.userId === userId && Number(award.amount) > 0
      );
      const wonPotIndexes = new Set(
        wonAwards
          .map((award) => Number(award.potIndex))
          .filter((index) => Number.isSafeInteger(index) && index >= 0)
      );
      const wonPotGrossValues = [...wonPotIndexes]
        .sort((a, b) => a - b)
        .flatMap((index) => {
          const grossAmount = grossPotByIndex.get(index);
          return grossAmount === undefined ? [] : [grossAmount];
        });
      const strongestWinningHand = Math.max(
        0,
        ...wonAwards
          .filter((award) => !award.low)
          .map((award) => Math.floor(Number(award.hand?.ranking)))
          .filter((ranking) => Number.isSafeInteger(ranking) && ranking > 0)
      );
      const won = potWon > 0;
      return {
        user_id: userId,
        amounts: {
          hands_played: 1,
          ...(won ? { hands_won: 1, chips_won: potWon } : {}),
          ...(wonPotGrossValues.length > 0 ? { big_pots: wonPotGrossValues.length } : {}),
          ...(showdown ? { showdowns: 1 } : {}),
          ...(won && showdown ? { showdowns_won: 1 } : {}),
          ...(won && !showdown ? { hands_won_no_showdown: 1 } : {}),
          ...(strongestWinningHand > 0 ? { strong_hands: 1 } : {}),
        },
        magnitudes: {
          ...(wonPotGrossValues.length > 0
            ? { big_pots: Math.floor(Math.max(...wonPotGrossValues)) }
            : {}),
          ...(strongestWinningHand > 0 ? { strong_hands: strongestWinningHand } : {}),
        },
        values: {
          ...(wonPotGrossValues.length > 0 ? { big_pots: wonPotGrossValues } : {}),
          ...(strongestWinningHand > 0 ? { strong_hands: [strongestWinningHand] } : {}),
        },
      };
    });
}
