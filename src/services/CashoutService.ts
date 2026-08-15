/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHOUT SERVICE — Player Chip Cashout Management
 * ═══════════════════════════════════════════════════════════════════════════════
 * Handles:
 * - Player cashout requests (locks chips in escrow)
 * - Agent approval/rejection of cashouts
 * - Player cancellation of pending cashouts
 * - 10-minute reversal window for agent chip sends
 * - 🔔 Agent notifications on new cashout requests
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { callClubArenaApi } from './clubArenaApi';
import { ChipFlowService } from './ChipFlowService';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type CashoutStatus = 'pending' | 'approved' | 'completed' | 'cancelled' | 'rejected';

export interface CashoutRequest {
  id: string;
  clubId: string;
  playerId: string;
  playerName?: string;
  playerAvatar?: string;
  agentId: string;
  agentName?: string;
  amount: number;
  status: CashoutStatus;
  playerNote?: string;
  agentNote?: string;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
}

/** Cashout-specific transaction (distinct from the canonical ChipTransaction in database.types) */
export interface CashoutTransaction {
  id: string;
  clubId: string;
  fromUserId?: string;
  toUserId?: string;
  amount: number;
  transactionType: 'send' | 'remove' | 'cashout' | 'escrow_lock' | 'escrow_release';
  relatedCashoutId?: string;
  reversibleUntil?: string;
  isReversed: boolean;
  createdAt: string;
  notes?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class CashoutServiceClass {
  /**
   * Player: Request a cashout (locks chips in escrow)
   */
  async requestCashout(
    playerId: string,
    clubId: string,
    amount: number,
    note?: string
  ): Promise<CashoutRequest | null> {
    // Rate limit: max 1 pending cashout per player per club
    const resolvedClubId = await resolveClubUUID(clubId);
    const { data: existing } = await supabase
      .from('cashout_requests')
      .select('id')
      .eq('player_id', playerId)
      .eq('club_id', resolvedClubId)
      .eq('status', 'pending')
      .limit(1);

    if (existing && existing.length > 0) {
      throw new Error(
        'You already have a pending cashout for this club. Please wait for it to be processed before requesting another.'
      );
    }

    // Request SERVER-SIDE. `fn_request_cashout` is service_role-only, so the old
    // direct browser rpc() returned 42501 and this button could never work
    // (verified: cashout_requests had ZERO rows in production). The route derives
    // the player from the JWT, resolves their agent from club_members, enforces
    // balance/duplicate checks, debits chips into escrow atomically, writes the
    // audit trail AND notifies the agent.
    const result = await callClubArenaApi<{ cashoutId: string }>('request-cashout', {
      clubId: resolvedClubId,
      amount,
      note: note || undefined,
    });

    const newCashoutId = result.cashoutId;
    if (!newCashoutId) {
      reportError(new Error('request-cashout returned no id'), 'CashoutService.requestCashout');
      throw new Error('Failed to request cashout: no id returned');
    }
    const cashout = await this.getCashout(newCashoutId);

    // NOTE: the agent notification and the wallet/audit rows are written by the
    // route (it returns agentNotified:true). No client-side notify or
    // logTransaction here -- log_wallet_transaction is service_role-only and
    // would silently no-op.

    // Emit balance change so Cashier/Wallet pages refresh instantly
    masterBus.emit('BALANCE_UPDATED', {
      source: 'cashout_request',
      userId: playerId,
      amount: -amount,
    });

    // Emit CASHOUT_REQUESTED so admin dashboard refreshes in real-time
    masterBus.emit('CASHOUT_REQUESTED', { clubId: resolvedClubId, amount, userId: playerId });

    return cashout;
  }

  /**
   * Player: Cancel a pending cashout (returns chips from escrow)
   */
  async cancelCashout(cashoutId: string, playerId: string): Promise<boolean> {
    // Read details BEFORE cancelling -- the route is authoritative and the row's
    // status changes underneath us.
    const cashout = await this.getCashout(cashoutId);

    // Self-cancel SERVER-SIDE. `fn_cancel_cashout` is service_role-only (42501
    // from the browser). The route verifies the caller IS the requester via the
    // JWT, refunds the escrowed chips atomically and writes the audit trail.
    await callClubArenaApi('cancel-my-cashout', { cashoutId });

    // Emit balance change -- chips returned from escrow
    masterBus.emit('BALANCE_UPDATED', { source: 'cashout_cancel', userId: playerId });
    masterBus.emit('CASHOUT_CANCELLED', { cashoutId, clubId: cashout?.clubId || '' });

    return true;
  }

  /**
   * Agent: Approve a cashout request
   */
  async approveCashout(cashoutId: string, agentId: string, note?: string): Promise<boolean> {
    // Approve SERVER-SIDE. `fn_agent_approve_cashout` is service_role-only (42501
    // from the browser). The route authenticates the approving agent from the JWT
    // and runs `fn_approve_cashout_atomic`, which locks the row, re-checks that the
    // caller holds an agent/owner/admin role in that club, moves the chips into the
    // club treasury and transitions the request to 'approved' in ONE transaction.
    //
    // This single call is TERMINAL for the money -- there is no separate "complete"
    // step any more (see completeCashout below).
    await callClubArenaApi('approve-cashout', {
      cashoutId,
      action: 'approve',
      note: note || undefined,
    });

    // Emit CASHOUT_APPROVED so admin dashboard and cashier pages refresh
    const cashout = await this.getCashout(cashoutId);
    masterBus.emit('CASHOUT_APPROVED', { cashoutId, clubId: cashout?.clubId || '' });
    if (cashout) {
      masterBus.emit('BALANCE_UPDATED', {
        source: 'cashout_approved',
        userId: cashout.playerId,
        amount: -cashout.amount,
      });
    }

    return true;
  }

  /**
   * @deprecated Approval is now atomic and terminal.
   *
   * The old flow was two steps: `fn_agent_approve_cashout` then
   * `fn_complete_cashout`. Both were service_role-only, so neither ever ran from
   * the browser. The server route replaced them with `fn_approve_cashout_atomic`,
   * which moves the chips to the club treasury and sets status='approved' in a
   * single locked transaction.
   *
   * Kept as a no-op so any remaining caller cannot double-apply the money leg.
   * Callers should drop this call; `approveCashout` alone is sufficient.
   */
  async completeCashout(cashoutId: string, _agentId: string): Promise<boolean> {
    void cashoutId;
    void _agentId;
    return true;
  }

  async rejectCashout(cashoutId: string, agentId: string, reason?: string): Promise<boolean> {
    // Get cashout details first
    const cashout = await this.getCashout(cashoutId);
    if (!cashout || cashout.agentId !== agentId || cashout.status !== 'pending') {
      throw new Error('Cashout not found or not rejectable');
    }

    // Reject SERVER-SIDE. `fn_reject_cashout` is service_role-only (42501 from the
    // browser). An agent rejection is the same money operation as an agent-side
    // cancel: the route runs `fn_cancel_cashout_atomic` with is_agent=true, which
    // re-checks the caller's club role, refunds the escrowed chips to the player
    // and writes the audit trail atomically.
    await callClubArenaApi('approve-cashout', {
      cashoutId,
      action: 'cancel',
      note: reason || undefined,
    });

    // Emit balance change -- chips returned to player from rejected cashout
    masterBus.emit('BALANCE_UPDATED', {
      source: 'cashout_reject',
      userId: cashout.playerId,
      amount: cashout.amount,
    });
    masterBus.emit('CASHOUT_CANCELLED', { cashoutId, clubId: cashout?.clubId || '' });

    return true;
  }

  /**
   * Get a single cashout by ID
   */
  async getCashout(cashoutId: string): Promise<CashoutRequest | null> {
    const { data, error } = await supabase
      .from('cashout_requests')
      .select(
        `
                *,
                player:player_id(display_name, avatar_url),
                agent:agent_id(display_name)
            `
      )
      .eq('id', cashoutId)
      .maybeSingle();

    if (error || !data) return null;

    return this.mapCashout(data);
  }

  /**
   * Get pending cashouts for an agent
   */
  async getAgentPendingCashouts(agentId: string, clubId?: string): Promise<CashoutRequest[]> {
    let query = supabase
      .from('cashout_requests')
      .select(
        `
                *,
                player:player_id(display_name, avatar_url),
                agent:agent_id(display_name)
            `
      )
      .eq('agent_id', agentId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(100);

    if (clubId) {
      query = query.eq('club_id', await resolveClubUUID(clubId));
    }

    const { data, error } = await query;

    if (error) {
      reportError(error, 'CashoutService.getAgentCashouts');
      return [];
    }

    return (data || []).map((d) => this.mapCashout(d));
  }

  /**
   * Get cashouts for a player
   */
  async getPlayerCashouts(playerId: string, clubId?: string): Promise<CashoutRequest[]> {
    let query = supabase
      .from('cashout_requests')
      .select(
        `
                *,
                player:player_id(display_name, avatar_url),
                agent:agent_id(display_name)
            `
      )
      .eq('player_id', playerId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (clubId) {
      query = query.eq('club_id', await resolveClubUUID(clubId));
    }

    const { data, error } = await query;

    if (error) {
      reportError(error, 'CashoutService.getPlayerCashouts');
      return [];
    }

    return (data || []).map((d) => this.mapCashout(d));
  }

  /**
   * Agent: Check if chips can be removed (within 10 min window)
   */
  async canRemoveChips(
    agentId: string,
    playerId: string,
    clubId: string,
    amount: number
  ): Promise<boolean> {
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('fn_can_agent_remove_chips', {
          p_agent_id: agentId,
          p_player_id: playerId,
          p_club_id: clubId,
          p_amount: amount,
        }),
      3
    );

    if (error) {
      reportError(error, 'CashoutService.checkRemovePermission');
      return false;
    }

    return data === true;
  }

  /**
   * Agent: Send chips to player (with 10-min reversal window)
   * Uses ChipFlowService for proper atomic wallet debit/credit with audit trail.
   */
  async sendChipsToPlayer(
    agentId: string,
    playerId: string,
    clubId: string,
    amount: number,
    notes?: string
  ): Promise<boolean> {
    // Use ChipFlowService for proper atomic transfer (deducts from agent, credits player)
    await ChipFlowService.transfer(
      agentId,
      playerId,
      amount,
      'transfer',
      notes || 'Agent sent chips to player via Cashier'
    );

    // Record reversal window in chip_transactions — set BOTH the dedicated column
    // AND metadata for backward compatibility. fn_can_agent_remove_chips reads the column.
    const reversibleUntil = new Date();
    reversibleUntil.setMinutes(reversibleUntil.getMinutes() + 10);

    const { error: txError } = await supabase.from('chip_transactions').insert({
      club_id: clubId,
      from_user_id: agentId,
      to_user_id: playerId,
      amount,
      transaction_type: 'send',
      reversible_until: reversibleUntil.toISOString(),
      is_reversed: false,
      metadata: { reversible_until: reversibleUntil.toISOString() },
      notes,
    });

    if (txError) {
      reportError(txError, 'CashoutService.reversalMetadata');
    }

    return true;
  }

  /**
   * Agent: Remove chips from player (only within 10-min window)
   * Reverses the transfer: deducts from player, credits back to agent.
   */
  async removeChipsFromPlayer(
    agentId: string,
    playerId: string,
    clubId: string,
    amount: number,
    notes?: string
  ): Promise<boolean> {
    // Check if within reversal window
    const canRemove = await this.canRemoveChips(agentId, playerId, clubId, amount);
    if (!canRemove) {
      throw new Error(
        'Cannot remove chips: Outside 10-minute window or insufficient reversible amount'
      );
    }

    // Use ChipFlowService for proper atomic transfer (deducts from player, credits agent)
    await ChipFlowService.transfer(
      playerId,
      agentId,
      amount,
      'refund',
      notes || 'Agent reversed chip send within 10-minute window'
    );

    // Mark original transaction as reversed via BOTH the dedicated column AND metadata.
    // First SELECT the most recent unreversed 'send' within the reversal window,
    // then UPDATE by ID. PostgREST .limit() on UPDATE is unreliable — use 2-step approach.
    const resolvedClubForReversal = await resolveClubUUID(clubId);
    const { data: reversibleTx } = await supabase
      .from('chip_transactions')
      .select('id')
      .eq('from_user_id', agentId)
      .eq('to_user_id', playerId)
      .eq('club_id', resolvedClubForReversal)
      .eq('transaction_type', 'send')
      .eq('is_reversed', false)
      .gte('reversible_until', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (reversibleTx?.id) {
      const { error: reverseError } = await supabase
        .from('chip_transactions')
        .update({
          is_reversed: true,
          metadata: { is_reversed: true },
        })
        .eq('id', reversibleTx.id);

      if (reverseError) {
        reportError(reverseError, 'CashoutService.markReversal');
      }
    } else {
      console.warn('[Cashout] No reversible transaction found to mark — reversal metadata skipped');
    }

    // Record removal in chip_transactions for reversal tracking
    const { error: txError } = await supabase.from('chip_transactions').insert({
      club_id: clubId,
      from_user_id: playerId,
      to_user_id: agentId,
      amount,
      transaction_type: 'remove',
      notes: notes || 'Agent removed chips within 10-minute window',
    });

    if (txError) {
      reportError(txError, 'CashoutService.removalMetadata');
    }

    return true;
  }

  /**
   * Map database record to CashoutRequest
   */
  private mapCashout(data: Record<string, unknown>): CashoutRequest {
    return {
      id: data.id as string,
      clubId: data.club_id as string,
      playerId: data.player_id as string,
      playerName: (data.player as Record<string, unknown>)?.display_name as string,
      playerAvatar: (data.player as Record<string, unknown>)?.avatar_url as string,
      agentId: data.agent_id as string,
      agentName: (data.agent as Record<string, unknown>)?.display_name as string,
      amount: data.amount as number,
      status: data.status as CashoutStatus,
      playerNote: data.player_note as string,
      agentNote: data.agent_note as string,
      createdAt: data.created_at as string,
      updatedAt: data.updated_at as string,
      acknowledgedAt: data.acknowledged_at as string,
      completedAt: data.completed_at as string,
      cancelledAt: data.cancelled_at as string,
    };
  }

  /**
   * Auto-expire stale pending cashouts — returns escrowed chips to players.
   * Call via cron/edge function on a schedule (e.g. every 6 hours).
   */
  async expireStale(maxHours = 72): Promise<{ expired: number; playersRefunded: string[] }> {
    const { data, error } = await retryAsync(
      () =>
        // Round 18 fix: my Round 9 RPC param is p_ttl_hours, caller used p_max_hours.
        supabase.rpc('fn_expire_stale_cashouts', {
          p_ttl_hours: maxHours,
        }),
      3
    );

    if (error) {
      reportError(error, 'CashoutService.expireStale');
      return { expired: 0, playersRefunded: [] };
    }

    const expiredRecords = data || [];
    const playersRefunded: string[] = [];

    // Emit BALANCE_UPDATED for each player whose chips were returned
    for (const rec of expiredRecords) {
      masterBus.emit('BALANCE_UPDATED', {
        source: 'cashout_expired',
        userId: rec.player_id,
        amount: rec.amount,
      });
      playersRefunded.push(rec.player_id);
    }

    if (expiredRecords.length > 0) {
      console.debug(
        `[Cashout] Expired ${expiredRecords.length} stale cashouts, refunded ${playersRefunded.length} players`
      );
    }

    return { expired: expiredRecords.length, playersRefunded };
  }
}

// Export singleton
export const cashoutService = new CashoutServiceClass();
