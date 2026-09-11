/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SWEEP ORDERS A BUST BY THE GENERATION THE DOOR WILL BIND (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The elimination sweep hands out finishing places in the order busts
 * happened, and it read that order from `tournament_knockout_candidates`. It
 * kept the EARLIEST pending hand per player (`hand < seen`). The knockout door,
 * `fn_eliminate_tournament_player_atomic`, binds the LATEST generation
 * (`fn_ca_latest_committed_knockout_candidate`, highest hand number, then id)
 * and records that one.
 *
 * The two only disagree when a player holds more than one pending generation,
 * and that is exactly the case that happened: the 2026-09-08/09 rebuy chain
 * left an orphaned 'pending' row behind every player it bought back in. In
 * 798866ae hawk_82's orphan is hand 8550341 (09-09 05:27) and the bust the door
 * records is hand 9166239 (09-10 15:02), so the sweep ranked a bust from
 * 09-10 as though it came before SlyAnteDoc's (hand 8584595, 09-09 06:38) and
 * handed hawk_82 the WORSE of the two places. Ordering and recording must read
 * the same row, or the ladder is built from one generation and paid on another.
 *
 * So this binds the latest candidate of each player, whatever its state, and
 * orders by it only when it is `pending` - the one state in which the door will
 * record it. A player whose latest generation is anything else, or whose rows
 * cannot all be read, gets no entry: the sweep already treats a missing entry
 * as UNKNOWN and sorts it last, and a guess is never allowed to take a place.
 */

/** One `tournament_knockout_candidates` row as PostgREST returns it. */
export interface KnockoutCandidateOrderRow {
  id?: unknown;
  eliminated_user_id?: unknown;
  hand_number?: unknown;
  stack_before?: unknown;
  state?: unknown;
}

/** The generation a player's bust will be recorded under. */
export interface BoundBust {
  /** Global accepted-hand number: the primary witness of bust order. */
  handNumber: number;
  /** The player's stack at the start of that hand: a same-hand tiebreak. */
  stackBefore: number;
}

interface Latest {
  hand: number;
  id: string;
  stackBefore: number;
  pending: boolean;
}

/**
 * For every player in `rows`, the knockout generation the door will bind: the
 * latest by hand number, then id. Returns an entry only for players whose
 * latest generation is still `pending`.
 */
export function bindLatestKnockoutCandidates(
  rows: readonly KnockoutCandidateOrderRow[]
): Map<string, BoundBust> {
  const latest = new Map<string, Latest>();
  const unreadable = new Set<string>();
  for (const row of rows) {
    const uid = typeof row.eliminated_user_id === 'string' ? row.eliminated_user_id : '';
    if (!uid) continue;
    const hand = Number(row.hand_number);
    const stackBefore = Number(row.stack_before);
    if (
      row.hand_number === null ||
      row.hand_number === undefined ||
      !Number.isFinite(hand) ||
      row.stack_before === null ||
      row.stack_before === undefined ||
      !Number.isFinite(stackBefore)
    ) {
      // One unreadable generation means the latest one is not known.
      unreadable.add(uid);
      continue;
    }
    const id = typeof row.id === 'string' ? row.id : '';
    const seen = latest.get(uid);
    if (seen === undefined || hand > seen.hand || (hand === seen.hand && id > seen.id)) {
      latest.set(uid, { hand, id, stackBefore, pending: row.state === 'pending' });
    }
  }
  const bound = new Map<string, BoundBust>();
  for (const [uid, generation] of latest) {
    if (!generation.pending || unreadable.has(uid)) continue;
    bound.set(uid, { handNumber: generation.hand, stackBefore: generation.stackBefore });
  }
  return bound;
}
