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
  // Optional enrichment populated by getTableWaitlist / getUserWaitlists.
  position?: number;
  tableName?: string;
  joinedAt?: string;
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
}): WaitlistEntry {
  return {
    id: row.id,
    tableId: row.table_id,
    userId: row.user_id,
    status: (row.status as WaitlistStatus) ?? 'waiting',
    createdAt: row.created_at,
    notifiedAt: row.notified_at,
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

  // ── Back-compat shims for existing consumers (TablePage, WaitlistPage) ──

  /** Active waitlist entries for a table, oldest first, with 1-based position. */
  async getTableWaitlist(
    tableId: string
  ): Promise<Array<WaitlistEntry & { position: number; joinedAt: string }>> {
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
    return (data ?? []).map((r, i) => {
      const e = mapRow(r as any);
      return { ...e, position: i + 1, joinedAt: e.createdAt };
    });
  },

  /** Current player's active waitlists, enriched with live position + table name. */
  async getUserWaitlists(
    _userId?: string
  ): Promise<Array<WaitlistEntry & { position: number; tableName: string; joinedAt: string }>> {
    const base = await this.myWaitlists();
    return Promise.all(
      base.map(async (e) => {
        const pos = await this.getPosition(e.tableId);
        const { data: t } = await supabase
          .from('tables')
          .select('name')
          .eq('id', e.tableId)
          .maybeSingle();
        return {
          ...e,
          position: pos?.position ?? 0,
          tableName: (t as { name?: string } | null)?.name || '',
          joinedAt: e.createdAt,
        };
      })
    );
  },

  /** Leave a table waitlist; true if a row was removed. */
  async leave(tableId: string, _userId?: string): Promise<boolean> {
    return (await this.leaveWaitlist(tableId)) > 0;
  },
};

export const waitlistService = WaitlistService;

export default WaitlistService;
