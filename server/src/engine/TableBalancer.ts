import { headsUpButtonSeat } from './headsUpButton.js';
import { reportError } from '../services/errorReporter.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE BALANCER — MTT Table Balancing Optimizer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Optimizes player distribution across tournament tables:
 * - Minimize max-min player count gap across tables
 * - Generate optimal move list with minimum total moves
 * - Respect seat-availability constraints
 * - Called by TournamentEngine after each elimination
 *
 * Ported from client: src/engine/TableBalancer.ts (239 lines)
 * Server adaptation: No masterBus — uses optional onEvent callback. Class export, not singleton.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BalancerTable {
  tableId: string;
  playerCount: number;
  maxSeats: number;
  players: BalancerPlayer[];
  /**
   * B6: the current button (dealer) seat, when known. Lets the balancer move
   * the player who is big blind due next (standard tournament rule) instead of
   * the smallest stack. Omit / 0 to fall back to the stack-based heuristic.
   */
  buttonSeat?: number;
  /** Actual prior natural BB required for an online heads-up projection. */
  lastBigBlindSeat?: number;
  /**
   * 2026-09-12: chairs this table's tournament roster still holds that have no
   * live seat row. An unrecorded bust keeps its `tournament_players` chair
   * until the elimination sweep records it, and `fn_move_tournament_player`
   * refuses a destination whose roster row is still `registered`/`playing`
   * there ('tournament move destination roster is occupied'). Measured on
   * event 05e104c7: 294 of 378 planned chairs were refused for exactly this
   * reason, and only 42 of 378 were genuinely free.
   *
   * Treated as occupied when a destination chair is chosen. The blind-cycle
   * arithmetic still runs off the live `players` ring alone, so a reserved
   * chair removes a candidate without distorting anybody's hops-to-big-blind.
   */
  reservedSeats?: number[];
}

export interface BalancerPlayer {
  userId: string;
  stack: number;
  seat: number;
}

export interface MoveInstruction {
  playerId: string;
  fromTableId: string;
  fromSeat: number;
  toTableId: string;
  toSeat: number;
  reason: string;
}

/**
 * B2 2026-08-27: where a seat sits in the blind cycle.
 *
 * `hops` is the number of hands until the seat posts the big blind, counted
 * clockwise from the seat that is the big blind RIGHT NOW. hops = 1 means "big
 * blind on the very next hand" (no free hands); hops = n means "just posted it"
 * (a full orbit of free hands ahead). Smaller is sooner.
 */
interface SeatChoice {
  seat: number;
  /** Hops-to-big-blind of the chosen seat, or null when the blind order is unknown. */
  hops: number | null;
}

export interface BalanceScore {
  score: number; // 0 = perfect, higher = worse
  maxPlayers: number;
  minPlayers: number;
  gap: number;
  avgPlayers: number;
}

export type TableBalancerEventType = 'TABLE_BALANCE_EXECUTED';

export interface TableBalancerEvent {
  type: TableBalancerEventType;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// B6 — BIG-BLIND-DUE-NEXT MOVE ORDERING (pure, unit-tested)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Order a table's players by who should be moved FIRST under the standard
 * tournament rule: move the player who is big blind due next. Blinds progress
 * clockwise, so after the current hand the button advances to the current small
 * blind, and the big blind advances one occupied seat. The player who would
 * post the NEXT big blind (the occupied seat immediately clockwise after the
 * current big blind) has "waited longest" and is moved first; the player who
 * just posted the big blind is moved last (they'd otherwise pay twice).
 *
 * Returns null when the button seat is unknown/invalid or the table has fewer
 * than 3 players (no meaningful blind order — e.g. heads-up), signalling the
 * caller to fall back to its stack-based heuristic.
 */
export function orderPlayersForMove(
  players: BalancerPlayer[],
  buttonSeat: number | undefined
): BalancerPlayer[] | null {
  if (!buttonSeat || buttonSeat <= 0) return null;
  if (players.length < 3) return null;

  const bySeat = new Map(players.map((p) => [p.seat, p]));
  const occupied = players.map((p) => p.seat).sort((a, b) => a - b);
  if (!bySeat.has(buttonSeat)) return null; // button seat not occupied — bail

  // Clockwise occupied seats starting STRICTLY after `startSeat`, wrapping,
  // length === occupied.length (ends back at startSeat).
  const clockwiseAfter = (startSeat: number): number[] => {
    const idx = occupied.indexOf(startSeat);
    const n = occupied.length;
    const out: number[] = [];
    for (let i = 1; i <= n; i++) out.push(occupied[(idx + i) % n]);
    return out;
  };

  // Current SB = first occupied after button; current BB = the one after that.
  const afterButton = clockwiseAfter(buttonSeat); // [SB, BB, ...]
  const bbSeat = afterButton[1];

  // Move order = clockwise starting at the seat after the current BB. That seat
  // is "big blind due next"; the current BB lands last.
  const moveOrderSeats = clockwiseAfter(bbSeat);
  return moveOrderSeats.map((seat) => bySeat.get(seat)!).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════════
// B2 — BLIND GEOMETRY (pure, unit-tested)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The seat that is the big blind on the hand just dealt, given the button.
 *
 * Blinds run clockwise over OCCUPIED seats: button -> small blind -> big blind.
 * Returns null when the order is not meaningful (button unknown, fewer than 3
 * occupied seats — heads-up inverts the button/blind relationship and a table
 * that small is the final table, not a balancing problem).
 *
 * A button seat that is no longer occupied is tolerated — the player on the
 * button busting is the single most common reason a rebalance is running at
 * all — by taking the next occupied seat clockwise as the effective button,
 * which is what the engine's own rotation does.
 */
export function currentBigBlindSeat(
  occupiedSeats: readonly number[],
  buttonSeat: number | undefined
): number | null {
  if (!buttonSeat || buttonSeat <= 0) return null;
  const seats = Array.from(new Set(occupiedSeats)).sort((a, b) => a - b);
  if (seats.length < 3) return null;

  let btnIdx = seats.indexOf(buttonSeat);
  if (btnIdx < 0) {
    // Button seat vacated: effective button is the next occupied seat clockwise.
    const next = seats.findIndex((s) => s > buttonSeat);
    btnIdx = next >= 0 ? next : 0;
    // That seat is the button for the NEXT hand, so it is one step ahead of the
    // button the blinds were posted against; step back one to keep the answer
    // "the big blind of the hand just dealt".
    btnIdx = (btnIdx - 1 + seats.length) % seats.length;
  }
  return seats[(btnIdx + 2) % seats.length];
}

/**
 * How many hands until `seat` posts the big blind, counting clockwise from
 * `bbSeat` (the current big blind) over `ringSeats` PLUS `seat` itself — a seat
 * that is about to be filled joins the rotation, so it has to be in the ring
 * for the count to be right.
 *
 * 1 = big blind on the next hand (no free hands). n = a full orbit away, which
 * is what an arrival gets when it drops into the seat the blinds have only just
 * passed. That is the "free orbit" this whole exercise exists to prevent.
 */
export function hopsToBigBlind(ringSeats: readonly number[], bbSeat: number, seat: number): number {
  const seats = Array.from(new Set([...ringSeats, seat])).sort((a, b) => a - b);
  const n = seats.length;
  const b = seats.indexOf(bbSeat);
  const s = seats.indexOf(seat);
  if (b < 0 || s < 0 || n === 0) return n;
  const d = (s - b + n) % n;
  // d === 0 means the candidate IS taking the current big blind's seat (it went
  // empty when that player busted). The blinds have already moved past it, so
  // that is the longest possible wait, not the shortest.
  return d === 0 ? n : d;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TABLE BALANCER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class TableBalancer {
  planOnlineBalance(
    tables: readonly BalancerTable[],
    profile: OnlineGeometryProfile
  ): OnlineGeometryResult {
    return planOnlineGeometry(tables, profile);
  }

  private onEvent?: (event: TableBalancerEvent) => void;

  constructor(onEvent?: (event: TableBalancerEvent) => void) {
    this.onEvent = onEvent;
  }

  /**
   * Calculate balance score for current table distribution.
   * Score 0 = perfectly balanced.
   */
  evaluateBalance(tables: BalancerTable[]): BalanceScore {
    if (tables.length <= 1) {
      return {
        score: 0,
        maxPlayers: tables[0]?.playerCount || 0,
        minPlayers: tables[0]?.playerCount || 0,
        gap: 0,
        avgPlayers: tables[0]?.playerCount || 0,
      };
    }

    const counts = tables.map((t) => t.playerCount);
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    const avg = counts.reduce((s, c) => s + c, 0) / counts.length;
    const gap = max - min;

    // Score = sum of squared deviations from ideal
    const ideal = avg;
    const score = counts.reduce((s, c) => s + Math.pow(c - ideal, 2), 0);

    return {
      score: Math.round(score * 100) / 100,
      maxPlayers: max,
      minPlayers: min,
      gap,
      avgPlayers: Math.round(avg * 10) / 10,
    };
  }

  /**
   * Should we rebalance? Triggered when gap > 1 player.
   * Standard poker tournament rule: tables should differ by at most 1 player.
   */
  shouldRebalance(tables: BalancerTable[]): boolean {
    if (tables.length <= 1) return false;
    const { gap } = this.evaluateBalance(tables);
    return gap > 1;
  }

  /**
   * Calculate the optimal set of moves to balance tables.
   * Moves players from over-seated to under-seated tables.
   * Minimizes total moves while achieving gap <= 1.
   */
  calculateMoves(tables: BalancerTable[]): MoveInstruction[] {
    if (tables.length <= 1) return [];

    const totalPlayers = tables.reduce((s, t) => s + t.playerCount, 0);
    const idealPerTable = Math.floor(totalPlayers / tables.length);
    const remainder = totalPlayers % tables.length;

    // Sort tables by player count descending — most populated get the +1 targets
    //
    // B2 2026-08-27: `players` is COPIED, not shared. The spread below clones
    // the table object but not its arrays, so the `under.players.push(...)`
    // further down was writing straight through into the caller's own table
    // objects — a planning routine silently editing its input. Harmless while
    // every caller re-reads seats from the DB after applying the moves, but it
    // is a trap for the first caller that does not.
    const sortedByCount = tables
      .map((t) => ({
        ...t,
        players: [...t.players],
        target: 0,
      }))
      .sort((a, b) => b.playerCount - a.playerCount);

    for (let i = 0; i < sortedByCount.length; i++) {
      sortedByCount[i].target = i < remainder ? idealPerTable + 1 : idealPerTable;
    }

    // Identify over-seated and under-seated tables
    const overSeated = sortedByCount.filter((t) => t.playerCount > t.target);
    const underSeated = sortedByCount.filter((t) => t.playerCount < t.target);

    const moves: MoveInstruction[] = [];

    // B2: the big blind each DESTINATION has just dealt, taken from the real
    // occupancy before any player is moved in. Cached because the inner loops
    // can visit the same destination for several source tables, and because
    // `under.players` grows as seats are filled.
    const destinationBB = new Map<string, number | null>();
    for (const t of sortedByCount) {
      destinationBB.set(
        t.tableId,
        currentBigBlindSeat(
          t.players.map((p) => p.seat),
          t.buttonSeat
        )
      );
    }

    for (const over of overSeated) {
      let excess = over.playerCount - over.target;

      // B6: move the player who is big blind due next (standard tournament
      // rule — fair because they pay exactly one BB, at the destination). Falls
      // back to smallest-stack ("least disruptive") when the button seat is
      // unknown or the table is too small for a meaningful blind order.
      const movablePlayers =
        orderPlayersForMove(over.players, over.buttonSeat) ??
        [...over.players].sort((a, b) => a.stack - b.stack);

      // B2: snapshot the SOURCE blind cycle before anything is moved, so each
      // player can be re-seated at the same point in the destination's cycle.
      const sourceRing = over.players.map((p) => p.seat);
      const sourceBB = currentBigBlindSeat(sourceRing, over.buttonSeat);

      for (const under of underSeated) {
        if (excess <= 0) break;
        let deficit = under.target - under.playerCount;

        while (excess > 0 && deficit > 0 && movablePlayers.length > 0) {
          const player = movablePlayers.shift()!;
          const sourceHops =
            sourceBB === null ? null : hopsToBigBlind(sourceRing, sourceBB, player.seat);
          const { seat: toSeat } = this.findOpenSeat(under, {
            bbSeat: destinationBB.get(under.tableId) ?? null,
            sourceHops,
          });

          if (toSeat === -1) break; // No open seats

          moves.push({
            playerId: player.userId,
            fromTableId: over.tableId,
            fromSeat: player.seat,
            toTableId: under.tableId,
            toSeat,
            reason: `Balance: ${over.tableId.slice(0, 8)} (${over.playerCount}) → ${under.tableId.slice(0, 8)} (${under.playerCount})`,
          });

          // Update counts for subsequent calculations
          over.playerCount--;
          under.playerCount++;
          under.players.push({ ...player, seat: toSeat });
          excess--;
          deficit--;
        }
      }
    }

    if (moves.length > 0) {
      this.emitEvent({
        type: 'TABLE_BALANCE_EXECUTED',
        moveCount: moves.length,
        tableCount: tables.length,
        totalPlayers,
        /* 2026-08-23: the counts alone were unusable. TablePage's handler is
           `if (payload.moves?.some((m) => m.playerId === userId))` — it needs
           to know WHICH players moved to tell one of them "You were moved to
           balance the tables." Without this the toast could never fire even
           once the event reached the client. Ids and seats only; nothing here
           is private to another player. */
        moves: moves.map((m) => ({
          playerId: m.playerId,
          fromTableId: m.fromTableId,
          toTableId: m.toTableId,
          toSeat: m.toSeat,
        })),
      });
    }

    return moves;
  }

  /**
   * Check if a table should be broken (merged into others).
   *
   * B1 2026-08-27 — THE FIELD NEVER COLLAPSED, SO THE FINAL TABLE NEVER FORMED.
   *
   * The only consolidation trigger used to be `playerCount <= 3`. A tournament
   * whose tables all sit at four or more players therefore never lost a table,
   * however far the field had shrunk. Seen live: a $100 Freeroll holding 14
   * players across three tables of 4/5/5 — a field that fits on two tables with
   * four seats to spare — with no break possible, because no single table was
   * short enough to qualify. The `final_table` gate downstream can never be
   * reached by a tournament that cannot get below its starting table count.
   *
   * The trigger is now the one every tournament floor actually uses: break a
   * table when the field FITS ON THE OTHERS. Three things keep that from
   * thrashing tables back and forth on every elimination:
   *
   *  1. ONLY THE EMPTIEST TABLE IS A CANDIDATE (ties by table id, so the answer
   *     is stable and deterministic across cycles). Two tables can never both
   *     decide to empty themselves into each other on the same pass.
   *  2. ONE SPARE SEAT IS RESERVED PER SURVIVING TABLE. Consolidating onto
   *     tables filled to the brim is what actually oscillates: the next late
   *     entry or re-entry has nowhere to sit, expansion spawns a table, and the
   *     count climbs straight back. Holding a seat back per table means the
   *     field has to fit with room to breathe before we commit.
   *  3. THE RESERVE IS DROPPED FOR THE LAST MERGE ONLY (one surviving table).
   *     There is no later arrival to leave room for at the final table, and
   *     refusing to break there would reintroduce the exact bug above: a
   *     9-handed final table needs all nine seats.
   *
   * Breaking is monotone — this class only ever removes tables, never creates
   * them — so beyond those three rules there is no cycle to guard against.
   *
   * Empty tables always break (nothing to move) and are never counted as
   * somewhere to put players: a table with nobody on it is itself waiting to be
   * closed, so filling one makes no progress at all.
   */
  shouldBreakTable(table: BalancerTable, allTables: BalancerTable[]): boolean {
    if (allTables.length <= 1) return false;
    if (table.playerCount === 0) return true;

    const targets = allTables.filter((t) => t.tableId !== table.tableId && t.playerCount > 0);
    if (targets.length === 0) return false;

    const seatsFree = (t: BalancerTable, reserve: number) =>
      Math.max(0, t.maxSeats - reserve - t.playerCount);

    // Physical seats. Never break a table whose players do not fit — that
    // strands players at a table nothing looks at again.
    const hardCapacity = targets.reduce((s, t) => s + seatsFree(t, 0), 0);
    if (hardCapacity < table.playerCount) return false;

    // Last merge: one table survives, take every seat it has.
    if (targets.length === 1) return true;

    const softCapacity = targets.reduce((s, t) => s + seatsFree(t, 1), 0);
    if (softCapacity >= table.playerCount && this.isEmptiestTable(table, allTables)) return true;

    // A table this short breaks as soon as its players physically fit, which is
    // the pre-existing rule and is preserved exactly.
    return table.playerCount <= 3;
  }

  /**
   * Deterministic single break candidate: fewest players, ties by table id.
   * Empty tables are excluded — they take the unconditional break above.
   */
  private isEmptiestTable(table: BalancerTable, allTables: BalancerTable[]): boolean {
    const contenders = allTables.filter((t) => t.playerCount > 0);
    const min = Math.min(...contenders.map((t) => t.playerCount));
    if (table.playerCount !== min) return false;
    const tied = contenders
      .filter((t) => t.playerCount === min)
      .map((t) => t.tableId)
      .sort();
    return tied[0] === table.tableId;
  }

  /**
   * Generate moves to break a table and distribute its players to other tables.
   */
  breakTable(table: BalancerTable, otherTables: BalancerTable[]): MoveInstruction[] {
    const moves: MoveInstruction[] = [];
    const targets = [...otherTables].sort((a, b) => a.playerCount - b.playerCount);

    // B2 2026-08-27: leave in blind order — the player who is big blind due
    // next goes first and so gets the soonest big blind at the destination,
    // the player who has just posted it goes last and gets the latest one.
    // Position in the blind cycle is preserved across the break instead of
    // being decided by whatever order the seat rows came back from the DB in.
    const leaving = orderPlayersForMove(table.players, table.buttonSeat) ?? table.players;
    const sourceRing = table.players.map((p) => p.seat);
    const sourceBB = currentBigBlindSeat(sourceRing, table.buttonSeat);
    const destinationBB = new Map<string, number | null>();
    for (const t of targets) {
      destinationBB.set(
        t.tableId,
        currentBigBlindSeat(
          t.players.map((p) => p.seat),
          t.buttonSeat
        )
      );
    }

    for (const player of leaving) {
      // FIX-B7 2026-07-19: spread broken-table players to the LEAST-full target
      // each iteration, and REFLECT each placement. The old code never updated
      // the chosen target's playerCount/players, so it (a) dumped everyone onto
      // targets[0] until full instead of balancing, and (b) called findOpenSeat
      // against a stale player list — returning the SAME seat for every player →
      // seat collisions. Re-sort by occupancy, then increment + record the seat.
      // B2 2026-08-27: an EMPTY target is not a destination — it is a table
      // that is itself waiting to be closed, and least-full-first would have
      // sent the whole broken table straight into it, achieving nothing.
      targets.sort(
        (a, b) =>
          (a.playerCount === 0 ? 1 : 0) - (b.playerCount === 0 ? 1 : 0) ||
          a.playerCount - b.playerCount
      );
      const sourceHops =
        sourceBB === null ? null : hopsToBigBlind(sourceRing, sourceBB, player.seat);
      let target: BalancerTable | undefined;
      let toSeat = -1;
      for (const candidate of targets) {
        if (!(candidate.playerCount > 0 && candidate.playerCount < candidate.maxSeats)) continue;
        const choice = this.findOpenSeat(candidate, {
          bbSeat: destinationBB.get(candidate.tableId) ?? null,
          sourceHops,
        });
        // Roster reservations can occupy every otherwise empty chair. Try
        // the next destination before advancing to another source player.
        if (choice.seat === -1) continue;
        target = candidate;
        toSeat = choice.seat;
        break;
      }
      if (!target) break;

      moves.push({
        playerId: player.userId,
        fromTableId: table.tableId,
        fromSeat: player.seat,
        toTableId: target.tableId,
        toSeat,
        reason: `Table break: ${table.tableId.slice(0, 8)} dissolved`,
      });

      // Reflect the placement so the next player spreads + gets a distinct seat.
      target.playerCount++;
      target.players.push({ ...player, seat: toSeat });
    }

    return moves;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * B2 2026-08-27 — SEAT RELATIVE TO THE BUTTON, NOT SEAT NUMBER 1.
   *
   * This used to return the lowest-numbered free seat, which is a number
   * plucked out of the air as far as the blinds are concerned. Two different
   * errors fell out of it, at random, hand by hand:
   *
   *   - land just past the destination's big blind and the player is dealt in
   *     for a whole orbit before paying anything (free orbit);
   *   - land on the destination's blinds and a player who has just posted the
   *     big blind at the table they came from pays a second one inside the same
   *     orbit (double blind).
   *
   * `orderPlayersForMove` already went to the trouble of picking the player at
   * the source whose blind debt makes them the fair one to move; throwing that
   * away at the destination made the whole ordering pointless.
   *
   * The seat is now chosen by BLIND POSITION:
   *
   *   - `sourceHops` is where the player sat in the source table's blind cycle
   *     (1 = about to post the big blind, n = has just posted it). We take the
   *     free seat with the LARGEST hops that is still <= sourceHops: as close
   *     to the place they left as the destination allows, and never sooner than
   *     they had earned, so they cannot be charged twice.
   *   - if every free seat is later in the cycle than that, the player would
   *     gain free hands, so we take the SOONEST big blind instead.
   *   - the two seats the big blind has only just passed (the destination's
   *     button and small blind for the next hand) are held back unless nothing
   *     else is free. Those are the free-orbit seats, and they are also the two
   *     the engine charges an arriving tournament player for, so keeping moved
   *     players out of them is what stops a balance move from ever colliding
   *     with that charge.
   *   - with no blind order to work from (button unknown, table too small) the
   *     old lowest-free-seat behaviour stands.
   *
   * Never returns a seat above `maxSeats`, so a move can never over-fill a table.
   */
  private findOpenSeat(
    table: BalancerTable,
    opts?: { bbSeat?: number | null; sourceHops?: number | null }
  ): SeatChoice {
    const sourceHops = opts?.sourceHops ?? null;
    const occupiedSeats = new Set<number>([
      ...table.players.map((p) => p.seat),
      ...(table.reservedSeats ?? []),
    ]);
    const free: number[] = [];
    for (let seat = 1; seat <= table.maxSeats; seat++) {
      if (!occupiedSeats.has(seat)) free.push(seat);
    }
    if (free.length === 0) return { seat: -1, hops: null };

    const ring = table.players.map((p) => p.seat);
    // The big blind of the hand the destination has just DEALT. Passed in by
    // the caller so it is computed once, off the real occupancy, and does not
    // drift as this method fills seats with the players being moved in.
    const bbSeat =
      opts?.bbSeat !== undefined ? opts.bbSeat : currentBigBlindSeat(ring, table.buttonSeat);
    if (bbSeat === null || !occupiedSeats.has(bbSeat)) return { seat: free[0], hops: null };

    const scored = free
      .map((seat) => ({ seat, hops: hopsToBigBlind(ring, bbSeat, seat) }))
      .sort((a, b) => a.hops - b.hops || a.seat - b.seat);

    // n counts the seat we are about to fill, matching hopsToBigBlind.
    const n = new Set([...ring, scored[0].seat]).size;
    // hops >= n - 1 is the button / small blind for the coming hand: the seats
    // the big blind passed one and two hands ago.
    const justPassedTheBlinds = (hops: number) => n >= 4 && hops >= n - 1;

    const preferred = scored.filter((c) => !justPassedTheBlinds(c.hops));
    const pool = preferred.length > 0 ? preferred : scored;

    if (sourceHops != null) {
      const sameOrEarlier = pool.filter((c) => c.hops <= sourceHops);
      if (sameOrEarlier.length > 0) return sameOrEarlier[sameOrEarlier.length - 1];
    }
    return pool[0];
  }

  private emitEvent(event: TableBalancerEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'TableBalancer.eventHandler');
      }
    }
  }
}

/** Explicit opt-in pure planning. No receipt, financial permission or persistence. */
export interface OnlineGeometryProfile {
  policy: 'CLUB_ARENA_ONLINE_MTT_V1';
  format: 'nlh' | 'plo4';
  originalPlanId: string;
  rosterVersion: string;
  /** Original unbiased uint32 draws supplied/captured by the owning planner. */
  randomDraws: readonly number[];
  priorMoveCounts: Readonly<Record<string, number>>;
  sourceRevision: 2;
  /** Canonical complete active set, supplied by owner at a quiescent boundary. */
  activeTableIds: readonly string[];
}
export type OnlineGeometryResult =
  | { status: 'pending'; reason: string }
  | {
      status: 'planned';
      policy: string;
      originalPlanId: string;
      rosterVersion: string;
      moves: MoveInstruction[];
      finalRosters: { tableId: string; players: BalancerPlayer[] }[];
      objective: number[];
      equallyRankedPlans: number | null;
      completeAssignmentCount?: string;
      sampling?: 'uniform_ordered_chairs';
      consumedDraws: number[];
    };

/** Zero means BB on the next eligible hand, using the complete fixed roster. */
export function projectedNaturalBB(
  seats: readonly number[],
  lastButton: number,
  playerSeat: number,
  lastBigBlindSeat?: number
): number {
  const ring = [...seats].sort((a, b) => a - b);
  if (
    ring.length < 2 ||
    new Set(ring).size !== ring.length ||
    !ring.includes(playerSeat) ||
    !Number.isInteger(lastButton) ||
    lastButton < 1
  )
    throw Error('projection_unknown');
  if (ring.length === 2 && (!Number.isInteger(lastBigBlindSeat) || lastBigBlindSeat! < 1))
    throw Error('heads_up_history_unknown');
  let previousBB = lastBigBlindSeat;
  let button = lastButton;
  for (let hand = 0; hand < ring.length; hand++) {
    button =
      ring.length === 2
        ? headsUpButtonSeat(ring, previousBB!)!
        : (ring.find((s) => s > button) ?? ring[0]);
    const index = ring.indexOf(button);
    const bb = ring[(index + (ring.length === 2 ? 1 : 2)) % ring.length];
    if (bb === playerSeat) return hand;
    previousBB = bb;
  }
  throw Error('projection_unknown');
}

/** Exhaustive bounded optimizer. Exhaustion returns pending, never a best-so-far
 * plan mislabeled optimal. Legacy methods above remain entirely unchanged. */
export function planOnlineGeometry(
  input: readonly BalancerTable[],
  profile: OnlineGeometryProfile,
  breakTableId?: string
): OnlineGeometryResult {
  try {
    if (
      profile.sourceRevision !== 2 ||
      profile.policy !== 'CLUB_ARENA_ONLINE_MTT_V1' ||
      !['nlh', 'plo4'].includes(profile.format) ||
      !profile.originalPlanId ||
      !profile.rosterVersion
    )
      throw Error('profile_required');
    if (input.some((t) => t.players.length > 10 || (t.reservedSeats?.length ?? 0) > 10))
      throw Error('field_input_budget_exhausted');
    if (input.length > 2000) throw Error('field_input_budget_exhausted');
    const tables = input
      .map((t) => ({
        ...t,
        players: t.players.map((p) => ({ ...p })),
        reservedSeats: [...(t.reservedSeats ?? [])],
      }))
      .sort((a, b) => a.tableId.localeCompare(b.tableId));
    if (
      !tables.length ||
      tables.length > 2000 ||
      new Set(tables.map((t) => t.tableId)).size !== tables.length
    )
      throw Error('roster_unknown');
    const users = new Set<string>();
    let historyTotal = 0n;
    for (const t of tables) {
      if (
        !t.tableId ||
        !Number.isInteger(t.maxSeats) ||
        t.maxSeats < 2 ||
        t.maxSeats > 10 ||
        t.playerCount !== t.players.length ||
        !Number.isInteger(t.buttonSeat) ||
        t.buttonSeat! < 1 ||
        t.buttonSeat! > t.maxSeats
      )
        throw Error('roster_unknown');
      if (
        t.lastBigBlindSeat !== undefined &&
        (!Number.isInteger(t.lastBigBlindSeat) ||
          t.lastBigBlindSeat < 1 ||
          t.lastBigBlindSeat > t.maxSeats)
      )
        throw Error('prior_bb_out_of_domain');
      const occupied = [...t.players.map((p) => p.seat), ...t.reservedSeats];
      if (
        new Set(occupied).size !== occupied.length ||
        occupied.some((s) => !Number.isInteger(s) || s < 1 || s > t.maxSeats)
      )
        throw Error('occupancy_unknown');
      for (const p of t.players) {
        if (
          !p.userId ||
          users.has(p.userId) ||
          !Number.isFinite(p.stack) ||
          p.stack <= 0 ||
          !Number.isSafeInteger(profile.priorMoveCounts[p.userId]) ||
          profile.priorMoveCounts[p.userId] < 0
        )
          throw Error('player_history_unknown');
        historyTotal += BigInt(profile.priorMoveCounts[p.userId]);
        if (historyTotal > BigInt(Number.MAX_SAFE_INTEGER))
          throw Error('aggregate_history_out_of_domain');
        users.add(p.userId);
      }
    }
    const activeIds = new Set(profile.activeTableIds);
    const activeTables = tables.filter((t) => t.tableId !== breakTableId);
    if (
      activeIds.size !== profile.activeTableIds.length ||
      profile.activeTableIds.length !== activeTables.length ||
      activeTables.some((t) => !activeIds.has(t.tableId))
    )
      throw Error('active_set_mismatch');
    const broken =
      breakTableId === undefined ? -1 : tables.findIndex((t) => t.tableId === breakTableId);
    if (breakTableId !== undefined && broken < 0) throw Error('source_unknown');
    let visited = 0,
      drawIndex = 0,
      ties = 0;
    const draws: number[] = [];
    type Candidate = {
      moves: MoveInstruction[];
      objective: number[];
    };
    let best: Candidate | null = null;
    const tick = () => {
      if (++visited > 100_000) throw Error('search_budget_exhausted');
    };
    const randomBelow = (n: number) => {
      if (n === 1) return 0;
      const limit = Math.floor(0x100000000 / n) * n;
      for (;;) {
        tick();
        const x = profile.randomDraws[drawIndex++];
        if (!Number.isInteger(x) || x < 0 || x >= 0x100000000)
          throw Error('random_input_exhausted_or_invalid');
        draws.push(x);
        if (x < limit) return x % n;
      }
    };
    const compare = (a: number[], b: number[]) => {
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
      return 0;
    };
    const tableById = new Map(tables.map((t) => [t.tableId, t]));
    const playerById = new Map(tables.flatMap((t) => t.players.map((p) => [p.userId, p] as const)));
    const sourceProjection = new Map<string, number>();
    const evaluate = (moves: MoveInstruction[]) => {
      tick();
      const destinationSeats = new Map<string, number[]>();
      for (const m of moves) {
        if (!destinationSeats.has(m.toTableId))
          destinationSeats.set(
            m.toTableId,
            tableById.get(m.toTableId)!.players.map((p) => p.seat)
          );
        destinationSeats.get(m.toTableId)!.push(m.toSeat);
      }
      let sum = 0,
        max = 0,
        prior = 0;
      if (broken < 0)
        for (const m of moves) {
          const source = tableById.get(m.fromTableId)!;
          const destination = tableById.get(m.toTableId)!;
          if (!sourceProjection.has(m.playerId))
            sourceProjection.set(
              m.playerId,
              projectedNaturalBB(
                source.players.map((p) => p.seat),
                source.buttonSeat!,
                m.fromSeat,
                source.lastBigBlindSeat
              )
            );
          const d = Math.abs(
            sourceProjection.get(m.playerId)! -
              projectedNaturalBB(
                destinationSeats.get(m.toTableId)!,
                destination.buttonSeat!,
                m.toSeat,
                destination.lastBigBlindSeat
              )
          );
          sum += d;
          max = Math.max(max, d);
          prior += profile.priorMoveCounts[m.playerId];
        }
      const objective = broken < 0 ? [moves.length, sum, max, prior] : [moves.length];
      const comparison = best ? compare(objective, best.objective) : -1;
      if (comparison > 0) return;
      if (comparison < 0) {
        ties = 1;
        best = { moves: moves.map((m) => ({ ...m })), objective };
      } else if (randomBelow(++ties) === 0)
        best = { moves: moves.map((m) => ({ ...m })), objective };
    };
    const assign = (
      moving: { table: number; player: BalancerPlayer }[],
      deficits: number[],
      moves: MoveInstruction[]
    ) => {
      tick();
      if (moves.length === moving.length) {
        evaluate(moves);
        return;
      }
      const current = moving[moves.length];
      for (let i = 0; i < tables.length; i++) {
        if (i === broken || deficits[i] <= 0) continue;
        const t = tables[i];
        for (let seat = 1; seat <= t.maxSeats; seat++) {
          if (
            t.players.some((p) => p.seat === seat) ||
            t.reservedSeats.includes(seat) ||
            moves.some((m) => m.toTableId === t.tableId && m.toSeat === seat)
          )
            continue;
          deficits[i]--;
          moves.push({
            playerId: current.player.userId,
            fromTableId: tables[current.table].tableId,
            fromSeat: current.player.seat,
            toTableId: t.tableId,
            toSeat: seat,
            reason: 'CLUB_ARENA_ONLINE_MTT_V1:' + (broken < 0 ? 'balance' : 'break'),
          });
          assign(moving, deficits, moves);
          moves.pop();
          deficits[i]++;
        }
      }
    };
    if (broken >= 0) {
      const moving = tables[broken].players
        .slice()
        .sort((a, b) => a.userId.localeCompare(b.userId));
      const chairs: { tableId: string; seat: number }[] = [];
      const finalRosters = tables
        .filter((_, i) => i !== broken)
        .map((t) => ({
          tableId: t.tableId,
          players: t.players.map((p) => ({ ...p })),
        }));
      const destinations = new Map(finalRosters.map((t) => [t.tableId, t]));
      for (const t of activeTables)
        for (let seat = 1; seat <= t.maxSeats; seat++) {
          tick();
          if (!t.players.some((p) => p.seat === seat) && !t.reservedSeats.includes(seat))
            chairs.push({ tableId: t.tableId, seat });
        }
      if (chairs.length < moving.length) throw Error('capacity_unavailable');
      let count = 1n;
      const moves: MoveInstruction[] = [];
      for (let i = 0; i < moving.length; i++) {
        tick();
        count *= BigInt(chairs.length - i);
        const pick = i + randomBelow(chairs.length - i);
        [chairs[i], chairs[pick]] = [chairs[pick], chairs[i]];
        const chair = chairs[i],
          player = moving[i];
        moves.push({
          playerId: player.userId,
          fromTableId: tables[broken].tableId,
          fromSeat: player.seat,
          toTableId: chair.tableId,
          toSeat: chair.seat,
          reason: 'CLUB_ARENA_ONLINE_MTT_V1:break',
        });
        destinations.get(chair.tableId)!.players.push({ ...player, seat: chair.seat });
      }
      return {
        status: 'planned',
        policy: profile.policy,
        originalPlanId: profile.originalPlanId,
        rosterVersion: profile.rosterVersion,
        moves,
        finalRosters,
        objective: [moves.length],
        equallyRankedPlans: count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : null,
        completeAssignmentCount: count.toString(),
        sampling: 'uniform_ordered_chairs',
        consumedDraws: draws,
      };
    } else {
      const low = Math.floor(users.size / tables.length),
        high = Math.ceil(users.size / tables.length);
      if (low < 2) throw Error('next_hand_roster_unknown');
      // The validated original rosters already achieve the floor/ceil target.
      // Zero moves is the unique minimum; it needs no target DP or random draw.
      if (tables.every((t) => t.players.length >= low && t.players.length <= high)) {
        return {
          status: 'planned',
          policy: profile.policy,
          originalPlanId: profile.originalPlanId,
          rosterVersion: profile.rosterVersion,
          moves: [],
          finalRosters: tables.map((t) => ({
            tableId: t.tableId,
            players: t.players,
          })),
          objective: [0, 0, 0, 0],
          equallyRankedPlans: 1,
          consumedDraws: [],
        };
      }
      const targets: number[] = [];
      const solveTargets = () => {
        const excess = tables.map((t, i) => Math.max(0, t.players.length - targets[i]));
        const deficits = tables.map((t, i) => Math.max(0, targets[i] - t.players.length));
        const donors = tables.map((_, i) => i).filter((i) => excess[i] > 0);
        const receivers = tables.map((_, i) => i).filter((i) => deficits[i] > 0);
        if (donors.length === 1 && receivers.length === 1) {
          const from = donors[0],
            to = receivers[0],
            source = tables[from],
            destination = tables[to];
          const sourceByDistance = new Map<number, BalancerPlayer>();
          for (const player of source.players) {
            tick();
            const distance = projectedNaturalBB(
              source.players.map((p) => p.seat),
              source.buttonSeat!,
              player.seat,
              source.lastBigBlindSeat
            );
            sourceByDistance.set(distance, player);
          }
          // A unique inverse is essential: otherwise retain exhaustive search.
          if (sourceByDistance.size === source.players.length) {
            const free = Array.from({ length: destination.maxSeats }, (_, i) => i + 1).filter(
              (seat) =>
                !destination.players.some((p) => p.seat === seat) &&
                !destination.reservedSeats.includes(seat)
            );
            const selected: number[] = [];
            let foundZero = false;
            const chairs = (index: number): void => {
              tick();
              if (selected.length === deficits[to]) {
                const finalSeats = [...destination.players.map((p) => p.seat), ...selected];
                const moves: MoveInstruction[] = [];
                const used = new Set<string>();
                for (const seat of selected) {
                  const distance = projectedNaturalBB(
                    finalSeats,
                    destination.buttonSeat!,
                    seat,
                    destination.lastBigBlindSeat
                  );
                  const player = sourceByDistance.get(distance);
                  if (!player || used.has(player.userId)) return;
                  used.add(player.userId);
                  moves.push({
                    playerId: player.userId,
                    fromTableId: source.tableId,
                    fromSeat: player.seat,
                    toTableId: destination.tableId,
                    toSeat: seat,
                    reason: 'CLUB_ARENA_ONLINE_MTT_V1:balance',
                  });
                }
                foundZero = true;
                evaluate(moves);
                return;
              }
              for (let i = index; i <= free.length - (deficits[to] - selected.length); i++) {
                selected.push(free[i]);
                chairs(i + 1);
                selected.pop();
              }
            };
            chairs(0);
            // Sum/max are nonnegative. Once a zero assignment exists, every
            // positive assignment in this SAME target vector is dominated.
            // All zero assignments above retain exact prior-history/tie ranking.
            if (foundZero) return;
          }
        }
        const candidates = tables
          .flatMap((t, i) =>
            t.players
              .slice()
              .sort((a, b) => a.userId.localeCompare(b.userId))
              .map((player) => ({ table: i, player }))
          )
          .filter((p) => excess[p.table] > 0);
        const chosen: typeof candidates = [];
        const choose = (index: number) => {
          tick();
          if (index === candidates.length) {
            if (excess.every((x) => x === 0)) assign(chosen, deficits, []);
            return;
          }
          choose(index + 1);
          const x = candidates[index];
          if (excess[x.table] > 0) {
            excess[x.table]--;
            chosen.push(x);
            choose(index + 1);
            chosen.pop();
            excess[x.table]++;
          }
        };
        choose(0);
      };
      // A high target reduces outgoing movement cost by exactly one iff
      // this table is above low. All other high choices have zero benefit.
      // Thus exact minimum movement uses as many beneficial highs as possible.
      const highCount = users.size % tables.length;
      const category = tables.map((t) => {
        tick();
        const capacity = t.maxSeats - t.reservedSeats.length;
        if (capacity < low) throw Error('capacity_unavailable');
        return high > low && capacity >= high ? (t.players.length > low ? 1 : 0) : -1;
      });
      const beneficial = new Int32Array(tables.length + 1);
      const neutral = new Int32Array(tables.length + 1);
      for (let i = tables.length - 1; i >= 0; i--) {
        beneficial[i] = beneficial[i + 1] + (category[i] === 1 ? 1 : 0);
        neutral[i] = neutral[i + 1] + (category[i] === 0 ? 1 : 0);
      }
      const wantedBeneficial = Math.min(highCount, beneficial[0]);
      const wantedNeutral = highCount - wantedBeneficial;
      if (wantedNeutral > neutral[0]) throw Error('capacity_unavailable');
      const minimumMoves =
        tables.reduce((sum, t) => sum + Math.max(0, t.players.length - low), 0) - wantedBeneficial;
      if (minimumMoves === 1) {
        // Every complete one-move plan changes only its source and destination.
        // An unbalanced field has an outlier, so at least one side is fixed;
        // this avoids enumerating equivalent whole-field target vectors.
        const above = tables
          .map((t, i) => (t.players.length > high ? i : -1))
          .filter((i) => i >= 0);
        const below = tables.map((t, i) => (t.players.length < low ? i : -1)).filter((i) => i >= 0);
        const donors = tables
          .map((t, i) => i)
          .filter(
            (i) =>
              tables[i].players.length - 1 >= low &&
              tables[i].players.length - 1 <= high &&
              (above.length === 0 || (above.length === 1 && above[0] === i))
          );
        const receivers = tables
          .map((t, i) => i)
          .filter(
            (i) =>
              tables[i].players.length + 1 >= low &&
              tables[i].players.length + 1 <= high &&
              tables[i].players.length + 1 <= tables[i].maxSeats - tables[i].reservedSeats.length &&
              (below.length === 0 || (below.length === 1 && below[0] === i))
          );
        for (const from of donors) {
          tick();
          const source = tables[from];
          for (const player of source.players
            .slice()
            .sort((a, b) => a.userId.localeCompare(b.userId)))
            for (const to of receivers) {
              if (from === to) continue;
              const destination = tables[to];
              for (let seat = 1; seat <= destination.maxSeats; seat++) {
                if (
                  destination.players.some((p) => p.seat === seat) ||
                  destination.reservedSeats.includes(seat)
                )
                  continue;
                evaluate([
                  {
                    playerId: player.userId,
                    fromTableId: source.tableId,
                    fromSeat: player.seat,
                    toTableId: destination.tableId,
                    toSeat: seat,
                    reason: 'CLUB_ARENA_ONLINE_MTT_V1:balance',
                  },
                ]);
              }
            }
        }
      } else {
        // Enumerate every target meeting BOTH exact quotas, in canonical
        // low-before-high order. Remaining suffix counts prune only impossibility.
        const stack: {
          index: number;
          beneficialLeft: number;
          neutralLeft: number;
          nextChoice: number;
        }[] = [
          { index: 0, beneficialLeft: wantedBeneficial, neutralLeft: wantedNeutral, nextChoice: 0 },
        ];
        while (stack.length) {
          tick();
          const state = stack[stack.length - 1];
          if (state.index === tables.length) {
            solveTargets();
            stack.pop();
            targets.pop();
            continue;
          }
          const options = high === low ? [low] : [low, high];
          if (state.nextChoice === options.length) {
            stack.pop();
            if (state.index > 0) targets.pop();
            continue;
          }
          const n = options[state.nextChoice++],
            i = state.index;
          if (n > low && category[i] === -1) continue;
          const b = state.beneficialLeft - (n > low && category[i] === 1 ? 1 : 0);
          const z = state.neutralLeft - (n > low && category[i] === 0 ? 1 : 0);
          if (b >= 0 && z >= 0 && b <= beneficial[i + 1] && z <= neutral[i + 1]) {
            targets.push(n);
            stack.push({ index: i + 1, beneficialLeft: b, neutralLeft: z, nextChoice: 0 });
          }
        }
      }
    }
    const proven = best as Candidate | null;
    if (!proven) throw Error('no_complete_plan');
    const moved = new Set(proven.moves.map((m) => m.playerId));
    const arrivals = new Map<string, BalancerPlayer[]>();
    for (const m of proven.moves) {
      if (!arrivals.has(m.toTableId)) arrivals.set(m.toTableId, []);
      arrivals.get(m.toTableId)!.push({ ...playerById.get(m.playerId)!, seat: m.toSeat });
    }
    const finalRosters = tables.map((t) => ({
      tableId: t.tableId,
      players: [
        ...t.players.filter((p) => !moved.has(p.userId)).map((p) => ({ ...p })),
        ...(arrivals.get(t.tableId) || []),
      ],
    }));
    return {
      status: 'planned',
      policy: profile.policy,
      originalPlanId: profile.originalPlanId,
      rosterVersion: profile.rosterVersion,
      ...proven,
      finalRosters,
      equallyRankedPlans: ties,
      consumedDraws: draws,
    };
  } catch (error) {
    return {
      status: 'pending',
      reason: error instanceof Error ? error.message : 'planning_unknown',
    };
  }
}
