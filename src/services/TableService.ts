/**
 * ♠ CLUB ARENA — Table Service
 * Manages poker tables and game sessions
 */

import { supabase } from '../lib/supabase';
import { engineChannelClient } from './EngineStateClient';
import type { PokerTable, TableSettings, GameVariant, HandState } from '../types/database.types';
import { masterBus } from '../core/MasterBus';

import { resolveClubUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';
import { notifyServerLeave } from './GameServerAPI';
import { gameCreationDeniedMessage } from '../lib/gameCreationAccess';
import { fetchGameCreationAccess } from './GameAccessService';
import { maxSeatsForVariant } from '../config/tableSeating';

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

    // UNION LAW (2026-08-19, Dan): a club inside a union lists the UNION's
    // games (all hosted by the union house club, stamped with union_id) plus
    // this club's OWN private tables. Sibling clubs' private games never show.
    let unionId: string | null = null;
    try {
      const { data: ucRow } = await supabase
        .from('union_clubs')
        .select('union_id')
        .eq('club_id', resolvedId)
        .limit(1)
        .maybeSingle();
      unionId = ucRow?.union_id ?? null;
    } catch {
      /* fail-open: standalone club behavior */
    }

    let query = supabase
      .from('tables')
      .select(
        'id, club_id, union_id, name, game_type, game_variant, stakes, small_blind, big_blind, min_buy_in, max_buy_in, max_players, current_players, status, settings, created_at'
      );
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
      .order('created_at', { ascending: false })
      .limit(QUERY_LIMITS.LIST);

    if (error) {
      reportError(error, 'TableService.getClubTables');
      return [];
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

  /**
   * Create a new table
   */
  async createTable(
    clubId: string,
    name: string,
    gameVariant: GameVariant,
    smallBlind: number,
    bigBlind: number,
    maxPlayers: number = 9,
    settings?: Partial<TableSettings>
  ): Promise<PokerTable> {
    // Dan 2026-08-19: "PLO5 CARD IS 7 PLAYERS MAX, AND PLO6 CARD IS 6 PLAYERS
    // MAX BY DEFAULT. PLO4 IS 8 PLAYERS MAX BY DEFAULT. MAKE THIS LAW FOR ALL
    // GAMES." One number per variant, flat.
    //
    // CASH ONLY — "YOU CAN NOT RUN IT TWO OR THREE TIMES IN A TOURNAMENT", and
    // Run It Twice is the whole reason the cap is tight. This method builds
    // CASH tables (the club Create Table modal is its only caller). Tournament
    // tables are created server-side and size themselves from the tournament's
    // own structure; do not route them through here.
    //
    // Enforced HERE rather than only in the modal so every caller is covered.
    // PokerEngine.deal() throws rather than degrading, so an over-seated table
    // fails mid-hand instead of quietly dealing a short board.
    const seatCap = maxSeatsForVariant(gameVariant);
    if (maxPlayers > seatCap) {
      throw new Error(
        `${String(gameVariant).toUpperCase()} tables are capped at ${seatCap} seats ` +
          `(requested ${maxPlayers}).`
      );
    }

    const defaultSettings: TableSettings = {
      straddle_enabled: true,
      straddle_type: 'utg',
      run_it_twice: true,
      bomb_pot_enabled: false,
      bomb_pot_frequency: 0,
      bomb_pot_ante_bb: 0,
      time_bank_enabled: true,
      auto_muck: true,
      vpip_display: false,
      ante_enabled: false,
      ante_amount: 0,
      no_rathole: false,
      double_board: false,
      time_limit_minutes: 0,
      action_time_seconds: 15,
      min_buyin_bb: 20,
      max_buyin_bb: 100,
      insurance_enabled: false,
      auto_restart: true,
      call_time_enabled: false,
      // Bible V8 4.3: Blind entry policies
      wait_for_big_blind: true,
      auto_post_blinds: true,
      post_dead_blind: true,
      // Bible V8 4.21: Showdown reveal policy
      showdown_reveal: 'last_aggressor_first' as const,
      auto_muck_losers: true,
      // Bible V8: Anti-ratholing
      rathole_cooldown_minutes: 0,
      ...settings,
    };

    // Permission gate: the club owner and admins build a standalone club's
    // games; for a club inside a union, the union's owner and admins do.
    //
    // 2026-08-19. This used to refuse ANY club that was in a union, which also
    // refused the union owner — the one person the rule says may build here.
    // It now asks the same question the database enforces on the INSERT.
    const resolvedClubId = await resolveClubUUID(clubId);
    if (!resolvedClubId) {
      throw new Error('Invalid club ID provided');
    }
    const access = await fetchGameCreationAccess(resolvedClubId);
    // Union governance (2026-08-19): a union club's own staff cannot build
    // union-visible games, but they MAY build a PRIVATE club game
    // (is_private = true — visible only inside the club, never in the union
    // lobby; the tables RLS policy enforces who may actually insert it and
    // trg_tables_union_ownership keeps union_id NULL on private rows).
    const privateOnly = !access.allowed && access.reason === 'union_only';
    if (!access.allowed && !privateOnly) {
      throw new Error(gameCreationDeniedMessage(access));
    }

    const { data, error } = await supabase
      .from('tables')
      .insert({
        club_id: resolvedClubId,
        // Stamp the owning union so a game built for a member club also shows
        // in the union's own views. NULL for a standalone club and for
        // private club games.
        union_id: privateOnly ? null : access.unionId,
        is_private: privateOnly,
        name,
        game_type: 'cash',
        game_variant: gameVariant,
        stakes: smallBlind != null && bigBlind != null ? `${smallBlind}/${bigBlind}` : '1/2',
        small_blind: smallBlind,
        big_blind: bigBlind,
        min_buy_in: bigBlind * 40,
        max_buy_in: bigBlind * 200,
        max_players: maxPlayers,
        current_players: 0,
        status: 'waiting',
        settings: defaultSettings,
        // FIX-D1 2026-07-19: the engine (loadTable in server) reads TOP-LEVEL
        // columns, NOT the `settings` JSONB. Writing host gameplay choices only
        // into the JSONB meant straddle / run-it-twice / bomb-pot / insurance /
        // ante / auto-muck / time-bank selected at table creation were silently
        // ignored. Mirror the merged settings into the canonical columns the
        // engine actually consumes. (Key-name mapping: run_it_twice ->
        // run_it_twice_enabled, auto_muck -> auto_muck_enabled, ante_amount ->
        // ante, bomb_pot_ante_bb -> bomb_pot_ante_multiplier.)
        straddle_enabled: defaultSettings.straddle_enabled ?? false,
        run_it_twice_enabled: defaultSettings.run_it_twice ?? false,
        auto_muck_enabled: defaultSettings.auto_muck ?? true,
        insurance_enabled: defaultSettings.insurance_enabled ?? false,
        ante_enabled: defaultSettings.ante_enabled ?? false,
        ante: defaultSettings.ante_amount ?? 0,
        bomb_pot_enabled: defaultSettings.bomb_pot_enabled ?? false,
        // FIX-D10: engine only fires bomb pots when frequency > 0. Default to
        // every 10 hands / 2x BB ante when enabled but unspecified.
        bomb_pot_frequency: defaultSettings.bomb_pot_enabled
          ? defaultSettings.bomb_pot_frequency || 10
          : 0,
        bomb_pot_ante_multiplier: defaultSettings.bomb_pot_enabled
          ? defaultSettings.bomb_pot_ante_bb || 2
          : 0,
        // DOUBLE-BOARD BOMB POT 2026-08-20 round 2: the CreateTableModal
        // checkbox was dead wiring — this mapping is the only path from
        // settings to the canonical column the engine reads.
        bomb_pot_double_board: defaultSettings.bomb_pot_enabled
          ? (defaultSettings.bomb_pot_double_board ?? false)
          : false,
        // 2026-08-18: time_bank_enabled used to be derived from a
        // time_bank_seconds value the engine never read — a per-table "seconds
        // per activation" knob that has not existed since the rule became a
        // flat 20s grant. Setting 0 there was the only way to turn time banks
        // off, which nothing documented. It is an explicit switch now.
        time_bank_enabled: defaultSettings.time_bank_enabled ?? true,
        wait_for_big_blind: defaultSettings.wait_for_big_blind ?? true,
        // 7-2 game: winner holding any 7-2 collects a bounty (in BB) from each
        // other dealt-in player, post-flop only. Engine reads these columns.
        seven_deuce_enabled: defaultSettings.seven_deuce_enabled ?? false,
        seven_deuce_amount: defaultSettings.seven_deuce_enabled
          ? defaultSettings.seven_deuce_amount || 2
          : 2,
      })
      .select()
      .maybeSingle();

    if (error) throw error;
    return data;
  }

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
   * Close a table — refunds every seated player and closes it, atomically.
   *
   * AUDIT M17: this used to call `force_close_table_and_refund` and, when that
   * failed, fall back to closing the table and then crediting each player in a
   * client-side loop. Both halves were dead.
   * `force_close_table_and_refund` takes THREE arguments (uuid, uuid, text) and
   * the client passed one, so the primary path was a signature error before it
   * was ever a permission error — and it is granted to postgres/service_role
   * only regardless. In the fallback, every `atomic_credit_wallet_and_log` was
   * 42501 and the `tables` UPDATE matched zero rows, which PostgREST reports as
   * success. So the table never closed, nobody was refunded, and the UI said it
   * worked.
   *
   * `fn_admin_close_table` does it all server-side in one transaction: club-admin
   * check, refund each seat from its ACTUAL stack, vacate the seats, close the
   * table. Each refund is idempotent on the seat-occupancy row id, so it cannot
   * double-pay against the engine's own cash-out path.
   */
  async closeTable(tableId: string): Promise<void> {
    const { data, error } = await supabase.rpc('fn_admin_close_table', {
      p_table_id: tableId,
    });

    if (error) {
      reportError(error, 'TableService.closeTable', { tableId });
      throw new Error('Could not close the table');
    }

    const res = data as { ok: boolean; reason?: string; players_refunded?: number } | null;

    if (!res?.ok) {
      throw new Error(adminActionReasonText(res?.reason));
    }

    if ((res.players_refunded ?? 0) > 0) {
      masterBus.emit('BALANCE_UPDATED', { source: 'table_close_refund' });
    }
    masterBus.emit('TABLE_CLOSED', { tableId });
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
  ): Promise<{ success: boolean; chipsReturned: number; error?: string }> {
    try {
      // Step 1: Notify the game server engine — it will auto-fold if mid-hand
      // This is critical: without this, the engine keeps the player in-memory
      // and the game freezes waiting for their action
      // 2026-08-20: `notifyServerLeave` NEVER throws — it resolves
      // `{ success: false }` on a non-OK status, on an unreachable engine and
      // whenever GameServerAPI's circuit breaker is open. So the catch below was
      // dead code and the result was discarded, and we fell straight through to
      // `atomic_table_cashout`.
      //
      // That combination is the dangerous one. The comment above states the
      // stakes: without this notification the engine keeps the player seated
      // in memory with a live stack. Cashing out anyway credits their wallet and
      // clears the seat row while the engine still holds them — engine memory
      // and the database now disagree about real chips, and every other player
      // at the table waits on the action clock of someone who has gone.
      //
      // Refuse to cash out unless the engine has acknowledged the departure. The
      // caller surfaces this and the player stays seated, which is recoverable;
      // a desynced stack is not.
      const serverLeave = await notifyServerLeave(tableId);
      if (!serverLeave?.success) {
        reportError(
          new Error(serverLeave?.error || 'notifyServerLeave rejected'),
          'TableService.leaveTable.serverRefused'
        );
        return {
          success: false,
          chipsReturned: 0,
          error:
            serverLeave?.error ||
            'Could not reach the game server - your chips were not moved. Please try again.',
        };
      }

      // Get the player's current seat data.
      // BUGFIX 2026-07-24: resolve the seat by USER_ID, not the passed seat_number.
      // The caller passes tableState.heroSeat, which can drift out of sync with the
      // DB (snapshot races, re-seating), and when it did the (seat_number,user_id)
      // lookup returned nothing → leaveTable returned false → the UI showed
      // "Unable to leave right now. You may be in an active hand" even though the
      // player was simply seated. A player has at most one active seat per table, so
      // user_id alone unambiguously identifies it. We prefer the passed seat_number
      // when it matches, else fall back to whatever active seat the user actually holds.
      const { data: seatRows, error: seatError } = await supabase
        .from('table_seats')
        .select('seat_number, stack, status')
        .eq('table_id', tableId)
        .eq('user_id', userId)
        .is('left_at', null)
        .order('joined_at', { ascending: true });

      if (seatError) {
        reportError(seatError, 'TableService.seatNotFound');
        return { success: false, chipsReturned: 0 };
      }
      const seat =
        (seatRows || []).find((s) => s.seat_number === seatNumber) || (seatRows || [])[0];
      if (!seat) {
        // Genuinely not seated (already left, double-tap, etc.)
        console.warn('[TableService] leaveTable: no active seat for user (may have already left)', {
          tableId,
          seatNumber,
          userId,
        });
        return { success: false, chipsReturned: 0 };
      }
      // Authoritative seat number from the DB — used for every downstream op.
      const seatNo = seat.seat_number;

      // ── Dan 2026-08-21 P0 (hand #1458859, chips vanished): honor the
      // ENGINE's word on whether the player is mid-hand, not the seat row's
      // status. The engine's own /leave handler marks the seat
      // status='sitting_out' + leave_pending BEFORE this code reads it, so
      // the old `status === 'playing'` guard could never fire for a mid-hand
      // leave — we fell through to atomic_table_cashout with the STALE
      // pre-hand stack while the player's real chips were still in the pot.
      // The settlement then wrote the true final stack into a seat whose
      // left_at was already stamped — a silent no-op. A player who WON the
      // hand was paid their old stack and the winnings were destroyed.
      //
      // `immediate:false` from the engine means exactly "a hand is running
      // and I have marked you leave_pending — processLeavePending will cash
      // out your true post-hand stack at settlement." Trust it and stop here.
      if (serverLeave.immediate === false) {
        // Belt & suspenders: make sure leave_pending is set even if the
        // engine's async DB write hasn't landed yet.
        await supabase
          .from('table_seats')
          .update({ status: 'sitting_out', leave_pending: true })
          .eq('table_id', tableId)
          .eq('seat_number', seatNo)
          .is('left_at', null);
        return { success: true, chipsReturned: 0 };
      }

      // Check if player is in active hand (server already folded them, but seat may still be 'playing')
      if (seat.status === 'playing') {
        // Mark as leave_pending — server's processLeavePending will handle cashout at end of hand
        await supabase
          .from('table_seats')
          .update({ status: 'sitting_out', leave_pending: true })
          .eq('table_id', tableId)
          .eq('seat_number', seatNo)
          .is('left_at', null);

        return { success: true, chipsReturned: 0 };
      }

      const chipsToReturn = seat.stack || 0;

      // Get table context (needed for tournament leave + transaction log)
      const { data: tableData } = await supabase
        .from('tables')
        .select('club_id, union_id, tournament_id, name')
        .eq('id', tableId)
        .maybeSingle();

      const clubId = tableData?.club_id;
      // Union tables may have club_id=NULL — that's OK for cash games
      // (atomic_table_cashout uses table_id directly, doesn't need club_id)

      let returnedChips = 0;

      // ATOMIC CASH-OUT: Return chips to Player Wallet (ONLY for cash games) and clear seat
      if (!tableData?.tournament_id) {
        const { data: rpcAmount, error: cashoutError } = await supabase.rpc(
          'atomic_table_cashout',
          {
            p_user_id: userId,
            p_table_id: tableId,
            p_seat_number: seatNo,
          }
        );

        if (cashoutError) {
          // RPC returned an error (e.g. seat not found) — check explicitly
          // since supabase.rpc does NOT throw on SQL errors
          reportError(cashoutError, 'TableService.atomicCashout');
          return { success: false, chipsReturned: 0 };
        }

        // Error already handled above

        returnedChips = rpcAmount || 0;
        console.debug(
          `[TableService] Returned ${returnedChips} chips to Player Wallet for user ${userId}`
        );
        masterBus.emit('BALANCE_UPDATED', { source: 'table_leave_cashout', userId });

        // FIX 136: Record cashout for 2-hour re-entry restriction
        // Player cannot return to THIS table and buy in for less than their cashout for 2 hours
        if (returnedChips > 0) {
          await supabase
            .rpc('record_table_cashout', {
              p_user_id: userId,
              p_table_id: tableId,
              p_cashout_amount: returnedChips,
            })
            .then(({ error: cashoutHistErr }) => {
              if (cashoutHistErr) {
                console.warn(
                  '[TableService] Failed to record cashout history:',
                  cashoutHistErr.message
                );
              }
            });
        }
      } else {
        // For tournaments, just clear the seat without crediting wallets
        await supabase
          .from('table_seats')
          .update({ left_at: new Date().toISOString() })
          .eq('table_id', tableId)
          .eq('seat_number', seatNo)
          .eq('user_id', userId)
          .is('left_at', null);
      }

      // If this is a tournament table, update tournament_players status
      // (tableData already has tournament_id from the query at L258 — no second query needed)
      if (tableData?.tournament_id) {
        await supabase
          .from('tournament_players')
          .update({ status: 'eliminated', chips: 0 })
          .eq('tournament_id', tableData.tournament_id)
          .eq('user_id', userId);
      }

      // Update player count for TOURNAMENT leaves only
      // (atomic_table_cashout already updates current_players for cash game leaves)
      if (tableData?.tournament_id) {
        const { count, error: countErr } = await supabase
          .from('table_seats')
          .select('*', { count: 'exact', head: true })
          .eq('table_id', tableId)
          .is('left_at', null);

        if (!countErr) {
          await this.updatePlayerCount(tableId, count ?? 0);
        } else {
          reportError(countErr, 'TableService.recountAfterLeave');
        }
      }

      // ── WAITLIST AUTO-SEAT: Promote next waitlisted player into the opened seat ──
      // Only for cash games — tournaments have their own elimination flow
      if (!tableData?.tournament_id) {
        try {
          const { data: promotedUserId, error: promoErr } = await supabase.rpc(
            'promote_next_waitlisted_player',
            { p_table_id: tableId }
          );

          if (promoErr) {
            console.warn('[TableService] Waitlist auto-promote RPC failed:', promoErr.message);
          } else if (promotedUserId) {
            console.debug(
              `[TableService] Waitlist auto-seated player ${promotedUserId} at table ${tableId}`
            );

            // Notify the promoted player via notification
            await supabase.from('notifications').insert({
              user_id: promotedUserId,
              type: 'seat_available',
              title: 'You Have Been Seated!',
              message:
                'A seat opened up and you have been automatically seated at your waitlisted table.',
              action_url: `/table/${tableId}`,
            });

            // Emit bus event so the promoted player's client gets a real-time toast
            masterBus.emit('WAITLIST_PROMOTED', {
              tableId,
              userId: promotedUserId,
              tableName: tableData?.name || 'your table',
            });
          }
        } catch (promoError) {
          console.warn('[TableService] Waitlist auto-promote failed:', promoError);
        }
      }

      // Record in table history
      await supabase.from('table_activity').insert({
        table_id: tableId,
        user_id: userId,
        activity_type: 'leave',
        data: { chips_cashed_out: chipsToReturn },
      });

      // Note: Transaction already logged via WalletService.logTransaction above

      return { success: true, chipsReturned: chipsToReturn };
    } catch (err: unknown) {
      reportError(err, 'TableService.leaveTable');
      return { success: false, chipsReturned: 0 };
    }
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
   * Get average pot size for a table
   */
  async getAveragePot(tableId: string): Promise<number> {
    // 2026-08-19: read `hands`, a table with ZERO rows ever, so this always
    // returned 0 no matter how the table was playing. hand_history is the live
    // ledger the engine writes, and carries pot_size directly.
    const { data, error } = await supabase
      .from('hand_history')
      .select('pot_size')
      .eq('table_id', tableId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error || !data?.length) return 0;

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

  /**
   * Pause a running table (stops new hands from being dealt)
   * Uses atomic conditional update — only pauses if currently running/active
   */
  async pauseTable(tableId: string): Promise<boolean> {
    const { data: updated, error } = await supabase
      .from('tables')
      .update({ status: 'paused', updated_at: new Date().toISOString() })
      .eq('id', tableId)
      .in('status', ['running', 'active', 'waiting'])
      .select('id')
      .maybeSingle();

    if (error) {
      reportError(error, 'TableService.pauseTable');
      return false;
    }
    if (!updated) {
      console.warn('[TableService] Pause conflict - table status already changed');
      return false;
    }
    masterBus.emit('TABLE_UPDATED', { tableId, status: 'paused' });
    return true;
  }

  /**
   * Resume a paused table
   * Uses atomic conditional update — only resumes if currently paused
   */
  async resumeTable(tableId: string): Promise<boolean> {
    const { data: updated, error } = await supabase
      .from('tables')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', tableId)
      .eq('status', 'paused')
      .select('id')
      .maybeSingle();

    if (error) {
      reportError(error, 'TableService.resumeTable');
      return false;
    }
    if (!updated) {
      console.warn('[TableService] Resume conflict - table is not paused');
      return false;
    }
    masterBus.emit('TABLE_UPDATED', { tableId, status: 'running' });
    return true;
  }

  /**
   * Delete a table — marks as deleted + decrements club table count
   * Blocks deletion of running/active tables (must close first)
   * REQUIRES: requesting user is table creator OR club owner
   */
  async deleteTable(tableId: string, clubId: string, userId?: string): Promise<boolean> {
    // Pre-check: get current status and verify ownership if userId provided
    const table = await this.getTable(tableId);
    if (!table) {
      reportError('Table not found for delete', 'TableService.deleteTable.notFound');
      return false;
    }

    // Authorization check: if userId provided, verify user is club owner
    if (userId) {
      const { getAuthUser } = await import('../lib/supabase');
      const { data: authData } = await getAuthUser();
      const requestingUserId = authData?.user?.id || userId;

      const { data: clubMember, error: memberError } = await supabase
        .from('club_members')
        .select('role')
        .eq('club_id', table.club_id)
        .eq('user_id', requestingUserId)
        .maybeSingle();

      if (memberError || !clubMember) {
        reportError('User not a member of this club', 'TableService.deleteTable.notMember');
        return false;
      }

      // Only owner or admin can delete tables
      if (!['owner', 'admin'].includes(clubMember.role)) {
        reportError('User lacks permission', 'TableService.deleteTable.noPermission');
        return false;
      }
    }

    if (['running', 'active'].includes(table.status)) {
      reportError('Cannot delete active table', 'TableService.deleteTable.active');
      return false;
    }
    if (table.status === 'deleted') {
      return true; // already deleted
    }

    // Atomic conditional update
    const { data: updated, error } = await supabase
      .from('tables')
      .update({ status: 'deleted', is_deleted: true, updated_at: new Date().toISOString() })
      .eq('id', tableId)
      .in('status', ['waiting', 'paused', 'closed'])
      .select('id')
      .maybeSingle();

    if (error) {
      reportError(error, 'TableService.deleteTable');
      return false;
    }
    if (!updated) {
      console.warn('[TableService] Delete conflict - table status changed concurrently');
      return false;
    }

    // Decrement club table count (fire-and-forget)
    (async () => {
      try {
        const { error: rpcErr } = await supabase.rpc('decrement_club_table_count', {
          p_club_id: clubId,
        });
        if (rpcErr) {
          // Fallback: manual decrement
          const { data: club } = await supabase
            .from('clubs')
            .select('table_count')
            .eq('id', clubId)
            .maybeSingle();
          if (club) {
            await supabase
              .from('clubs')
              .update({ table_count: Math.max(0, (club.table_count || 1) - 1) })
              .eq('id', clubId);
          }
        }
      } catch (e: unknown) {
        console.warn(
          '[TableService] deleteTable: club table count decrement failed (fire-and-forget):',
          e
        );
      }
    })();

    masterBus.emit('TABLE_DELETED', { tableId, clubId });
    return true;
  }

  /**
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
      .select('*', { count: 'exact', head: true })
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
   * Get seated players for a table (admin view)
   */
  async getSeatedPlayers(tableId: string) {
    const { data, error } = await supabase
      .from('table_seats')
      .select(
        `
                user_id,
                seat_number,
                stack,
                created_at,
                profiles (
                    display_name,
                    username,
                    avatar_url,
                    is_horse
                )
            `
      )
      .eq('table_id', tableId)
      .is('left_at', null)
      .order('seat_number', { ascending: true });

    if (error) {
      reportError(error, 'TableService.getSeatedPlayers');
      return [];
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
