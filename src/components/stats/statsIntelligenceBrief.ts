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
  hands: number;
  profit: number;
}

export interface IntelligenceBriefItem {
  id: 'sample' | 'position' | 'game' | 'trend';
  label: string;
  value: string;
  detail: string;
  tone: 'neutral' | 'positive' | 'negative';
}

const MIN_TOTAL_CASH_HANDS = 1_000;
const MIN_SEGMENT_HANDS = 500;

function signed(value: number, digits = 1): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

export function buildStatsIntelligenceBrief(input: {
  overall: BriefOverall;
  positions?: BriefPosition[] | null;
  variants?: BriefVariant[] | null;
  daily?: BriefDailyPoint[] | null;
  /** Injectable so calendar-window claims are deterministic in tests. */
  asOf?: Date;
  /**
   * The page's analysis window in days (null = all time). The trend item
   * looks at the most recent 7 days OR the whole window when the window is
   * shorter than that - it used to be a fixed 7 UTC days regardless, so under
   * "7 Days" it was a double filter and it never said which.
   */
  windowDays?: number | null;
}): IntelligenceBriefItem[] {
  const { overall } = input;
  const positions = input.positions ?? [];
  const variants = input.variants ?? [];
  const daily = input.daily ?? [];
  const sampleHands = overall.cash_hands || overall.total_hands;
  const sampleValue =
    sampleHands < 1_000 ? 'Early Read' : sampleHands < 5_000 ? 'Developing' : 'Established';

  const sampleIsReliable = overall.cash_hands >= MIN_TOTAL_CASH_HANDS;
  const qualifiedPositions = positions
    .filter((row) => row.hands_played >= MIN_SEGMENT_HANDS && Number.isFinite(row.bb100))
    .sort((a, b) => b.bb100 - a.bb100);
  const bestPosition = qualifiedPositions[0];

  const qualifiedVariants = variants
    .filter((row) => row.hands >= MIN_SEGMENT_HANDS && Number.isFinite(row.bb100))
    .sort((a, b) => b.bb100 - a.bb100);
  const bestVariant = qualifiedVariants[0];

  const asOf = Number.isFinite(input.asOf?.getTime()) ? new Date(input.asOf as Date) : new Date();
  const end = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const trendDays =
    typeof input.windowDays === 'number' && input.windowDays > 0
      ? Math.min(7, input.windowDays)
      : 7;
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (trendDays - 1));
  const dayKey = (date: Date) => date.toISOString().slice(0, 10);
  const recent = daily.filter((row) => row.date >= dayKey(start) && row.date <= dayKey(end));
  const recentHands = recent.reduce(
    (sum, row) => sum + (Number.isFinite(row.hands) ? row.hands : 0),
    0
  );
  const recentProfit = recent.reduce(
    (sum, row) => sum + (Number.isFinite(row.profit) ? row.profit : 0),
    0
  );
  const trendValue =
    recent.length === 0
      ? 'No Recent Play'
      : recentProfit > 0
        ? 'Positive'
        : recentProfit < 0
          ? 'Negative'
          : 'Flat';

  const formatDay = (date: Date) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
      date
    );
  const recentRange = `${formatDay(start)} to ${formatDay(end)}`;

  return [
    {
      id: 'sample',
      label: 'Sample Confidence',
      value: sampleValue,
      detail: overall.cash_hands
        ? `${sampleHands.toLocaleString()} cash hands in this read.`
        : `${sampleHands.toLocaleString()} hands in this read, none of them cash.`,
      tone: 'neutral',
    },
    {
      id: 'position',
      label: 'Position Evidence',
      value: !sampleIsReliable ? 'Not Yet Reliable' : bestPosition?.position || 'Building Sample',
      detail: !sampleIsReliable
        ? `Needs ${MIN_TOTAL_CASH_HANDS.toLocaleString()} cash hands before ranking positions.`
        : bestPosition
          ? `${signed(bestPosition.bb100)} BB/100 across ${bestPosition.hands_played.toLocaleString()} hands.`
          : `Needs ${MIN_SEGMENT_HANDS.toLocaleString()} hands in one position.`,
      tone:
        !sampleIsReliable || !bestPosition
          ? 'neutral'
          : bestPosition.bb100 >= 0
            ? 'positive'
            : 'negative',
    },
    {
      id: 'game',
      label: 'Game Evidence',
      value: !sampleIsReliable
        ? 'Not Yet Reliable'
        : bestVariant?.variant
          ? bestVariant.variant.toUpperCase()
          : 'Building Sample',
      detail: !sampleIsReliable
        ? `Needs ${MIN_TOTAL_CASH_HANDS.toLocaleString()} cash hands before ranking games.`
        : bestVariant
          ? `${signed(bestVariant.bb100)} BB/100 across ${bestVariant.hands.toLocaleString()} hands.`
          : `Needs ${MIN_SEGMENT_HANDS.toLocaleString()} hands in one game.`,
      tone:
        !sampleIsReliable || !bestVariant
          ? 'neutral'
          : bestVariant.bb100 >= 0
            ? 'positive'
            : 'negative',
    },
    {
      id: 'trend',
      label: `Last ${trendDays} Day${trendDays === 1 ? '' : 's'} Direction`,
      value: trendValue,
      detail:
        recent.length > 0
          ? `${signed(recentProfit, 0)} across ${recentHands.toLocaleString()} hands, ${recentRange}.`
          : `No cash results recorded from ${recentRange}.`,
      tone: recentProfit > 0 ? 'positive' : recentProfit < 0 ? 'negative' : 'neutral',
    },
  ];
}
