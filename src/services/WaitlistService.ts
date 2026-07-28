/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WAITLIST SERVICE — Cash-Game Table Waitlist (client)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Waitlists apply to CASH GAMES ONLY. Tournament / SNG / Spin players are seated
 * by the game engine (late-reg seating + table spawn/redraw), never by a waitlist.
 *
 * Table backing this service: public.table_waitlists
 *   id          uuid pk
 *   table_id    uuid   (a cash table; rows for tournament tables are never created)
 *   user_id     uuid
 *   created_at  timestamptz  (FIFO ordering key)
 *   notified_at timestamptz  (set when the engine offers an open seat)
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
import { reportError, reportWarning } from '../utils/errorReporter';

export type WaitlistStatus = 'waiting' | 'notified' | 'seated' | 'cancelled' | 'expired';

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
}

export interface WaitlistPosition {
  /** 1-based position among 'waiting' rows (1 = next up). 0 = notified/seated. */
  position: number;
  status: WaitlistStatus;
  ahead: number;
  entryId: string;
}

const ACTIVE_STATES: WaitlistStatus[] = ['waiting', 'notified'];

function mapRow(row: {
  id: string;
  table_id: string;
  user_id: string;
  status: string;
  created_at: string;
  notified_at: string | null;
}, extras?: { position?: number; tableName?: string }): WaitlistEntry {
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
  };
}

async function currentUserId(): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user?.id) return null;
  return data.user.id;
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
    if (!userId) {
      reportWarning(
        'joinWaitlist called with no authenticated user',
        'WaitlistService.joinWaitlist',
        { tableId }
      );
      return null;
    }

    // Guard: waitlists are cash-only. Never enqueue for a tournament table.
    const { data: tableRow, error: tableErr } = await supabase
      .from('tables')
      .select('id, tournament_id')
      .eq('id', tableId)
      .maybeSingle();
    if (tableErr) {
      reportError(tableErr, 'WaitlistService.joinWaitlist.tableLookup', { tableId });
      return null;
    }
    if (!tableRow) {
      reportWarning('joinWaitlist for unknown table', 'WaitlistService.joinWaitlist', { tableId });
      return null;
    }
    if ((tableRow as { tournament_id?: string | null }).tournament_id) {
      reportWarning(
        'Refusing to waitlist a tournament table (engine-seated)',
        'WaitlistService.joinWaitlist',
        { tableId }
      );
      return null;
    }

    // Return existing active row if present (idempotent join).
    const { data: existing } = await supabase
      .from('table_waitlists')
      .select('id, table_id, user_id, status, created_at, notified_at')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .in('status', ACTIVE_STATES)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (existing) return mapRow(existing as any);

    const { data: inserted, error: insErr } = await supabase
      .from('table_waitlists')
      .insert({ table_id: tableId, user_id: userId, status: 'waiting' })
      .select('id, table_id, user_id, status, created_at, notified_at')
      .single();
    if (insErr) {
      // Unique-violation → a concurrent join won the race; fetch and return it.
      const { data: raced } = await supabase
        .from('table_waitlists')
        .select('id, table_id, user_id, status, created_at, notified_at')
        .eq('table_id', tableId)
        .eq('user_id', userId)
        .in('status', ACTIVE_STATES)
        .limit(1)
        .maybeSingle();
      if (raced) return mapRow(raced as any);
      reportError(insErr, 'WaitlistService.joinWaitlist.insert', { tableId, userId });
      return null;
    }
    return mapRow(inserted as any);
  },

  /**
   * Leave the waitlist for a table (cancels all active rows for this user+table).
   * Returns the number of rows cancelled.
   */
  async leaveWaitlist(tableId: string): Promise<number> {
    const userId = await currentUserId();
    if (!userId) return 0;
    const { data, error } = await supabase
      .from('table_waitlists')
      .update({ status: 'cancelled' })
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .in('status', ACTIVE_STATES)
      .select('id');
    if (error) {
      reportError(error, 'WaitlistService.leaveWaitlist', { tableId, userId });
      return 0;
    }
    return data?.length ?? 0;
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
      .from('table_waitlists')
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
      .from('table_waitlists')
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
      .from('table_waitlists')
      .select('id, table_id, user_id, status, created_at, notified_at')
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
   * Every ACTIVE entry on a table, oldest first, each ranked with its 1-based FIFO
   * position. A 'notified' row (being offered a seat right now) ranks 0 and does
   * not consume a position slot. Used by the table page to show who is waiting and
   * to decide whether a horse should yield its seat.
   */
  async getTableWaitlist(tableId: string): Promise<WaitlistEntry[]> {
    if (!tableId) return [];
    const { data, error } = await supabase
      .from('table_waitlists')
      .select('id, table_id, user_id, status, created_at, notified_at')
      .eq('table_id', tableId)
      .in('status', ACTIVE_STATES)
      .order('created_at', { ascending: true });
    if (error) {
      reportError(error, 'WaitlistService.getTableWaitlist', { tableId });
      return [];
    }
    let rank = 0;
    return (data ?? []).map((r) => {
      const row = r as any;
      const notified = row.status === 'notified';
      if (!notified) rank += 1;
      return mapRow(row, { position: notified ? 0 : rank });
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
      .from('table_waitlists')
      .select('id, table_id, user_id, status, created_at, notified_at')
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
      .from('table_waitlists')
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

    // Table display names.
    const nameById = new Map<string, string>();
    const { data: tables, error: tablesErr } = await supabase
      .from('tables')
      .select('id, name')
      .in('id', tableIds);
    if (tablesErr) {
      reportError(tablesErr, 'WaitlistService.getUserWaitlists.tables', { userId: uid });
    }
    for (const t of (tables ?? []) as any[]) {
      if (t?.id) nameById.set(t.id, t.name ?? '');
    }

    return rows.map((r) =>
      mapRow(r, {
        position: rankById.get(r.id) ?? (r.status === 'notified' ? 0 : 1),
        tableName: nameById.get(r.table_id) || 'Table',
      })
    );
  },

  /**
   * Leave a table's waitlist. Boolean-returning wrapper over leaveWaitlist for the
   * "My Waitlists" page, which only needs to know whether the row went away.
   * `userId` is accepted for call-site symmetry; cancellation is always scoped to
   * the signed-in user by RLS, so a mismatched id simply cancels nothing.
   */
  async leave(tableId: string, userId?: string): Promise<boolean> {
    if (!tableId) return false;
    const uid = userId ?? (await currentUserId());
    if (!uid) return false;
    const { data, error } = await supabase
      .from('table_waitlists')
      .update({ status: 'cancelled' })
      .eq('table_id', tableId)
      .eq('user_id', uid)
      .in('status', ACTIVE_STATES)
      .select('id');
    if (error) {
      reportError(error, 'WaitlistService.leave', { tableId, userId: uid });
      return false;
    }
    return (data?.length ?? 0) > 0;
  },
};

// Lowercase alias — TablePage imports { waitlistService }
export const waitlistService = WaitlistService;

export default WaitlistService;
