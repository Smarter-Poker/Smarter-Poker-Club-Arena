interface PublicActionCounts {
  aggressive: number;
  calls: number;
}

/** One pass over accepted public actions; checks and all-in calls are not raises. */
function publicActionCounts(
  actions: ReadonlyArray<Record<string, unknown>> | undefined,
  bigBlind: number | undefined
): Map<string, PublicActionCounts> | null {
  if (!actions?.length) return null;
  const levels = new Map<string, number>();
  const counts = new Map<string, PublicActionCounts>();
  for (const a of actions) {
    const action = typeof a.action === 'string' ? a.action.toLowerCase() : '';
    const actor = a.userId ?? a.user_id;
    const stage = typeof a.stage === 'string' ? a.stage.toLowerCase() : '';
    const amount = Number(a.amount);
    if (typeof actor === 'string' && actor && !counts.has(actor))
      counts.set(actor, { aggressive: 0, calls: 0 });
    const mine = typeof actor === 'string' ? counts.get(actor) : undefined;
    const level = levels.get(stage) ?? (stage === 'preflop' ? Math.max(0, bigBlind ?? 0) : 0);
    const voluntary = a.origin !== 'forced' && a.dead !== true;
    if (
      ['bet', 'raise', 'all_in', 'allin'].includes(action) &&
      (!stage || !Number.isFinite(amount) || amount <= 0)
    )
      return null;
    if (mine && voluntary) {
      if (action === 'call' || (['all_in', 'allin'].includes(action) && amount <= level))
        mine.calls++;
      else if (['bet', 'raise', 'all_in', 'allin'].includes(action) && amount > level)
        mine.aggressive++;
    }
    if (
      a.dead !== true &&
      [
        'bet',
        'raise',
        'all_in',
        'allin',
        'sb',
        'bb',
        'post_sb',
        'post_bb',
        'small_blind',
        'big_blind',
        'straddle',
        'kill_blind',
      ].includes(action) &&
      Number.isFinite(amount)
    )
      levels.set(stage, Math.max(level, amount));
  }
  return counts;
}

/** Public tendencies are released only for a committed hand, never private cards. */
export function publicHandStatsFrame(input: {
  tableId: string;
  handNumber: number;
  handId: string;
  facts: ReadonlyArray<Record<string, unknown>> | null | undefined;
  timestamp: number;
  actions?: ReadonlyArray<Record<string, unknown>>;
  bigBlind?: number;
}): Record<string, unknown> | null {
  if (!input.handId || !input.facts?.length || input.facts.length > 10) return null;
  const counts = publicActionCounts(input.actions, input.bigBlind);
  const ids = new Set<string>();
  const players: Array<{
    user_id: string;
    vpip: boolean;
    pfr: boolean;
    won: boolean;
    aggressive_actions?: number;
    call_actions?: number;
  }> = [];
  for (const fact of input.facts) {
    if (
      fact.hand_id !== input.handId ||
      typeof fact.user_id !== 'string' ||
      !fact.user_id ||
      ids.has(fact.user_id) ||
      typeof fact.vpip !== 'boolean' ||
      typeof fact.pfr !== 'boolean' ||
      (fact.pfr && !fact.vpip) ||
      typeof fact.returned !== 'number' ||
      !Number.isFinite(fact.returned)
    )
      return null;
    ids.add(fact.user_id);
    const actionCounts = counts?.get(fact.user_id);
    players.push({
      user_id: fact.user_id,
      vpip: fact.vpip,
      pfr: fact.pfr,
      won: fact.returned > 0,
      ...(actionCounts
        ? { aggressive_actions: actionCounts.aggressive, call_actions: actionCounts.calls }
        : {}),
    });
  }
  return {
    type: 'hand_public_stats',
    table_id: input.tableId,
    hand_number: input.handNumber,
    hand_id: input.handId,
    public_stats_version: 1,
    players,
    timestamp: input.timestamp,
  };
}
