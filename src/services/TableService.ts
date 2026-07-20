/**
 * ♠ CLUB ARENA — Table Service
 * Manages poker tables and game sessions
 */

import { supabase } from '../lib/supabase';
import { engineChannelClient } from './EngineStateClient';
import type { PokerTable, TableSettings, GameVariant, HandState } from '../types/database.types';
import { WalletService } from './WalletService';
import { masterBus } from '../core/MasterBus';

import { resolveClubUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';
import { notifyServerLeave } from './GameServerAPI';

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
    const { data, error } = await supabase
      .from('tables')
      .select(
        'id, club_id, name, game_type, game_variant, stakes, small_blind, big_blind, min_buy_in, max_buy_in, max_players, current_players, status, settings, created_at'
      )
      .eq('club_id', resolvedId)
      .eq('is_deleted', false)
      .neq('status', 'closed')
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
    // Query tables directly by union_id (union tables have club_id=NULL)
    const { data, error } = await supabase
      .from('tables')
      .select(
        'id, club_id, union_id, name, game_type, game_variant, stakes, small_blind, big_blind, min_buy_in, max_buy_in, max_players, current_players, status, settings, created_at'
      )
      .eq('union_id', unionId)
      .eq('is_deleted', false)
      .neq('status', 'closed')
      .order('created_at', { ascending: false });

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
    const defaultSettings: TableSettings = {
      straddle_enabled: true,
      straddle_type: 'utg',
      run_it_twice: true,
      bomb_pot_enabled: false,
      bomb_pot_frequency: 0,
      bomb_pot_ante_bb: 0,
      time_bank_seconds: 30,
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

    // Union guard: clubs inside a union cannot create their own tables
    const resolvedClubId = await resolveClubUUID(clubId);
    if (!resolvedClubId) {
      throw new Error('Invalid club ID provided');
    }
    const { data: unionCheck, error: unionErr } = await supabase
      .from('union_clubs')
      .select('union_id')
      .eq('club_id', resolvedClubId)
      .maybeSingle();
    if (unionErr) {
      throw new Error(`Union membership check failed: ${unionErr.message}`);
    }
    if (unionCheck) {
      throw new Error(
        'Clubs inside a union cannot create standalone tables. Tables are managed at the union level.'
      );
    }

    const { data, error } = await supabase
      .from('tables')
      .insert({
        club_id: resolvedClubId,
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
        time_bank_seconds: defaultSettings.time_bank_seconds ?? 30,
        time_bank_enabled: (defaultSettings.time_bank_seconds ?? 0) > 0,
        wait_for_big_blind: defaultSettings.wait_for_big_blind ?? true,
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
   * Close a table
   * Uses force_close_table_and_refund RPC to gracefully return all chips
   * in the table_seats stack directly back to player_wallets before closing.
   */
  async closeTable(tableId: string): Promise<void> {
    const { data: result, error } = await supabase.rpc('force_close_table_and_refund', {
      p_table_id: tableId,
    });

    if (error) {
      reportError(error, 'TableService.forceCloseAndRefund');

      // CRITICAL: The RPC that atomically refunds chips AND closes the table failed.
      // Fallback: close the table to prevent new hands, but chips may be orphaned.
      // Log a CRITICAL financial alert so ops can manually reconcile.
      await supabase
        .from('tables')
        .update({ status: 'closed', current_players: 0 })
        .eq('id', tableId);

      // Attempt per-player refund as best-effort recovery
      try {
        const { data: seatedPlayers } = await supabase
          .from('table_seats')
          .select('user_id, stack, seat_number')
          .eq('table_id', tableId)
          .is('left_at', null)
          .gt('stack', 0);

        let refundedCount = 0;
        for (const player of seatedPlayers || []) {
          const { error: refundErr } = await supabase.rpc('atomic_credit_wallet_and_log', {
            p_user_id: player.user_id,
            p_amount: player.stack,
            p_category: 'cashout',
            p_description: `Emergency table close refund: ${player.stack} chips (table ${tableId})`,
            p_table_id: tableId,
            p_hand_id: null,
            p_related_entity_id: null,
          });
          if (!refundErr) {
            // Mark seat as left
            await supabase
              .from('table_seats')
              .update({ left_at: new Date().toISOString() })
              .eq('table_id', tableId)
              .eq('seat_number', player.seat_number)
              .is('left_at', null);
            refundedCount++;
          } else {
            reportError(refundErr, 'TableService.refundPlayer', { userId: player.user_id });
          }
        }
        console.warn(
          `[TableService] Emergency refund: ${refundedCount}/${(seatedPlayers || []).length} players refunded`
        );
      } catch (refundErr: unknown) {
        reportError(refundErr, 'TableService.emergencyRefund');
      }

      // Log critical financial alert for ops visibility
      try {
        const { FinancialAlertService } = await import('./FinancialAlertService');
        await FinancialAlertService.logCritical(
          'TableService.closeTable',
          `force_close_table_and_refund RPC failed — emergency fallback used. Manual chip reconciliation may be required.`,
          { tableId, rpcError: error.message }
        );
      } catch (e) {
        reportError(e, 'TableService');
        /* best effort — already logged to console */
      }
    } else {
      console.debug(`[TableService] Table closed successfully. Result:`, result);
      // Emit for ALL players who were seated — the RPC refunds them atomically
      masterBus.emit('BALANCE_UPDATED', { source: 'table_force_close_refund' });
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
  ): Promise<{ success: boolean; chipsReturned: number }> {
    try {
      // Step 1: Notify the game server engine — it will auto-fold if mid-hand
      // This is critical: without this, the engine keeps the player in-memory
      // and the game freezes waiting for their action
      try {
        await notifyServerLeave(tableId);
      } catch (serverErr) {
        // Non-fatal — continue with client-side cleanup
        console.warn('[TableService] Server leave notification failed:', serverErr);
      }

      // Get the player's current seat data
      const { data: seat, error: seatError } = await supabase
        .from('table_seats')
        .select('stack, status')
        .eq('table_id', tableId)
        .eq('seat_number', seatNumber)
        .eq('user_id', userId)
        .is('left_at', null)
        .maybeSingle();

      if (seatError || !seat) {
        // Only report to Sentry when there's an actual DB error — not when seat simply
        // doesn't exist (race condition: player already left, double-click, etc.)
        if (seatError) {
          reportError(seatError, 'TableService.seatNotFound');
        } else {
          console.warn('[TableService] leaveTable: seat not found (may have already left)', {
            tableId,
            seatNumber,
            userId,
          });
        }
        return { success: false, chipsReturned: 0 };
      }

      // Check if player is in active hand (server already folded them, but seat may still be 'playing')
      if (seat.status === 'playing') {
        // Mark as leave_pending — server's processLeavePending will handle cashout at end of hand
        await supabase
          .from('table_seats')
          .update({ status: 'sitting_out', leave_pending: true })
          .eq('table_id', tableId)
          .eq('seat_number', seatNumber)
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
            p_seat_number: seatNumber,
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
          .eq('seat_number', seatNumber)
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
    // Query hand history for average pot size (last 100 hands)
    const { data, error } = await supabase
      .from('hands')
      .select('pot_size')
      .eq('table_id', tableId)
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
      console.warn('[TableService] Pause conflict — table status already changed');
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
      console.warn('[TableService] Resume conflict — table is not paused');
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
      console.warn('[TableService] Delete conflict — table status changed concurrently');
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
   * Kick a player from a table — marks seat as left, returns chips to wallet
   */
  async kickPlayer(tableId: string, userId: string, reason?: string): Promise<boolean> {
    // Get player's current stack
    const { data: seat } = await supabase
      .from('table_seats')
      .select('stack, seat_number')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null)
      .maybeSingle();

    if (!seat) return false;

    // Return chips to player wallet ATOMICALLY with log
    if (seat.stack > 0) {
      const { error: walletErr } = await supabase.rpc('atomic_credit_wallet_and_log', {
        p_user_id: userId,
        p_amount: seat.stack,
        p_category: 'cashout',
        p_description: `Kicked from table: ${seat.stack} chips returned${reason ? ` (${reason})` : ''}`,
        p_table_id: tableId,
        p_hand_id: null,
        p_related_entity_id: null,
      });
      if (walletErr) {
        reportError(walletErr, 'TableService.kickWalletCredit');
        return false;
      }

      masterBus.emit('BALANCE_UPDATED', { source: 'table_kick_cashout', userId });
    }

    // Mark seat as left
    const { error } = await supabase
      .from('table_seats')
      .update({ left_at: new Date().toISOString() })
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null);

    if (error) {
      reportError(error, 'TableService.kickPlayer');
      return false;
    }

    // Update player count
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
      supabase
        .from('rake_history')
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
