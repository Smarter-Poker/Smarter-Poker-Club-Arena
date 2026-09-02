/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHO ACTUALLY MADE THE KNOCKOUT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan section 29, stated exactly: the credit for an elimination belongs to the
 * winner(s) of THE POT THAT CONTAINED THE ELIMINATED PLAYER'S FINAL TOURNAMENT
 * CHIPS. Not to whoever won the most money in the hand.
 *
 * WHAT THIS REPLACES. The elimination sweep used to read the last ten
 * `hand_history` rows, find one the busted player appeared in, sort
 * `hand.winners` by `Number(w.amount)` descending, and take `[0]`. That answer
 * is correct only when the hand had one pot. With a side pot it is wrong in the
 * most expensive possible direction:
 *
 *     Short stack is all in for 300. Two deep stacks build a 12,000 side pot.
 *     Player A wins the 900 main pot — the pot the short stack's last chips
 *     were in, so A made the knockout. Player B wins the 12,000 side pot and,
 *     under `sort by amount desc`, took the bounty as well.
 *
 * In a mystery event that hands an entire chest to a player who was never in
 * the pot that busted anybody.
 *
 * WHY IT WAS WRONG RATHER THAN LAZY. The engine has always had the answer and
 * always thrown it away. `calculatePots()` returns `{ amount, eligiblePlayers }`
 * per pot; every Winner carries the `potIndex` it came from
 * (ServerTableEngineHandEvents, `events.ts` PotAwarded); `ServerTableEngine`
 * even serialises the pots onto the wire as `{ amount, eligible }`. None of it
 * was ever persisted, and the eliminations layer reconstructs a knockout from
 * `hand_history` and nothing else — so it could not see any of it. The
 * `hand_history.pots` column (migration 20260825520000) is what closes that
 * gap, and this module is what reads it.
 *
 * THE RULE, in full:
 *
 *   1. The busted player's last chips are in the LAST pot they were eligible
 *      for — the highest pot index whose `eligible` list contains them. (Not
 *      the main pot, and not the biggest: a player all in on the turn for a
 *      larger amount than an earlier all-in is eligible for pot 1 but not
 *      pot 2.)
 *   2. The winner(s) of that pot get the credit.
 *   3. A tied pot means every tied winner shares it — EQUAL weights, one chest
 *      split between them (sections 27/28). Equal, not proportional to what
 *      they took out of the pot: a chopped pot pays each of them the same, and
 *      each of them did the identical amount of knocking out.
 *   4. If that pot has no recorded winner other than the busted player, walk
 *      DOWN the pot indices — an unreadable side-pot settlement should still
 *      credit the main pot rather than credit nobody.
 *   5. No pots on the row at all (every hand written before 2026-08-25) falls
 *      back to the old largest-winner heuristic, unchanged. Two million
 *      historical rows must keep behaving exactly as they do today.
 *
 * NOTHING HERE TOUCHES MONEY. It returns who has a claim and how big each
 * claim is; the split arithmetic lives in `fn_mystery_bounty_reserve`, which is
 * the only thing that knows what the chest is worth (section 19).
 */

/** One pot as persisted on `hand_history.pots`. */
export interface StoredPot {
  /** Pot order, 0 = main. Optional: array position is used when absent. */
  index?: number | null;
  amount?: number | null;
  /** User ids entitled to contest this pot. */
  eligible?: readonly string[] | null;
  /** Tolerated alias — the engine's in-memory Pot names it `eligiblePlayers`. */
  eligiblePlayers?: readonly string[] | null;
}

/** One winner as persisted on `hand_history.winners`. */
export interface StoredWinner {
  userId?: string | null;
  user_id?: string | null;
  amount?: number | string | null;
  potIndex?: number | null;
  pot_index?: number | null;
}

export interface KnockoutClaimant {
  readonly userId: string;
  /** Weight handed to `fn_mystery_bounty_reserve`. Equal across tied winners. */
  readonly weight: number;
}

export interface KnockoutAttribution {
  /** The single player credited with the knockout, or null when unknowable. */
  readonly knockerUserId: string | null;
  /** Everyone with a claim, including the knocker. Empty when unknowable. */
  readonly claimants: KnockoutClaimant[];
  /**
   * How the answer was reached. Surfaced so the engine can log it and so the
   * tests can prove which branch ran rather than only that the ids match.
   *
   *   'pot'             the pot holding the busted player's last chips
   *   'pot_fallback'    a lower pot, because that one had no usable winner
   *   'largest_winner'  the legacy heuristic (row predates the pots column)
   *   'none'            nothing attributable
   */
  readonly basis: 'pot' | 'pot_fallback' | 'largest_winner' | 'none';
  /** Which pot index the credit came from. Null unless basis is pot-based. */
  readonly potIndex: number | null;
}

const NONE: KnockoutAttribution = {
  knockerUserId: null,
  claimants: [],
  basis: 'none',
  potIndex: null,
};

function idOf(w: StoredWinner | null | undefined): string {
  return String(w?.userId ?? w?.user_id ?? '').trim();
}

function potIndexOf(w: StoredWinner | null | undefined): number {
  const raw = w?.potIndex ?? w?.pot_index;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function eligibleOf(p: StoredPot | null | undefined): string[] {
  const list = p?.eligible ?? p?.eligiblePlayers ?? [];
  return Array.isArray(list) ? list.map((u) => String(u ?? '').trim()).filter(Boolean) : [];
}

/**
 * The highest pot index the eliminated player was eligible for, or -1.
 *
 * `index` is preferred over array position because a future writer could store
 * a sparse or reordered array; position is the fallback so a hand written
 * without indices still resolves.
 */
export function lastPotForPlayer(
  pots: readonly StoredPot[] | null | undefined,
  eliminatedUserId: string
): number {
  if (!Array.isArray(pots) || pots.length === 0) return -1;
  const target = String(eliminatedUserId ?? '').trim();
  if (!target) return -1;

  let best = -1;
  pots.forEach((pot, position) => {
    if (!eligibleOf(pot).includes(target)) return;
    const declared = Number(pot?.index);
    const idx = Number.isFinite(declared) && declared >= 0 ? Math.floor(declared) : position;
    if (idx > best) best = idx;
  });
  return best;
}

/**
 * Winners of one pot, excluding the eliminated player themselves.
 *
 * A busted player CAN appear in `winners` for the pot that busted them — they
 * can win a side pot they were eligible for and still lose their stack in the
 * main. They are never their own knocker, so they are filtered here rather
 * than at the call site, where forgetting it would credit a bounty to the
 * player it was drawn for.
 */
function winnersOfPot(
  winners: readonly StoredWinner[],
  potIndex: number,
  eliminatedUserId: string
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of winners) {
    if (potIndexOf(w) !== potIndex) continue;
    const id = idOf(w);
    if (!id || id === eliminatedUserId) continue;
    // A winner may legitimately appear twice for one pot (a hi-lo split pays
    // the same player both halves). One claim each.
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * THE LEGACY HEURISTIC, kept verbatim in behaviour and quarantined here.
 *
 * Used only for hands whose row has no `pots` — i.e. everything written before
 * the column existed. Weight is the amount won, exactly as the pre-2026-08-25
 * code passed it, so a re-sweep of an old tournament splits a chest the same
 * way it would have then.
 */
function attributeByLargestWinner(
  winners: readonly StoredWinner[],
  eliminatedUserId: string
): KnockoutAttribution {
  const candidates = winners
    .filter((w) => idOf(w) && idOf(w) !== eliminatedUserId)
    .sort((a, b) => Number(b?.amount ?? 0) - Number(a?.amount ?? 0));
  if (candidates.length === 0) return NONE;

  const merged = new Map<string, number>();
  for (const w of candidates) {
    const id = idOf(w);
    merged.set(id, (merged.get(id) ?? 0) + Math.max(0, Number(w?.amount) || 0));
  }
  return {
    knockerUserId: idOf(candidates[0]),
    claimants: Array.from(merged, ([userId, weight]) => ({ userId, weight })),
    basis: 'largest_winner',
    potIndex: null,
  };
}

/**
 * Attribute one elimination to the winner(s) of the pot that held the busted
 * player's last chips.
 *
 * @param hand           the stored `hand_history` row (only `winners` + `pots`
 *                       are read; passing the whole row is deliberate so the
 *                       caller does not have to know which fields matter)
 * @param eliminatedUserId who busted
 */
export function attributeKnockout(
  hand: { winners?: unknown; pots?: unknown } | null | undefined,
  eliminatedUserId: string
): KnockoutAttribution {
  const target = String(eliminatedUserId ?? '').trim();
  if (!target) return NONE;

  const winners: StoredWinner[] = Array.isArray(hand?.winners)
    ? (hand!.winners as StoredWinner[])
    : [];
  if (winners.length === 0) return NONE;

  const pots: StoredPot[] = Array.isArray(hand?.pots) ? (hand!.pots as StoredPot[]) : [];
  const lastPot = lastPotForPlayer(pots, target);

  // No pot record for this hand (or the busted player is not in any of them —
  // a corrupted row, or a player who was already all in for dead money before
  // the snapshot). Old rule, unchanged.
  if (lastPot < 0) return attributeByLargestWinner(winners, target);

  for (let idx = lastPot; idx >= 0; idx--) {
    const ids = winnersOfPot(winners, idx, target);
    if (ids.length === 0) continue;
    return {
      knockerUserId: ids[0],
      // SECTION 27/28: a tied pot is shared EQUALLY. One chest, split between
      // everyone who won the pot that made the knockout. Weight 1 apiece is
      // what makes `fn_mystery_bounty_reserve`'s largest-remainder split come
      // out even, and it is also what a chopped pot means: neither of them
      // knocked the player out any harder than the other.
      claimants: ids.map((userId) => ({ userId, weight: 1 })),
      basis: idx === lastPot ? 'pot' : 'pot_fallback',
      potIndex: idx,
    };
  }

  // Every pot the busted player was in was won by the busted player, or by
  // nobody the row records. Rather than strand the knockout, fall back — a
  // bounty with an imperfect owner beats a chest that is never awarded and
  // leaves the event unable to reconcile.
  return attributeByLargestWinner(winners, target);
}
