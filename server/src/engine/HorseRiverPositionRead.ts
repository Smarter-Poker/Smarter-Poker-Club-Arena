/** Public completed-hand actions only. A participant count from the original
 * observer context is mandatory: an incomplete action population is unknown,
 * never evidence that the next bettor acted last. No holding is inspected. */
export interface RiverPositionCount {
  opportunities: number;
  bets: number;
}
interface PublicAction {
  userId?: unknown;
  stage?: unknown;
  action?: unknown;
  amount?: unknown;
}
const voluntary = new Set(['fold', 'check', 'call', 'bet', 'raise', 'all_in']);
const order: Record<string, number> = { preflop: 0, flop: 1, turn: 2, river: 3 };
export function riverPositionIncrements(
  actions: readonly PublicAction[] | undefined,
  dealtCount: unknown
): Map<string, RiverPositionCount> {
  const empty = () => new Map<string, RiverPositionCount>();
  if (
    !Array.isArray(actions) ||
    actions.length > 4096 ||
    !Number.isInteger(dealtCount) ||
    Number(dealtCount) < 2 ||
    Number(dealtCount) > 10
  )
    return empty();
  const known = new Set<string>();
  for (const a of actions) {
    if (!a || !voluntary.has(String(a.action))) continue;
    if (
      typeof a.userId !== 'string' ||
      !a.userId.length ||
      a.userId.length > 256 ||
      typeof a.stage !== 'string' ||
      order[a.stage] === undefined
    )
      return empty();
    known.add(a.userId);
  }
  if (known.size !== dealtCount) return empty();
  const active = new Set(known),
    checked = new Set<string>(),
    out = empty();
  let stage = -1,
    riverBet = false;
  for (const a of actions) {
    if (!a || !voluntary.has(String(a.action))) continue;
    const id = a.userId as string,
      s = order[a.stage as string],
      action = a.action as string;
    if (s < stage || !active.has(id)) return empty();
    stage = s;
    if (s === 3 && !riverBet) {
      if (action !== 'check' && action !== 'bet' && action !== 'all_in') return empty();
      if (checked.has(id)) return empty();
      const others = [...active].filter((x) => x !== id);
      const bet = action === 'bet' || action === 'all_in';
      if (bet && (typeof a.amount !== 'number' || !Number.isFinite(a.amount) || a.amount <= 0))
        return empty();
      if (others.length > 0 && others.every((x) => checked.has(x)))
        out.set(id, { opportunities: 1, bets: bet ? 1 : 0 });
      if (bet) riverBet = true;
      else checked.add(id);
    }
    if (action === 'fold' || action === 'all_in') active.delete(id);
  }
  return out;
}
