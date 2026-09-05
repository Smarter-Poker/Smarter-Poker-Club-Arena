/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HORSE SESSION MEMORY - what a horse has lived through at this table
 *  2026-09-05
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "THE MOST IMPORTANT IS SITUATIONAL AWARENESS! WHICH THERE IS ALMOST
 * ZERO PROOF THAT IT EXISTS OR THAT THEY TRULY UNDERSTAND THAT THEY ARE
 * PLAYING LIVE AT THE TABLE."
 *
 * He was right about this one specifically. The horse brain knows a great deal
 * about the HAND in front of it - board texture, position, action history,
 * effective stacks, pot odds, and a genuine per-opponent model in `HorseMind`
 * carrying thousands of observed hands. What it knew about its own SESSION was
 * nothing at all. Grepping `HorseLogic.ts` for `session|tilt|pnl|handsPlayed`
 * returned exactly two lines, both inside `moodOf()`:
 *
 *     const key = userId + '|' + Math.floor(Date.now() / 3_600_000);
 *     return (h % 1000) / 1000; // 0..1, stable for the hour
 *
 * A hash of the wall clock. Deterministic, zero-mean across the fleet, and by
 * construction unrelated to anything that had actually happened to that horse.
 * A horse two hundred hands and three buy-ins into a session played exactly
 * like one that had sat down thirty seconds earlier, and nothing in the code
 * could tell the two apart.
 *
 * ── WHY THE ENGINE MEASURES IT RATHER THAN READING IT ─────────────────────
 *
 * `HorseDataLedger` forbids a database read at decision time, and rightly: the
 * decision runs inside the turn timer. Everything here is measured from the
 * engine's own hand boundaries, in memory, on the box that is already dealing
 * the cards.
 *
 * ── NET IS SUMMED ACROSS HANDS, WHICH IS WHY REBUYS DO NOT POLLUTE IT ─────
 *
 * The obvious implementation - remember the buy-in, subtract it from the
 * stack - is wrong the moment a horse rebuys or tops up, and would read a
 * rebuy as a catastrophic loss. So the net is accumulated as the sum of
 * (stack after hand - stack before hand) over the hands the horse played.
 * Chips added BETWEEN hands are invisible to that sum by construction, which
 * is exactly the property wanted, and it needs no cooperation from
 * `autoRebuyHorse` or any other funding path.
 *
 * ── HORSES ARE PLAYERS (CLAUDE.md 10.5) ──────────────────────────────────
 *
 * There is no `is_horse` in this file and there must never be one. It records
 * every seat at the table identically. A human's session is measured the same
 * way, and if a human-facing surface ever wants to show "you have played 214
 * hands at this table", the number is already here and already correct.
 */

export interface SessionRead {
  /** Hands this seat has been dealt into at this table, this engine. */
  handsHere: number;
  /** Whole minutes since the engine first saw this seat. */
  minutesSeated: number;
  /** Net chips across those hands. Rebuys are excluded by construction. */
  netChips: number;
  /** The same net in big blinds, which is what the brain reasons in. */
  netBB: number;
  /**
   * Is this a session long enough for the table to have a READ on this horse?
   *
   * Thirty hands is roughly three orbits nine-handed - about where `HorseMind`
   * itself starts trusting an opponent profile (its own gate is ten hands for
   * a basic read, and eight faced-aggression spots for a fold-rate read). A
   * horse past this point is being modelled by anybody at the table who is
   * paying attention, and should assume its own patterns are visible.
   */
  hasTableImage: boolean;
}

const EMPTY: SessionRead = {
  handsHere: 0,
  minutesSeated: 0,
  netChips: 0,
  netBB: 0,
  hasTableImage: false,
};

/** See SessionRead.hasTableImage. */
export const TABLE_IMAGE_HANDS = 30;

interface SeatSession {
  firstSeenMs: number;
  hands: number;
  netChips: number;
  /** Stack at the start of the hand in progress, if one is in progress. */
  openingStack: number | null;
}

/** tableId -> userId -> session */
type Book = Map<string, Map<string, SeatSession>>;

class HorseSessionMemoryImpl {
  private book: Book = new Map();

  private seatsFor(tableId: string): Map<string, SeatSession> {
    let m = this.book.get(tableId);
    if (!m) {
      m = new Map();
      this.book.set(tableId, m);
    }
    return m;
  }

  /**
   * Called as a hand is dealt, with every seat that is in it.
   *
   * A seat seen for the first time starts its clock HERE rather than at
   * whatever moment the row appeared in the database: the engine is the thing
   * that knows a player is playing, and a seat that sat down during a hand it
   * was not dealt into has not started a session yet.
   */
  noteHandStart(tableId: string, seats: ReadonlyArray<{ user_id: string; stack: number }>): void {
    const now = Date.now();
    const m = this.seatsFor(tableId);
    for (const s of seats) {
      if (!s?.user_id) continue;
      const cur = m.get(s.user_id);
      if (cur) {
        cur.openingStack = Number(s.stack) || 0;
      } else {
        m.set(s.user_id, {
          firstSeenMs: now,
          hands: 0,
          netChips: 0,
          openingStack: Number(s.stack) || 0,
        });
      }
    }
  }

  /** Called when the hand completes, with the final stacks. */
  noteHandEnd(tableId: string, seats: ReadonlyArray<{ user_id: string; stack: number }>): void {
    const m = this.book.get(tableId);
    if (!m) return;
    for (const s of seats) {
      if (!s?.user_id) continue;
      const cur = m.get(s.user_id);
      /* No opening stack means this seat was not in the hand we are closing -
         it sat down mid-hand, or the engine was rebuilt between the deal and
         the settle. Counting it would invent a net out of a stack difference
         nobody played for. */
      if (!cur || cur.openingStack === null) continue;
      cur.netChips += (Number(s.stack) || 0) - cur.openingStack;
      cur.hands += 1;
      cur.openingStack = null;
    }
  }

  /** What this seat has lived through. Never throws, never blocks. */
  read(tableId: string, userId: string, bigBlind: number): SessionRead {
    const cur = this.book.get(tableId)?.get(userId);
    if (!cur) return EMPTY;
    const bb = Number(bigBlind) > 0 ? Number(bigBlind) : 1;
    return {
      handsHere: cur.hands,
      minutesSeated: Math.max(0, Math.floor((Date.now() - cur.firstSeenMs) / 60_000)),
      netChips: cur.netChips,
      netBB: cur.netChips / bb,
      hasTableImage: cur.hands >= TABLE_IMAGE_HANDS,
    };
  }

  /** A seat that leaves forgets its session; sitting back down starts a new one. */
  forgetSeat(tableId: string, userId: string): void {
    this.book.get(tableId)?.delete(userId);
  }

  /** A table that closes forgets everybody. Keeps the map from growing forever. */
  forgetTable(tableId: string): void {
    this.book.delete(tableId);
  }

  /** For tests. */
  reset(): void {
    this.book.clear();
  }

  /** For the liveness probe: how many seats are being tracked right now. */
  size(): number {
    let n = 0;
    for (const m of this.book.values()) n += m.size;
    return n;
  }
}

export const horseSessionMemory = new HorseSessionMemoryImpl();
