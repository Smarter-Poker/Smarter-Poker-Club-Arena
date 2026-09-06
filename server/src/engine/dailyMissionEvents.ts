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

/**
 * Mission thresholds describe named, conventional hand classes: Straight=5,
 * Flush=6, Full House=7, and Four Of A Kind=8. The game evaluator's numeric
 * ranking is intentionally variant-relative (Short Deck swaps Flush and Full
 * House), so it cannot be used as the mission magnitude when a name is
 * available.
 */
export function dailyMissionHandStrength(hand?: { name?: string; ranking?: number }): number {
  const name = String(hand?.name ?? '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();
  if (name.includes('royal')) return 10;
  if (name.includes('straight flush')) return 9;
  if (name.includes('four of a kind') || name.includes('quads')) return 8;
  if (name.includes('full house') || name.includes('boat')) return 7;
  if (name.includes('flush')) return 6;
  if (name.includes('straight')) return 5;
  if (name.includes('three of a kind') || name.includes('trips') || name.includes('set')) return 4;
  if (name.includes('two pair')) return 3;
  if (name.includes('pair')) return 2;
  if (name.includes('high card')) return 1;

  // Compatibility for an older/incomplete award shape with no name. Current
  // settlement always carries EvaluatedHand.name; accepting its bounded rank
  // keeps the durable hand writer replayable across rolling engine deploys.
  const ranking = Math.floor(Number(hand?.ranking));
  return Number.isSafeInteger(ranking) && ranking >= 1 && ranking <= 10 ? ranking : 0;
}

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
    hand?: { name?: string; ranking?: number };
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
          .map((award) => dailyMissionHandStrength(award.hand))
          .filter((ranking) => ranking > 0)
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
