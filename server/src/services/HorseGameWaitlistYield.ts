/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A PERSON ON A GAME'S LIST IS A PERSON WAITING (2026-10-22)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The human-yield rule (Dan 2026-09-02: a horse gets up when a real person is
 * waiting, and for no other reason) read ONE list: `table_waitlist`. A player
 * who joins a must-move game through its door (`fn_cash_game_join`) and finds
 * no open chair is put on the GAME's list, `cash_game_waitlist`, not on any
 * table's.
 *
 * For an ordinary must-move game that is fine: `fn_cash_cluster_tick` counts
 * that list as buyers and opens a feeder for them. A Lightning Cluster's tick
 * stands down (`lightning_cluster_stands_down`, whenever `must_move` is set
 * and `cluster_mode` is not 'must_move'), so nothing opens a table for them,
 * and nothing stood a horse up either. Measured 2026-10-22 09:15 UTC: both
 * Lightning pilot games 100% horses (Action 3 tables / 18 seats, Madness
 * 2 / 12), and a person who used the Lightning door waited for ever.
 *
 * The seat itself was always going to be offered. `fn_offer_open_seat` runs
 * on every cash-out (atomicCashout -> notifyWaitlistSeatOpen), and when the
 * table's own list is empty it falls through to the game's list and holds the
 * chair for its FIFO head. What was missing was the vacancy. This module
 * supplies the one fact the yield paths lacked: which table owes a chair to
 * a person on a game list that cannot open a table for them.
 *
 * ── THE RULES, EACH ONE A MIRROR OF THE DOOR THAT WILL SEAT THEM ──────────
 *
 *  - Only games whose tick does not open tables for the list. An ordinary
 *    must-move game (must_move, cluster_mode 'must_move') counts the list as
 *    buyers and opens a feeder; counting it again here would stand a horse up
 *    for a person who is about to get a whole table (double count). A
 *    Lightning Cluster stands down, and a manual game (must_move false) is
 *    refused by the tick as 'manual_game': neither opens anything.
 *  - Only an enabled game. `fn_offer_open_seat` offers nothing in a disabled
 *    one, so a chair opened there would be refilled, not taken.
 *  - Never a horse. A horse in the count makes a horse stand up for a horse.
 *  - Never twice, and never for somebody already sitting. A player who holds
 *    a row on one of the game's TABLE lists is counted there by the existing
 *    rule (the join door and the offer write that table hold together with
 *    the game row's `notified`). A player already seated in the game is not
 *    waiting: a Lightning tick never runs the step that marks their game row
 *    `seated`, so the row alone cannot be trusted to say so.
 *  - `waiting` counts while the door would still offer it (`p_entry_ttl`,
 *    24 hours). `notified` counts for the three minutes the ordinary tick
 *    gives a notified row before it calls it expired; a Lightning tick never
 *    runs that expiry, so without the bound a player who walked away would
 *    hold a chair open for ever.
 *  - EXACTLY ONE TABLE per waiter: the game's live table with the most horses,
 *    ties by id. Every yield path then applies its ordinary arithmetic once
 *    (StableHand's yieldCount, the rotator's releaseWanted, the fleet's
 *    occupancy target), never once per table of the game.
 *  - FAILS CLOSED. Any incomplete read attributes nobody, so nobody is asked
 *    to leave for a list that could not be read. The table lists' own counts
 *    are untouched by that failure.
 *
 * No timer, no switch, no write, no money path: the existing yield paths act
 * on the count at their own hand-boundary-safe leave doors.
 */
import { supabase } from './supabase.js';
import { fetchAllRows } from './supabase/pagination.js';
import { selectInChunks } from './supabase/chunkedIn.js';

/** `fn_offer_open_seat`'s default `p_entry_ttl`: an older `waiting` row is not offered. */
export const GAME_WAIT_ENTRY_TTL_MS = 24 * 60 * 60_000;
/** `fn_cash_cluster_tick`'s expiry for a `notified` game row that did not become a seat. */
export const GAME_WAIT_NOTIFIED_TTL_MS = 3 * 60_000;

export interface GameWaitRow {
  id: string;
  game_id: string;
  user_id: string;
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface GameWaitGame {
  id: string;
  must_move?: boolean | null;
  cluster_mode?: string | null;
  enabled?: boolean | null;
}

/** One open table of the floor, as the caller already knows it. */
export interface GameWaitTable {
  id: string;
  clusterId: string | null;
  lifecycle: string | null;
  /** Horses seated there now. */
  horses: number;
}

export interface GameWaitersAtTable {
  count: number;
  /** created_at of the longest-waiting person attributed here, in ms. */
  oldestMs?: number;
}

/**
 * The key a table-list row is known by when checking for a double count:
 * `${gameId}:${userId}`.
 */
export function gameQueueKey(gameId: string, userId: string): string {
  return `${gameId}:${userId}`;
}

/**
 * Does `fn_cash_cluster_tick` open tables for this game's list? Only past both
 * of its refusals: `manual_game` (must_move false) and
 * `lightning_cluster_stands_down` (cluster_mode other than 'must_move').
 */
export function tickServesGameList(g: GameWaitGame): boolean {
  return g.must_move === true && (g.cluster_mode ?? null) === 'must_move';
}

/** A list this module answers: an enabled game whose tick does not serve it. */
export function gameListNeedsYield(g: GameWaitGame): boolean {
  return g.enabled === true && !tickServesGameList(g);
}

/**
 * PURE. The `alreadyServed` set from rows the caller has already read: its
 * table-list rows and its open seats, each carrying a table id. A table the
 * caller does not know the game of is keyed '*'.
 */
export function servedKeys(
  rows: Iterable<{ table_id?: string | null; user_id?: string | null }>,
  tables: readonly GameWaitTable[]
): Set<string> {
  const clusterOf = new Map(tables.map((t) => [t.id, t.clusterId]));
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.table_id || !r.user_id) continue;
    out.add(gameQueueKey(clusterOf.get(r.table_id) ?? '*', r.user_id));
  }
  return out;
}

/** PURE. The game's live table holding the most horses, ties by id; null if none. */
export function yieldTableForGame(gameId: string, tables: readonly GameWaitTable[]): string | null {
  let best: GameWaitTable | null = null;
  for (const t of tables) {
    if (t.clusterId !== gameId || t.lifecycle !== 'live' || !(t.horses > 0)) continue;
    if (!best || t.horses > best.horses || (t.horses === best.horses && t.id < best.id)) best = t;
  }
  return best ? best.id : null;
}

/** PURE. Attribute each countable game-list person to exactly one table. */
export function attributeGameWaiters(input: {
  rows: readonly GameWaitRow[];
  games: readonly GameWaitGame[];
  horseIds: ReadonlySet<string>;
  tables: readonly GameWaitTable[];
  /**
   * `gameQueueKey` of every person already on one of the game's TABLE lists
   * or seated at one of its tables; `gameQueueKey('*', user)` when the caller
   * could not tell that table's game (treated as served: it can only count
   * fewer).
   */
  alreadyServed: ReadonlySet<string>;
  nowMs: number;
}): Map<string, GameWaitersAtTable> {
  const out = new Map<string, GameWaitersAtTable>();
  const gameById = new Map(input.games.map((g) => [String(g.id), g]));
  const seen = new Set<string>();
  for (const r of input.rows) {
    const gameId = String(r.game_id ?? '');
    const userId = String(r.user_id ?? '');
    if (!gameId || !userId) continue;
    const key = gameQueueKey(gameId, userId);
    if (seen.has(key)) continue;
    if (input.horseIds.has(userId)) continue;
    if (input.alreadyServed.has(key) || input.alreadyServed.has(gameQueueKey('*', userId)))
      continue;
    const g = gameById.get(gameId);
    if (!g || !gameListNeedsYield(g)) continue;
    const created = Date.parse(String(r.created_at ?? ''));
    if (r.status === 'waiting') {
      if (Number.isFinite(created) && input.nowMs - created >= GAME_WAIT_ENTRY_TTL_MS) continue;
    } else if (r.status === 'notified') {
      const touched = Date.parse(String(r.updated_at ?? r.created_at ?? ''));
      if (!Number.isFinite(touched) || input.nowMs - touched >= GAME_WAIT_NOTIFIED_TTL_MS) continue;
    } else {
      continue;
    }
    const tableId = yieldTableForGame(gameId, input.tables);
    if (!tableId) continue;
    seen.add(key);
    const at = out.get(tableId) ?? { count: 0 };
    at.count += 1;
    if (Number.isFinite(created) && (at.oldestMs === undefined || created < at.oldestMs)) {
      at.oldestMs = created;
    }
    out.set(tableId, at);
  }
  return out;
}

export interface GameWaitersRead {
  /** False when any read was incomplete: `byTable` is then EMPTY, never partial. */
  complete: boolean;
  byTable: Map<string, GameWaitersAtTable>;
}

/**
 * Read the game lists and attribute them. Three reads, each paged or chunked
 * like the table-list reads beside it: the live game-list rows (keyset on id),
 * their games, and which of their people are horses. Any short read returns
 * `{ complete: false }` with an empty map.
 */
export async function loadGameWaitersByTable(
  tables: readonly GameWaitTable[],
  alreadyServed: ReadonlySet<string>,
  opts: { source: string; shouldContinue?: () => boolean; nowMs?: number }
): Promise<GameWaitersRead> {
  const closed: GameWaitersRead = { complete: false, byTable: new Map() };
  const page = await fetchAllRows<GameWaitRow & Record<string, unknown>>(
    (cursor, want) => {
      let q = supabase
        .from('cash_game_waitlist')
        .select('id, game_id, user_id, status, created_at, updated_at')
        .in('status', ['waiting', 'notified'])
        .order('id', { ascending: true })
        .limit(want);
      if (cursor) q = q.gt('id', cursor);
      return q;
    },
    {
      label: opts.source + '.GameWaitlist',
      maxRows: 50_000,
      shouldContinue: opts.shouldContinue,
    }
  );
  if (opts.shouldContinue?.() === false || !page.complete) return closed;
  if (page.rows.length === 0) return { complete: true, byTable: new Map() };

  const games = await selectInChunks<GameWaitGame>(
    page.rows.map((r) => r.game_id),
    (batch) =>
      supabase.from('cash_games').select('id, must_move, cluster_mode, enabled').in('id', batch),
    opts.source + '.GameWaitlistGames'
  );
  if (opts.shouldContinue?.() === false || !games.complete) return closed;
  if (!games.rows.some(gameListNeedsYield)) return { complete: true, byTable: new Map() };

  const horses = await selectInChunks<{ id: string }>(
    page.rows.map((r) => r.user_id),
    (batch) => supabase.from('profiles').select('id').eq('is_horse', true).in('id', batch),
    opts.source + '.GameWaitlistHorses'
  );
  if (opts.shouldContinue?.() === false || !horses.complete) return closed;

  return {
    complete: true,
    byTable: attributeGameWaiters({
      rows: page.rows,
      games: games.rows,
      horseIds: new Set(horses.rows.map((h) => String(h.id))),
      tables,
      alreadyServed,
      nowMs: opts.nowMs ?? Date.now(),
    }),
  };
}
