/** Pure comparison, not a source authenticator. The accepted-source reader
 * calls this only after authenticating its parsed stack_result_text column.
 * Final stacks, payouts and net deltas never reconstruct missing deal funds. */
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const whole = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256;
export function tournamentOriginalFundingMatchesAccepted(
  originalSnapshot: unknown,
  stackResult: unknown
): boolean {
  try {
    if (!object(stackResult) || !object(originalSnapshot)) return false;
    const g = originalSnapshot.gameState,
      hero = originalSnapshot.player;
    if (!object(g) || !object(hero) || !object(g.tournament)) return false;
    const t = g.tournament,
      p = t.contextProvenance,
      tournamentId = t.tournamentId;
    if (!id(tournamentId)) return false;
    if (
      originalSnapshot.type !== 'DECIDE_FAST' ||
      g.gameMode !== 'tournament' ||
      t.tournamentId !== tournamentId ||
      stackResult.success !== true ||
      stackResult.tournament_id !== tournamentId ||
      !object(p) ||
      !object(p.projection)
    )
      return false;
    const projection = p.projection;
    if (
      !id(projection.tableId) ||
      !whole(projection.handNumber) ||
      projection.handNumber < 1 ||
      stackResult.table_id !== projection.tableId ||
      stackResult.hand_number !== projection.handNumber ||
      !object(stackResult.request)
    )
      return false;
    const request = stackResult.request;
    if (
      (Object.hasOwn(request, 'tournament_id') && request.tournament_id !== tournamentId) ||
      (Object.hasOwn(request, 'table_id') && request.table_id !== projection.tableId) ||
      (Object.hasOwn(request, 'hand_number') && request.hand_number !== projection.handNumber)
    )
      return false;
    if (
      !Array.isArray(request.stacks) ||
      request.stacks.length !== 2 ||
      !Array.isArray(g.players) ||
      g.players.length !== 2 ||
      !object(t.stackByUser) ||
      Object.keys(t.stackByUser).length !== 2 ||
      !Array.isArray(t.stacks) ||
      t.stacks.length !== 2 ||
      !id(hero.user_id) ||
      !whole(hero.stack) ||
      !whole(hero.totalInvested)
    )
      return false;
    const funds = new Map<string, number>();
    for (const row of request.stacks) {
      if (
        !object(row) ||
        !id(row.user_id) ||
        funds.has(row.user_id) ||
        !whole(row.stack_before) ||
        row.stack_before <= 0
      )
        return false;
      funds.set(row.user_id, row.stack_before);
    }
    const seen = new Set<string>();
    let total = 0;
    for (const player of g.players) {
      if (
        !object(player) ||
        !id(player.user_id) ||
        seen.has(player.user_id) ||
        !whole(player.stack) ||
        !whole(player.totalInvested)
      )
        return false;
      seen.add(player.user_id);
      const originalFunds = player.stack + player.totalInvested;
      if (
        !Number.isSafeInteger(originalFunds) ||
        funds.get(player.user_id) !== originalFunds ||
        !Object.hasOwn(t.stackByUser, player.user_id) ||
        t.stackByUser[player.user_id] !== originalFunds
      )
        return false;
      total += originalFunds;
    }
    const heroFunds = hero.stack + hero.totalInvested;
    if (
      !seen.has(hero.user_id) ||
      !Number.isSafeInteger(heroFunds) ||
      funds.get(hero.user_id) !== heroFunds ||
      !Number.isSafeInteger(total)
    )
      return false;
    const expected = [...funds.values()].sort((a, b) => a - b);
    if (t.stacks.some((n) => !whole(n) || n <= 0)) return false;
    const field = [...t.stacks].sort((a, b) => Number(a) - Number(b));
    return (
      field.every((n, i) => n === expected[i]) && expected.reduce((a, b) => a + b, 0) === total
    );
  } catch {
    return false;
  }
}
