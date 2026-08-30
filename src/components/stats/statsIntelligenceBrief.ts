/**
 * A factual first read of data PlayerStatsPage has already loaded.
 *
 * This is intentionally not a second leak detector. The Personal Assistant owns
 * coaching; this layer only answers "what is in this range?" and keeps every
 * claim tied to the sample shown beside it.
 */

interface BriefOverall {
  total_hands: number;
  cash_hands: number;
}

interface BriefPosition {
  position: string;
  hands_played: number;
  bb100: number;
}

interface BriefVariant {
  variant: string;
  hands: number;
  bb100: number;
}

interface BriefDailyPoint {
  date: string;
  profit: number;
}

export interface IntelligenceBriefItem {
  id: 'sample' | 'position' | 'game' | 'trend';
  label: string;
  value: string;
  detail: string;
  tone: 'neutral' | 'positive' | 'negative';
}

const MIN_SEGMENT_HANDS = 50;

function signed(value: number, digits = 1): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

export function buildStatsIntelligenceBrief(input: {
  overall: BriefOverall;
  positions?: BriefPosition[] | null;
  variants?: BriefVariant[] | null;
  daily?: BriefDailyPoint[] | null;
}): IntelligenceBriefItem[] {
  const { overall } = input;
  const positions = input.positions ?? [];
  const variants = input.variants ?? [];
  const daily = input.daily ?? [];
  const sampleHands = overall.cash_hands || overall.total_hands;
  const sampleValue =
    sampleHands < 1_000 ? 'Early Read' : sampleHands < 5_000 ? 'Developing' : 'Established';

  const qualifiedPositions = positions
    .filter((row) => row.hands_played >= MIN_SEGMENT_HANDS && Number.isFinite(row.bb100))
    .sort((a, b) => b.bb100 - a.bb100);
  const bestPosition = qualifiedPositions[0];

  const qualifiedVariants = variants
    .filter((row) => row.hands >= MIN_SEGMENT_HANDS && Number.isFinite(row.bb100))
    .sort((a, b) => b.bb100 - a.bb100);
  const bestVariant = qualifiedVariants[0];

  const recent = daily.slice(-7);
  const recentProfit = recent.reduce(
    (sum, row) => sum + (Number.isFinite(row.profit) ? row.profit : 0),
    0
  );
  const trendValue =
    recent.length === 0
      ? 'No Results'
      : recentProfit > 0
        ? 'Positive'
        : recentProfit < 0
          ? 'Negative'
          : 'Flat';

  return [
    {
      id: 'sample',
      label: 'Sample Confidence',
      value: sampleValue,
      detail: `${sampleHands.toLocaleString()} ${overall.cash_hands ? 'cash ' : ''}hands in this read.`,
      tone: 'neutral',
    },
    {
      id: 'position',
      label: 'Best-Supported Position',
      value: bestPosition?.position || 'Building Sample',
      detail: bestPosition
        ? `${signed(bestPosition.bb100)} BB/100 across ${bestPosition.hands_played.toLocaleString()} hands.`
        : `Needs ${MIN_SEGMENT_HANDS.toLocaleString()} hands in one position.`,
      tone: !bestPosition ? 'neutral' : bestPosition.bb100 >= 0 ? 'positive' : 'negative',
    },
    {
      id: 'game',
      label: 'Best-Supported Game',
      value: bestVariant?.variant ? bestVariant.variant.toUpperCase() : 'Building Sample',
      detail: bestVariant
        ? `${signed(bestVariant.bb100)} BB/100 across ${bestVariant.hands.toLocaleString()} hands.`
        : `Needs ${MIN_SEGMENT_HANDS.toLocaleString()} hands in one game.`,
      tone: !bestVariant ? 'neutral' : bestVariant.bb100 >= 0 ? 'positive' : 'negative',
    },
    {
      id: 'trend',
      label: 'Recent Result Direction',
      value: trendValue,
      detail:
        recent.length > 0
          ? `${signed(recentProfit, 0)} over the latest ${recent.length.toLocaleString()} recorded ${recent.length === 1 ? 'day' : 'days'}.`
          : 'No recorded cash results in this window.',
      tone: recentProfit > 0 ? 'positive' : recentProfit < 0 ? 'negative' : 'neutral',
    },
  ];
}
