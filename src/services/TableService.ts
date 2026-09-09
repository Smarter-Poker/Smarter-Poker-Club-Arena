/**
 * ♠ CLUB ARENA — Table Service
 * Manages poker tables and game sessions
 */

import { supabase } from '../lib/supabase';
import { engineChannelClient } from './EngineStateClient';
import type { PokerTable, TableSettings, HandState } from '../types/database.types';
import { masterBus } from '../core/MasterBus';

import { resolveClubUUID, isUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';
import { PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { reportError } from '../utils/errorReporter';

/**
 * The governed command gateway, loaded on demand.
 *
 * TableService sits in the eager app shell (App -> TournamentRankingHost ->
 * TableService), so a static import put the whole operator command gateway —
 * receipts, contracts, idempotency — into the entry bundle that every player
 * downloads before first paint. Closing, pausing and resuming a table are
 * operator actions behind an authorization check; a player who never performs
 * one never needs the module. Every call site below keeps its exact shape, so
 * the lifecycle-authority law still reads the same routed calls.
 */
async function managementGateway() {
  const { gameManagementService } = await import('./GameManagementService');
  return gameManagementService;
}

// AUDIT M17: the admin money RPCs return a `reason` for ordinary refusals rather
// than raising, so the UI can tell "you are not an admin here" apart from "the
// database is down". An unmapped reason is a contract change and should read as
// one instead of collapsing into a generic failure.
const ADMIN_ACTION_REASON_TEXT: Record<string, string> = {
  table_not_found: 'That table no longer exists',
  not_authorized: 'You do not have admin rights on this club',
  not_seated: 'That player is no longer seated at this table',
  tournament_not_found: 'That tournament no longer exists',
  tournament_already_started: 'Players cannot be removed after the tournament has started',
  not_registered: 'That player is not registered for this tournament',
};

export function adminActionReasonText(reason: string | undefined): string {
  return (
    ADMIN_ACTION_REASON_TEXT[reason ?? ''] ??
    `Action refused by the server (${reason ?? 'unknown'})`
  );
}

class TableService {
  // ═══════════════════════════════════════════════════════════════════════════════
  // Table Operations
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Get all tables for a club
   */
  async getClubTables(clubId: string): Promise<PokerTable[]> {
    // Resolve integer club_id to UUID for FK query
    const resolvedId = await resolveClubUUID(clubId);

    /* THE RESOLVER RETURNS ITS INPUT WHEN IT CANNOT RESOLVE - an RLS refusal,
       a PostgREST 400 and a dropped connection all land there - so `resolvedId`
       can be a slug. Below it is CONCATENATED into a PostgREST `or=`
       expression, where a slug containing a comma, a bracket or a quote splits
       the expression and returns 400; a clean slug still reaches a uuid column
       and errors with 22P02. Either way the lobby comes back empty, which is
       indistinguishable from a club with no games. Refuse the query instead of
       issuing one that is guaranteed to fail. */
    if (!isUUID(resolvedId)) {
      reportError(
        new Error(`getClubTables: club id did not resolve to a UUID (${clubId})`),
        'TableService.getClubTables_unresolved'
      );
      throw new Error('That Club Could Not Be Resolved');
    }

    // UNION LAW (2026-08-19, Dan): a club inside a union lists the UNION's
    // games (all hosted by the union house club, stamped with union_id) plus
    // this club's OWN private tables. Sibling clubs' private games never show.
    let unionId: string | null = null;
    try {
      const { data: ucRow, error: ucErr } = await supabase
        .from('union_clubs')
        .select('union_id')
        .eq('club_id', resolvedId)
        .limit(1)
        .maybeSingle();
      unionId = ucRow?.union_id ?? null;
      /* ROUND 9 (2026-08-29): the discarded error here demoted a union club
         to standalone on a transient failure - the union's whole cash-game
         board vanished, the exact "games disappear" symptom this sweep has
         chased twice. TournamentService caches the resolved union scope in
         sessionStorage under this same key for the same reason; a failed
         read consults it, and only a SUCCESSFUL empty read concludes
         standalone. */
      const unionCacheKey = `ca_union_of_${resolvedId}`;
      if (!unionId && ucErr) {
        reportError(ucErr, 'TableService.getClubTables_union_read_failed', {
          clubId: resolvedId,
        });
        try {
          unionId = sessionStorage.getItem(unionCacheKey);
        } catch {
          /* storage unavailable */
        }
      }
      try {
        if (unionId) sessionStorage.setItem(unionCacheKey, unionId);
      } catch {
        /* storage unavailable */
      }
    } catch {
      /* fail-open: standalone club behavior */
    }

    let query = supabase
      .from('tables')
      .select(
        'id, club_id, union_id, name, game_type, game_variant, stakes, small_blind, big_blind, min_buy_in, max_buy_in, max_players, current_players, status, settings, created_at'
      );
    if (unionId) {
      /* Both ids are verified UUIDs at this point - `resolvedId` by the guard
         at the top, `unionId` by the check here - so nothing user-controlled
         reaches the `or=` grammar. */
      if (!isUUID(unionId)) {
        reportError(
          new Error(`getClubTables: union id is not a UUID (${unionId})`),
          'TableService.getClubTables_bad_union'
        );
        unionId = null;
      }
    }
    if (unionId) {
      query = query.or(`union_id.eq.${unionId},and(club_id.eq.${resolvedId},is_private.eq.true)`);
    } else {
      query = query.eq('club_id', resolvedId);
    }
    const { data, error } = await query
      .eq('is_deleted', false)
      .neq('status', 'closed')
      // Tournament tables are not cash games — they were being listed as
      // joinable ring games in club lobbies.
      .is('tournament_id', null)
      /* A LIVE GAME MUST NEVER BE TRUNCATED AWAY (2026-09-02).
         This ordered by created_at alone under a 200-row cap, so the lobby
         showed the 200 NEWEST tables rather than the 200 most worth seeing.
         Measured on Deep Stack Society, which carries 1,058 open cash tables:
         of its 51 RUNNING tables only 10 survived the cut, so 41 games with
         real players dealing real hands were invisible and every filter tab
         read "0/x OPEN" down the page. The club was dealing 676 cash hands a
         quarter-hour at the time.
         current_players is maintained exactly (verified against table_seats:
         0 wrong across 1,131 open tables), so occupancy first puts every
         occupied table above every empty one and the cap can then only ever
         trim empties. created_at stays as the tiebreak among equals. */
      .order('current_players', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(QUERY_LIMITS.LIST);

    if (error) {
      /* NOT `return []`. An empty array here is the same answer this method
         gives for a club that genuinely has no games, so a 400, an RLS
         refusal or a dropped connection rendered as "no games in this club"
         with nothing to retry - the same reasoning getSeatedPlayers already
         records for its own throw. The caller can show a failure. */
      reportError(error, 'TableService.getClubTables');
      throw error;
    }
    return data || [];
  }

  /**
   * Get all active tables across the platform (for lobby)
   */
  async getActiveTables(limit = 50): Promise<PokerTable[]> {
    const { data, error } = await supabase
      .from('tables')
      .select(
        'id, club_id, name, game_type, game_variant, stakes, small_blind, big_blind, min_buy_in, max_buy_in, max_players, current_players, status, settings, created_at'
      )
      .eq('is_deleted', false)
      .neq('status', 'closed')
      .is('tournament_id', null) // Exclude tournament tables from cash lobby
      // A private club game must never surface in a platform-wide lobby.
      .or('is_private.is.null,is_private.eq.false')
      .order('current_players', { ascending: false })
      .limit(limit);

    if (error) {
      reportError(error, 'TableService.getActiveTables');
      return [];
    }
    return data || [];
  }

  /**
   * Get all active tables in a union
   */
  async getUnionTables(unionId: string): Promise<PokerTable[]> {
    // Union-owned cash tables. Private club games carry union_id = NULL, so
    // .eq('union_id', ...) already excludes them.
    //
    // REGRESSION FIX 2026-08-19: tournament tables must be excluded here.
    // Union ownership is now stamped on every non-private game a union club
    // creates — including the per-tournament tables the engine spawns — so
    // without this filter the union cash lobby filled up with tournament
    // tables (31 open ones at the time of the fix). This method never had the
    // filter; it simply never mattered before union_id was stamped on them.
    const { data, error } = await supabase
      .from('tables')
      .select(
        'id, club_id, union_id, name, game_type, game_variant, stakes, small_blind, big_blind, min_buy_in, max_buy_in, max_players, current_players, status, settings, created_at'
      )
      .eq('union_id', unionId)
      .eq('is_deleted', false)
      .neq('status', 'closed')
      .is('tournament_id', null)
      // Occupancy first, same rule and same reason as getClubTables above.
      .order('current_players', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(QUERY_LIMITS.LIST);

    if (error) {
      reportError(error, 'TableService.getUnionTables');
      return [];
    }
    return data || [];
  }

  /**
   * Get a single table
   */
  async getTable(tableId: string): Promise<PokerTable | null> {
    const { data, error } = await supabase
      .from('tables')
      .select(
        'id, club_id, name, game_type, game_variant, stakes, small_blind, big_blind, min_buy_in, max_buy_in, max_players, current_players, status, settings, tournament_id, is_deleted, created_at'
      )
      .eq('id', tableId)
      .maybeSingle();

    if (error) {
      reportError(error, 'TableService.getTable');
      return null;
    }
    return data;
  }

  /* createTable was DELETED 2026-08-27.
     Its only caller was CreateTableModal, which had zero imports anywhere -
     the entire modal path was unreachable dead code, discovered in the
     create-flow audit (.agent/audits/2026-08-27-create-flow-full-audit.md).
     The one live cash-table creation path is TableConfigPage.buildTableData,
     which maps every control onto the exact columns the engine reads. If a
     second programmatic creator is ever needed, build it against that column
     contract - not a settings JSONB blob. */

  /**
   * Update table player count
   */
  async updatePlayerCount(tableId: string, count: number): Promise<void> {
    const { error } = await supabase
      .from('tables')
      .update({ current_players: count })
      .eq('id', tableId);

    if (error) {
      reportError(error, 'TableService.updatePlayerCount');
    }
  }

  /**
   * Compatibility entry point for the legacy operations panel. Closing never
   * evicts or cashes out seated players: the authoritative command refuses
   * until every active seat has left through the normal engine-owned path.
   */
  async closeTable(tableId: string): Promise<void> {
    const gameManagementService = await managementGateway();
    await gameManagementService.close('table', tableId);
  }

  /**
   * Leave a table - handles full cleanup:
   * 1. Returns remaining chips to player wallet
   * 2. Clears the seat
   * 3. Updates player count
   * 4. Notifies next in waitlist
   */
  async leaveTable(
    tableId: string,
    seatNumber: number,
    userId: string
  ): Promise<{ success: boolean; chipsReturned: number; deferred?: boolean; error?: string }> {
    // Resolve and persist the original occupancy before contacting the engine.
    // A stale UI seat number must never retarget an interrupted cashout.
    void seatNumber;
    const { leaveSeatWithIntent } = await import('./SeatLeaveIntent');
    const result = await leaveSeatWithIntent(tableId, userId);
    if (!result.success) return result;
    if (!result.deferred) {
      masterBus.emit('BALANCE_UPDATED', { source: 'table_leave_cashout', userId });
    }
    // Activity is presentation history. Failure here cannot negate an already
    // committed cashout or authorize a second financial mutation.
    const confirmedAmount = result.deferred ? null : result.chipsReturned;
    try {
      const { error } = await supabase.from('table_activity').insert({
        table_id: tableId,
        user_id: userId,
        action: 'leave',
        chips_cashed_out: confirmedAmount,
        metadata: {
          chips_cashed_out: confirmedAmount,
          cashout_pending: result.deferred === true,
        },
      });
      if (error) reportError(error, 'TableService.leaveActivity');
    } catch (error) {
      reportError(error, 'TableService.leaveActivity');
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Real-time Subscriptions
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to table metadata updates (player count, status changes).
   *
   * Phase 2 (2026-05-18): Migrated from Supabase Realtime postgres_changes
   * to the Hetzner engine WebSocket TABLE_META_UPDATE message. Returns an
   * unsubscribe function matching the old interface.
   */
  subscribeToTable(tableId: string, callback: (table: PokerTable) => void): () => void {
    const unsubscribe = engineChannelClient.onTableMetaUpdate((msg) => {
      if (msg.tableId !== tableId) return;
      callback(msg.table as PokerTable);
    });
    return unsubscribe;
  }

  /**
   * Phase 1.1 PR-5 (NO-GO-2): subscribeToHand DELETED.
   * Game state is consumed directly by TablePage via
   * src/hooks/useEngineTableState.ts (engine WebSocket, not Supabase
   * Realtime). Callers must migrate off this helper.
   */

  // ═══════════════════════════════════════════════════════════════════════════════
  // Statistics
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Get average pot size for a table.
   *
   * NULL means "could not find out" — a failed read and a table with no
   * hands both used to answer `0`, so the signature lied and the one caller
   * (GameLobbyPanel) was typed `number | null` against a function that could
   * never return null; only its `> 0` display gate kept "Avg Pot 0" off the
   * panel on a query failure (ITEM E audit, 2026-08-26). Type and code agree
   * now: null = unknown/no data, a number = a real average.
   */
  async getAveragePot(tableId: string): Promise<number | null> {
    // 2026-08-19: read `hands`, a table with ZERO rows ever, so this always
    // returned 0 no matter how the table was playing. hand_history is the live
    // ledger the engine writes, and carries pot_size directly.
    const { data, error } = await supabase
      .from('hand_history')
      .select('pot_size')
      .eq('table_id', tableId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      reportError(error, 'TableService.getAveragePot', { tableId });
      return null;
    }
    if (!data?.length) return null;

    const total = data.reduce((sum, h) => sum + (h.pot_size || 0), 0);
    return Math.round(total / data.length);
  }

  /**
   * Get waiting list count
   */
  async getWaitlistCount(tableId: string): Promise<number> {
    const { count, error } = await supabase
      .from('table_waitlist')
      .select('*', { count: 'exact', head: true })
      .eq('table_id', tableId);

    if (error) return 0;
    return count || 0;
  }
  // ═══════════════════════════════════════════════════════════════════════════════
  // Admin Operations — Club owner/admin table controls
  // ═══════════════════════════════════════════════════════════════════════════════

  /** Pause through the engine so the displayed status matches actual dealing. */
  async pauseTable(tableId: string): Promise<boolean> {
    try {
      const gameManagementService = await managementGateway();
      await gameManagementService.pause(tableId);
      return true;
    } catch (error) {
      reportError(error, 'TableService.pauseTable', { tableId });
      return false;
    }
  }

  /** Resume through the engine so play actually restarts. */
  async resumeTable(tableId: string): Promise<boolean> {
    try {
      const gameManagementService = await managementGateway();
      await gameManagementService.resume(tableId);
      return true;
    } catch (error) {
      reportError(error, 'TableService.resumeTable', { tableId });
      return false;
    }
  }

  /**
   * Compatibility entry point for old callers. Tables are closed, never
   * client-deleted, and the database refuses while any seat remains occupied.
   */
  async deleteTable(tableId: string, _clubId: string, _userId?: string): Promise<boolean> {
    try {
      const gameManagementService = await managementGateway();
      await gameManagementService.close('table', tableId);
      return true;
    } catch (error) {
      reportError(error, 'TableService.deleteTable');
      return false;
    }
  }

  /**
   * Kick a player from a table — refunds their stack and vacates the seat.
   *
   * AUDIT M17: the old version read the seat, credited `seat.stack` through
   * `atomic_credit_wallet_and_log`, then marked the seat left — three round
   * trips, of which the credit was always 42501 (wallets has no UPDATE policy)
   * and the seat UPDATE always matched zero rows (table_seats is service-role
   * write-only). It returned false when the credit failed, but
   * TableOperationsPanel discarded that boolean, so an admin saw no error at
   * all while nothing whatsoever happened.
   *
   * `fn_admin_kick_player` does the whole thing in one transaction and derives
   * the refund from the seat row itself, so a kick can never pay out more than
   * the player actually had. It is idempotent on the occupancy row id — the
   * same key shape the engine's markSeatAsLeft uses — so the two paths cannot
   * double-pay each other if they race.
   */
  async kickPlayer(tableId: string, userId: string, reason?: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('fn_admin_kick_player', {
      p_table_id: tableId,
      p_user_id: userId,
      p_reason: reason ?? null,
    });

    if (error) {
      reportError(error, 'TableService.kickPlayer', { tableId, userId });
      throw new Error('Could not kick the player');
    }

    const res = data as { ok: boolean; reason?: string; refunded?: number } | null;

    // Throw rather than return false. The previous signature let the one caller
    // ignore the outcome; an exception cannot be ignored by accident.
    if (!res?.ok) {
      throw new Error(adminActionReasonText(res?.reason));
    }

    if ((res.refunded ?? 0) > 0) {
      masterBus.emit('BALANCE_UPDATED', { source: 'table_kick_cashout', userId });
    }

    // The seat count is recomputed here rather than in the RPC: it is display
    // state, and a stale count is a cosmetic problem, not a money one.
    const { count, error: countErr } = await supabase
      .from('table_seats')
      .select('id', { count: 'exact', head: true })
      .eq('table_id', tableId)
      .is('left_at', null);

    if (!countErr) {
      await supabase
        .from('tables')
        .update({ current_players: count ?? 0 })
        .eq('id', tableId);
    } else {
      reportError(countErr, 'TableService.recountAfterKick');
    }

    return true;
  }

  /**
   * Get seated players for a table (admin view).
   *
   * This returned 400 on every call. Two independent faults, the second hidden
   * behind the first:
   *   1. PGRST200 — `table_seats.user_id` had no FK to profiles, so the embed
   *      could not resolve. Added 2026-08-22 as fk_table_seats_user_id_profiles.
   *   2. 42703 — there is no `created_at` on table_seats. The column is
   *      `joined_at`. Only visible once the embed started resolving.
   * `if (error) { reportError; return [] }` meant the admin seat list was
   * simply always empty.
   */
  /**
   * THE TABLE A TOURNAMENT IS ACTUALLY ON (2026-08-28).
   *
   * Four client sites used to answer this with "newest non-closed table",
   * which is the wrong answer whenever a duplicate exists: the players sit on
   * the FIRST table and the empty duplicate is NEWER (measured 2026-08-24 —
   * 12 of 28 blocked seat-first games had an empty table outranking the one
   * holding every player). The database already owns the canonical election —
   * fn_tournament_primary_table, occupancy first, oldest to break the tie,
   * identical to the engine's own choice — so the client asks it and can
   * never disagree with the engine about which table is the game.
   *
   * The newest-non-closed query stays as the fallback for an RPC outage:
   * a degraded answer beats a dead end, and with one live table per game
   * (the normal case) the two answers are identical.
   */
  async resolveTournamentLiveTable(tournamentId: string): Promise<string | null> {
    const { data, error } = await supabase.rpc('fn_tournament_primary_table', {
      p_tournament_id: tournamentId,
    });
    if (!error && typeof data === 'string' && data.length > 0) return data;
    if (error) reportError(error, 'TableService.resolveTournamentLiveTable_rpc');
    else
      /* THE SILENT CASE, WHICH IS THE DANGEROUS ONE (2026-08-28 audit).
         An RPC that SUCCEEDS and returns nothing is not the outage this
         fallback was written for — it means the election found no eligible
         table, and every caller then takes the newest-non-closed answer
         while believing it holds the occupancy-elected one. That is the
         precise disagreement with the engine this function exists to make
         impossible, and it was reaching production with no signal at all.
         Still fall through (a degraded answer beats a dead end for the
         player in front of us), but never quietly. */
      reportError(
        new Error(
          `fn_tournament_primary_table elected no table for tournament ${tournamentId}; falling back to newest-non-closed`
        ),
        'TableService.resolveTournamentLiveTable_rpc_empty'
      );

    const { data: tbls, error: qErr } = await supabase
      .from('tables')
      .select('id, created_at')
      .eq('tournament_id', tournamentId)
      .neq('status', 'closed')
      .order('created_at', { ascending: false })
      .limit(1);
    if (qErr) {
      reportError(qErr, 'TableService.resolveTournamentLiveTable_fallback');
      return null;
    }
    return ((tbls || [])[0]?.id as string | undefined) ?? null;
  }

  async getSeatedPlayers(tableId: string) {
    /* is_horse / horse_profile are NOT in this profiles read (Dan 2026-09-03).
       `authenticated` has no column grant on either - deliberately, per the
       platform lockdown and the "a horse is named only to those entitled" law
       - so a profiles embed that named them made PostgREST refuse the WHOLE
       request with 42501/403, and supabase-js RESOLVES on that with
       { data: null }. The felt then rebuilt every seat as "Player" with the
       monogram avatar until the engine snapshot arrived: exactly the "generic
       block letters" Dan reported. horse_id off table_seats is the flag the
       felt actually needs (it drives styling), and the engine snapshot - built
       server-side with service_role, which CAN read is_horse - remains the
       authority for the resolved name. */
    const { data, error } = await supabase
      .from('table_seats')
      .select(
        `
                user_id,
                seat_number,
                stack,
                joined_at,
                horse_id,
                profiles(
                    ${PLAYER_NAME_COLUMNS},
                    avatar_url:arena_avatar_url
                )
            `
      )
      .eq('table_id', tableId)
      .is('left_at', null)
      .order('seat_number', { ascending: true });

    if (error) {
      reportError(error, 'TableService.getSeatedPlayers');
      /* Returning [] here made a 400 indistinguishable from an empty table:
         the admin seat list rendered "No Players Seated" over both of the
         faults above, for as long as they existed, and nothing went red. The
         caller decides what an unanswerable question should look like. */
      throw error;
    }
    return data || [];
  }

  /**
   * Update table settings live (blinds, ante, max players)
   */
  async updateTableSettings(
    tableId: string,
    settings: {
      small_blind?: number;
      big_blind?: number;
      ante?: number;
      max_players?: number;
    }
  ): Promise<boolean> {
    const { error } = await supabase.from('tables').update(settings).eq('id', tableId);

    if (error) {
      reportError(error, 'TableService.updateSettings');
      return false;
    }
    return true;
  }

  /**
   * Get table stats summary (for admin panel)
   */
  async getTableStats(tableId: string) {
    const [rakeData, handData] = await Promise.all([
      // 2026-08-19: rake_history stopped receiving writes on 2026-05-01, so
      // every table's admin stats reported 0 rake regardless of activity.
      // rake_records is the live ledger and carries the same table_id.
      supabase
        .from('rake_records')
        .select('rake_amount')
        .eq('table_id', tableId)
        .limit(QUERY_LIMITS.AGGREGATE),
      supabase
        .from('hand_history')
        .select('id', { count: 'exact', head: true })
        .eq('table_id', tableId),
    ]);

    const totalRake = (rakeData.data || []).reduce((sum, r) => sum + (r.rake_amount || 0), 0);
    const totalHands = handData.count || 0;

    return { totalRake, totalHands };
  }
}

export const tableService = new TableService();
