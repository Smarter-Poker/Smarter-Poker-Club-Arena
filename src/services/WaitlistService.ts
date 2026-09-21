/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WAITLIST SERVICE — Cash-Game Table Waitlist (client)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Waitlists apply to CASH GAMES ONLY. Tournament / SNG / Spin players are seated
 * by the game engine (late-reg seating + table spawn/redraw), never by a waitlist.
 *
 * Table backing this service: public.table_waitlist
 *   id          uuid pk
 *   table_id    uuid   (a cash table; rows for tournament tables are never created)
 *   user_id     uuid
 *   created_at  timestamptz  (FIFO ordering key)
 *   notified_at timestamptz  (set when the engine offers an open seat)
 *
 * CANONICAL TABLE: `table_waitlist`, singular.
 *
 * This service used to read and write `table_waitlists` (plural) while the
 * World Hub API route, TableService, WaitlistManager, WaitlistPage and
 * GlobalWaitlistListener all used the singular. Two tables with the same
 * meaning is one table too many: a player joining from the table modal landed
 * in a different queue from the one the seat-offer path reads, so a waitlist
 * could never have paid out. Both were empty (the feature had never run in
 * production), so reconciling cost no data.
 *   status      text   'waiting' | 'notified' | 'seated' | 'cancelled' | 'expired'
 *
 * The engine (server/src/services/supabase.ts → notifyWaitlistSeatOpen) claims the
 * oldest 'waiting' row on a seat-open event, flips it to 'notified', and inserts a
 * 'waitlist_seat_open' notification. This client service handles the player side:
 * joining, leaving, reading position, and listing a player's active waitlists.
 *
 * NOTE ON UI WIRING: the cash-table page (TablePage.tsx) is under active development
 * by another workstream and is intentionally NOT modified by this sweep. This
 * service is fully functional and ready to be imported by that page (or a lobby
 * "Join Waitlist" button) when that work lands.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { readLocalSession } from '../lib/authUtils';
import { reportError, reportWarning } from '../utils/errorReporter';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';

// DB constraint: 'waiting'|'notified'|'seated'|'left'|'cleared'|'expired'. 'cancelled' is NOT valid.
export type WaitlistStatus = 'waiting' | 'notified' | 'seated' | 'left' | 'cleared' | 'expired';

export interface WaitlistEntry {
  id: string;
  tableId: string;
  userId: string;
  status: WaitlistStatus;
  createdAt: string;
  notifiedAt: string | null;
  /**
   * 1-based FIFO position among the *active* rows of the same table (1 = next up).
   * 0 means the player is currently being offered a seat ('notified').
   * Only the list readers (getTableWaitlist / getUserWaitlists) rank rows, so a
   * single-row read (joinWaitlist) leaves this at 0 — use getPosition() there.
   */
  position: number;
  /** Alias of createdAt in ISO form — the UI treats this as "waiting since". */
  joinedAt: string;
  /** Display name of the table, resolved by getUserWaitlists. '' when unresolved. */
  tableName: string;
  /**
   * The table's game and stakes, resolved by getUserWaitlists (2026-09-04).
   * The My Waitlists page used to print "No Limit Hold'em" with an empty
   * stakes string for every row because nothing read them; a PLO 2/5 queue
   * was labelled as Hold'em. '' when unresolved.
   */
  tableVariant: string;
  tableStakes: string;
  /**
   * The table's lobby row, resolved by getUserWaitlists (2026-09-04), so the
   * My Waitlists page can draw the same premium card the lobby draws for
   * this table. Null when unresolved.
   */
  table: WaitlistTableRow | null;
  /** Player display name, resolved by getTableWaitlist (Dan 2026-08-26: "your
   *  name needs to appear on the waiting list"). '' when unresolved. */
  displayName: string;
  /**
   * While status is 'notified', the instant the EXCLUSIVE seat hold lapses
   * (Dan 2026-08-30: sixty seconds to get to the seat). Null on every other
   * status, and on rows written before the column existed. The UI counts down
   * to this; atomic_table_buyin enforces it.
   */
  holdExpiresAt: string | null;
}

/** The columns the lobby's card adapter reads off a cash table. */
export interface WaitlistTableRow {
  id: string;
  name: string;
  game_variant: string;
  small_blind: number;
  big_blind: number;
  min_buy_in: number;
  max_buy_in: number;
  current_players: number;
  max_players: number;
  status: string;
  club_id?: string | null;
  settings?: unknown;
  straddle_enabled?: boolean | null;
  run_it_twice?: boolean | null;
  insurance_enabled?: boolean | null;
  bomb_pot_enabled?: boolean | null;
  is_vip_only?: boolean | null;
  is_featured?: boolean | null;
  label_as_new?: boolean | null;
}

export interface WaitlistPosition {
  /** 1-based position among 'waiting' rows (1 = next up). 0 = notified/seated. */
  position: number;
  status: WaitlistStatus;
  ahead: number;
  entryId: string;
}

const ACTIVE_STATES: WaitlistStatus[] = ['waiting', 'notified'];

function mapRow(
  row: {
    id: string;
    table_id: string;
    user_id: string;
    status: string;
    created_at: string;
    notified_at: string | null;
    hold_expires_at?: string | null;
  },
  extras?: {
    position?: number;
    tableName?: string;
    displayName?: string;
    tableVariant?: string;
    tableStakes?: string;
    table?: WaitlistTableRow | null;
  }
): WaitlistEntry {
  const status = (row.status as WaitlistStatus) ?? 'waiting';
  return {
    id: row.id,
    tableId: row.table_id,
    userId: row.user_id,
    status,
    createdAt: row.created_at,
    notifiedAt: row.notified_at,
    position: extras?.position ?? (status === 'notified' ? 0 : 0),
    joinedAt: row.created_at,
    tableName: extras?.tableName ?? '',
    tableVariant: extras?.tableVariant ?? '',
    tableStakes: extras?.tableStakes ?? '',
    table: extras?.table ?? null,
    displayName: extras?.displayName ?? '',
    // Only meaningful while the offer is live. Undefined (an older row, or a
    // select that did not ask for it) reads as null rather than as "expired",
    // so a missing column can never make the UI claim a hold has lapsed.
    holdExpiresAt: row.hold_expires_at ?? null,
  };
}

/** Only a verified active entry for this request can be reported as joined. */
function validJoinedEntry(
  row: unknown,
  tableId: string,
  userId: string
): row is Parameters<typeof mapRow>[0] {
  if (!row || typeof row !== 'object') return false;
  const entry = row as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    entry.table_id === tableId &&
    entry.user_id === userId &&
    (entry.status === 'waiting' || entry.status === 'notified') &&
    typeof entry.created_at === 'string' &&
    Number.isFinite(Date.parse(entry.created_at))
  );
}

/**
 * 2026-08-21: was `supabase_auth_getUser`, which the pre-push gate blocks
 * (Phase 6 Rule 4) — go through the canonical auth module instead.
 *
 * `readLocalSession()` parses the shared 'smarter-poker-auth' JWT and honours
 * expiry, so this is the same identity the SDK would report, without the
 * network round-trip that getUser() makes on every join. Trusting a
 * client-read id is safe here because it is not what authorises anything:
 * every waitlist door derives its caller from auth.uid(), so a
 * stale or tampered local id gets rejected by the database, not by this
 * function. Kept `async` so the call sites are unchanged.
 */
async function currentUserId(): Promise<string | null> {
  return readLocalSession()?.userId ?? null;
}

export const WaitlistService = {
  /**
   * Join the waitlist for a cash table. Idempotent: if the player already holds an
   * active ('waiting'/'notified') row for this table, that row is returned instead
   * of inserting a duplicate (also enforced by the UNIQUE(table_id,user_id) index).
   * Refuses to enqueue for tournament tables — those are engine-seated.
   */
  async joinWaitlist(tableId: string): Promise<WaitlistEntry | null> {
    const userId = await currentUserId();
    if (!userId || !tableId) return null;
    try {
      const { data, error } = await supabase.rpc('fn_table_waitlist_join', {
        p_table_id: tableId,
      });
      if (error) {
        // Two tabs may cross the door's idempotency read together. The unique
        // index chooses one row; recover only that caller's active row.
        if (error.code === '23505') {
          const { data: raced, error: readError } = await supabase
            .from('table_waitlist')
            .select('id, table_id, user_id, status, created_at, notified_at, hold_expires_at')
            .eq('table_id', tableId)
            .eq('user_id', userId)
            .in('status', ACTIVE_STATES)
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();
          if (!readError && validJoinedEntry(raced, tableId, userId)) return mapRow(raced);
        }
        throw error;
      }
      if (data?.ok === false) return null;
      if (data?.ok !== true || !validJoinedEntry(data.entry, tableId, userId)) {
        throw new Error('Waitlist join returned no valid entry');
      }
      return mapRow(data.entry);
    } catch (error) {
      reportError(error, 'WaitlistService.joinWaitlist', { tableId, userId });
      return null;
    }
  },

  /**
   * Leave the waitlist for a table (cancels all active rows for this user+table).
   *
   * 2026-08-20: this used to return `number`, and returned `0` both when the
   * update FAILED and when there was simply nothing to cancel. The caller could
   * not tell those apart, so the "leave the wait list" modal closed as if it had
   * worked either way — and a player who thought they had left stayed queued and
   * was later offered a seat at a table they had walked away from.
   *
   * `success` is the outcome of the write; `cancelled` is how many rows it
   * touched. Cancelling zero rows is still a success (already left, double-tap).
   */
  async leaveWaitlist(
    tableId: string
  ): Promise<{ success: boolean; cancelled: number; error?: string }> {
    const userId = await currentUserId();
    if (!userId) {
      return { success: false, cancelled: 0, error: 'You are not signed in.' };
    }
    try {
      const { data, error } = await supabase.rpc('fn_table_waitlist_leave', {
        p_table_id: tableId,
      });
      if (error) throw error;
      if (data?.ok !== true || !Number.isSafeInteger(data.cancelled) || data.cancelled < 0) {
        throw new Error('Waitlist leave returned no valid outcome');
      }
      return { success: true, cancelled: data.cancelled };
    } catch (error) {
      reportError(error, 'WaitlistService.leaveWaitlist', { tableId, userId });
      return {
        success: false,
        cancelled: 0,
        error: 'Unable To Leave The Waiting List. Try Again.',
      };
    }
  },

  /**
   * Current FIFO position of the player for a table. position=1 means next in line.
   * A 'notified' player is being offered a seat right now (position 0). Returns null
   * if the player holds no active row for the table.
   */
  async getPosition(tableId: string): Promise<WaitlistPosition | null> {
    const userId = await currentUserId();
    if (!userId) return null;

    const { data: mine, error: mineErr } = await supabase
      .from('table_waitlist')
      .select('id, status, created_at')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .in('status', ACTIVE_STATES)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (mineErr) {
      reportError(mineErr, 'WaitlistService.getPosition.mine', { tableId });
      return null;
    }
    if (!mine) return null;

    const status = (mine as any).status as WaitlistStatus;
    if (status === 'notified') {
      return { position: 0, status, ahead: 0, entryId: (mine as any).id };
    }

    // Count 'waiting' rows created strictly before mine.
    const { count, error: cntErr } = await supabase
      .from('table_waitlist')
      .select('id', { count: 'exact', head: true })
      .eq('table_id', tableId)
      .eq('status', 'waiting')
      .lt('created_at', (mine as any).created_at);
    if (cntErr) {
      reportError(cntErr, 'WaitlistService.getPosition.count', { tableId });
      return null;
    }
    const ahead = count ?? 0;
    return { position: ahead + 1, status, ahead, entryId: (mine as any).id };
  },

  /**
   * All active waitlist entries for the current player, oldest first. Useful for a
   * lobby-level "you are waitlisted at N tables" indicator.
   */
  async myWaitlists(): Promise<WaitlistEntry[]> {
    const userId = await currentUserId();
    if (!userId) return [];
    const { data, error } = await supabase
      .from('table_waitlist')
      .select('id, table_id, user_id, status, created_at, notified_at, hold_expires_at')
      .eq('user_id', userId)
      .in('status', ACTIVE_STATES)
      .order('created_at', { ascending: true });
    if (error) {
      reportError(error, 'WaitlistService.myWaitlists', { userId });
      return [];
    }
    return (data ?? []).map((r) => mapRow(r as any));
  },

  /**
   * How many players are waiting at EACH of these tables, in one round trip.
   *
   * Added 2026-08-25 so the lobby can say "Waitlist 3" instead of "Full".
   * getTableWaitlist answers for one table and the lobby has up to 46, so
   * calling it per row would be 46 requests for a badge. This is one `in`
   * query returning only the ids.
   *
   * Returns NULL on failure rather than an empty map (ITEM E audit,
   * 2026-08-26): an empty map fed `cashStatus(t, 0)`, so a full table with a
   * real queue badged as plain 'Full' whenever this read failed. The caller
   * keeps its PREVIOUS counts on null — stale beats wrong-empty. A table
   * must still list if the badge cannot be fetched, which is the caller's
   * job, not a reason to lie about the count.
   */
  async countsFor(tableIds: string[]): Promise<Map<string, number> | null> {
    const counts = new Map<string, number>();
    if (!tableIds.length) return counts;
    try {
      const { data, error } = await supabase
        .from('table_waitlist')
        .select('table_id')
        .in('table_id', tableIds)
        .eq('status', 'waiting');
      if (error || !data) {
        if (error) reportError(error, 'WaitlistService.countsFor');
        return null;
      }
      for (const row of data as { table_id: string }[]) {
        counts.set(row.table_id, (counts.get(row.table_id) ?? 0) + 1);
      }
    } catch (e) {
      /* a badge is not worth an exception — but it is worth a report */
      reportError(e, 'WaitlistService.countsFor');
      return null;
    }
    return counts;
  },

  /**
   * Every ACTIVE entry on a table, oldest first, each ranked with its 1-based FIFO
   * position. A 'notified' row (being offered a seat right now) ranks 0 and does
   * not consume a position slot. Used by the table page to show who is waiting and
   * to decide whether a horse should yield its seat.
   */

  /**
   * Returns NULL when the read FAILED — "we could not find out" and "nobody
   * is waiting" are different answers, and the panel renders them differently
   * ('-' vs '0'). Returning [] here collapsed a failed query into "Waiting 0"
   * beside a Join Waitlist button: a promise that you are first in line,
   * made on a guess (ITEM E audit, 2026-08-26 — the named house bug shape;
   * the panel's own .catch could never see it because a Supabase builder only
   * REJECTS on transport failures, not query errors).
   */
  async getTableWaitlist(tableId: string): Promise<WaitlistEntry[] | null> {
    if (!tableId) return [];
    const { data, error } = await supabase
      .from('table_waitlist')
      .select('id, table_id, user_id, status, created_at, notified_at, hold_expires_at')
      .eq('table_id', tableId)
      .in('status', ACTIVE_STATES)
      .order('created_at', { ascending: true });
    if (error) {
      reportError(error, 'WaitlistService.getTableWaitlist', { tableId });
      return null;
    }
    /* Dan 2026-08-26: "if you join the wait list, your name needs to appear
       on the waiting list." Resolve display names in one batch — the same
       profiles join the table-page modal already does, moved here so every
       caller gets names instead of anonymous 'Player' rows. Best-effort: a
       failed lookup degrades to '' rather than hiding the queue. */
    const rows = (data ?? []) as any[];
    const names = new Map<string, string>();
    const ids = Array.from(new Set(rows.map((r) => r.user_id).filter(Boolean)));
    if (ids.length > 0) {
      const { data: profiles, error: profErr } = await supabase
        .from('profiles')
        .select(`id, ${PLAYER_NAME_COLUMNS}`)
        .in('id', ids);
      if (profErr) {
        reportWarning(profErr.message, 'WaitlistService.getTableWaitlist.profiles', { tableId });
      }
      for (const p of (profiles ?? []) as any[]) {
        names.set(p.id, playerDisplayName(p));
      }
    }
    let rank = 0;
    return rows.map((row) => {
      const notified = row.status === 'notified';
      if (!notified) rank += 1;
      return mapRow(row, {
        position: notified ? 0 : rank,
        displayName: names.get(row.user_id) ?? '',
      });
    });
  },

  /**
   * All ACTIVE waitlist entries for a player, ranked and with the table's display
   * name resolved, for the "My Waitlists" page. `userId` defaults to the signed-in
   * user. Ranking needs the other players' rows, so this fetches every active row
   * on each of the player's tables in one query and ranks locally — one round-trip
   * for the ranking regardless of how many tables the player is queued at.
   */
  async getUserWaitlists(userId?: string): Promise<WaitlistEntry[]> {
    const uid = userId ?? (await currentUserId());
    if (!uid) return [];

    const { data: mine, error: mineErr } = await supabase
      .from('table_waitlist')
      .select('id, table_id, user_id, status, created_at, notified_at, hold_expires_at')
      .eq('user_id', uid)
      .in('status', ACTIVE_STATES)
      .order('created_at', { ascending: true });
    if (mineErr) {
      reportError(mineErr, 'WaitlistService.getUserWaitlists', { userId: uid });
      return [];
    }
    const rows = (mine ?? []) as any[];
    if (rows.length === 0) return [];

    const tableIds = Array.from(new Set(rows.map((r) => r.table_id).filter(Boolean)));

    // Peers on the same tables → local FIFO ranking.
    const { data: peers, error: peersErr } = await supabase
      .from('table_waitlist')
      .select('id, table_id, status, created_at')
      .in('table_id', tableIds)
      .in('status', ACTIVE_STATES)
      .order('created_at', { ascending: true });
    if (peersErr) {
      reportError(peersErr, 'WaitlistService.getUserWaitlists.peers', { userId: uid });
    }
    const rankById = new Map<string, number>();
    const nextRank = new Map<string, number>();
    for (const p of (peers ?? []) as any[]) {
      if (p.status === 'notified') {
        rankById.set(p.id, 0);
        continue;
      }
      const r = (nextRank.get(p.table_id) ?? 0) + 1;
      nextRank.set(p.table_id, r);
      rankById.set(p.id, r);
    }

    // The tables themselves: name, game and stakes for the list, and the
    // lobby row so the page can draw the table's own card.
    const tableById = new Map<string, WaitlistTableRow>();
    const { data: tables, error: tablesErr } = await supabase
      .from('tables')
      .select(
        'id, name, game_variant, small_blind, big_blind, min_buy_in, max_buy_in, current_players, max_players, status, club_id, settings, straddle_enabled, run_it_twice, insurance_enabled, bomb_pot_enabled, is_vip_only, is_featured, label_as_new'
      )
      .in('id', tableIds);
    if (tablesErr) {
      reportError(tablesErr, 'WaitlistService.getUserWaitlists.tables', { userId: uid });
    }
    for (const t of (tables ?? []) as WaitlistTableRow[]) {
      if (t?.id) tableById.set(t.id, t);
    }

    return rows.map((r) => {
      const t = tableById.get(r.table_id) ?? null;
      const sb = Number(t?.small_blind) || 0;
      const bb = Number(t?.big_blind) || 0;
      return mapRow(r, {
        position: rankById.get(r.id) ?? (r.status === 'notified' ? 0 : 1),
        tableName: t?.name || 'Table',
        tableVariant: String(t?.game_variant ?? ''),
        tableStakes: sb > 0 && bb > 0 ? `${sb}/${bb}` : '',
        table: t,
      });
    });
  },

  /**
   * Leave a table's waitlist. Boolean-returning wrapper over leaveWaitlist for the
   * "My Waitlists" page, which only needs to know whether the row went away.
   * `userId` is accepted for call-site symmetry; cancellation is always scoped to
   * the signed-in user by the database door; a mismatched id is refused here.
   */
  async leave(tableId: string, userId?: string): Promise<boolean> {
    if (!tableId) return false;
    const current = await currentUserId();
    if (!current || (userId && userId !== current)) return false;
    return (await WaitlistService.leaveWaitlist(tableId)).success;
  },
};

// Lowercase alias — TablePage imports { waitlistService }
export const waitlistService = WaitlistService;

export default WaitlistService;
