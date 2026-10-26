/** A high-hand name cannot describe the value of a split or multi-board call. */
export interface RiverCallContext {
  variant: string;
  boardCount: number;
}
export interface RiverCallSample {
  userId: string;
  weak: boolean;
}

type PublicAction = { userId?: string; action: string; stage: string; amount?: number };
const weakNames = new Set(['high card', 'pair', 'one pair']);
const strongNames = new Set([
  'two pair',
  'three of a kind',
  'straight',
  'flush',
  'full house',
  'four of a kind',
  'straight flush',
  'royal flush',
]);

export function finalRiverCallers(actions: readonly PublicAction[]): Set<string> {
  let level = 0;
  const last = new Map<string, boolean>();
  for (const a of actions) {
    if (
      a.stage !== 'river' ||
      !a.userId ||
      !['fold', 'check', 'bet', 'call', 'raise', 'all_in'].includes(a.action)
    )
      continue;
    const amount = Number.isFinite(a.amount) ? a.amount! : 0;
    last.set(
      a.userId,
      a.action === 'call' ||
        (a.action === 'all_in' &&
          typeof a.amount === 'number' &&
          Number.isFinite(a.amount) &&
          a.amount >= 0 &&
          level > 0 &&
          amount <= level + 0.005)
    );
    if (['bet', 'raise', 'all_in'].includes(a.action)) level = Math.max(level, amount);
  }
  return new Set([...last].filter(([, called]) => called).map(([id]) => id));
}

/** Emit only public category evidence, never names, descriptions or cards. */
export function shownRiverCallSamples(
  actions: readonly PublicAction[],
  showdown: unknown,
  context: RiverCallContext
): RiverCallSample[] {
  if (!riverCallCategoryIsUsable(context) || !Array.isArray(showdown)) return [];
  const callers = finalRiverCallers(actions);
  const samples = new Map<string, RiverCallSample>();
  for (const row of showdown) {
    if (
      !row ||
      typeof row !== 'object' ||
      row.mucked !== false ||
      typeof row.user_id !== 'string' ||
      !callers.has(row.user_id) ||
      typeof row.hand_name !== 'string'
    )
      continue;
    const category = row.hand_name.toLowerCase();
    if (weakNames.has(category) || strongNames.has(category))
      samples.set(row.user_id, { userId: row.user_id, weak: weakNames.has(category) });
  }
  return [...samples.values()];
}

export function riverCallCategoryIsUsable(context: RiverCallContext | undefined): boolean {
  return (
    !!context &&
    context.boardCount === 1 &&
    ['nlh', 'flh', 'pineapple', 'plo4', 'plo5', 'plo6', 'short_deck'].includes(context.variant)
  );
}

/** Conservative family baselines; see the measured sample in the changelog.
 * The one-sided Wilson lower bound must exceed the baseline, with at least
 * twelve shown calls. A raw 50% cutoff after five calls confuses ordinary
 * hold'em calls with an opponent-specific tendency. No hypothesis is made
 * about unobserved/mucked holdings or unsupported games. */
export function riverCallConfidenceAboveBaseline(
  calls: number,
  weak: number,
  baseline: number
): boolean {
  if (
    !Number.isFinite(calls) ||
    !Number.isFinite(weak) ||
    calls < 12 ||
    weak < 0 ||
    weak > calls ||
    !Number.isFinite(baseline) ||
    baseline < 0 ||
    baseline >= 1
  )
    return false;
  const z2 = 1.645 ** 2;
  const rate = weak / calls;
  const lower =
    (rate +
      z2 / (2 * calls) -
      Math.sqrt(z2 * ((rate * (1 - rate)) / calls + z2 / (4 * calls * calls)))) /
    (1 + z2 / calls);
  return lower > baseline;
}
