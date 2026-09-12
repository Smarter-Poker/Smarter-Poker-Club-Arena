import { validateCashoutAmount } from '../utils/cashoutAmount';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHOUT SERVICE — Player Chip Cashout Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Player requests -> chips leave their balance into escrow -> the agent accepts
 * (the chips land in THAT AGENT'S WALLET) or declines (they go back).
 *
 * ── WHY THIS STOPPED GOING THROUGH THE API ROUTES (2026-08-25) ───────────────
 *
 * Every leg used to be a fetch to a World Hub route holding the service role
 * key, because the underlying functions were SECURITY INVOKER and a browser
 * calling them got 42501. That indirection hid three real faults:
 *
 *  - `fn_approve_cashout_atomic` credited the approving agent's
 *    club_members.chip_balance, which is their PLAYER wallet, not their agent
 *    float. Dan: "Once approved the chips go into the agent's wallet."
 *  - it never checked that the escrow row it was releasing existed, while an
 *    RLS policy let a player INSERT a cashout_requests row directly. An
 *    unescrowed request, approved, credited an agent out of nothing.
 *  - `cashout_requests` could only be SELECTed by the player, so the agent
 *    panel built to work the queue was empty for every agent alive.
 *
 * The legs are now SECURITY DEFINER RPCs that derive the actor from auth.uid()
 * and do the whole thing in one transaction: money, status, escrow release,
 * ledger row and the in-app notification. The browser adds only the PUSH, which
 * is the one part the database cannot send.
 *
 * ── THE TEN MINUTE WINDOW IS NOT HERE ──────────────────────────────────────
 *
 * It belongs to the AGENT WALLET SEND, not to the cashout. See
 * fn_agent_wallet_claim_back and `sendChipsToPlayer` below.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
// The file is PushNotificationService.ts. macOS resolves './push...' anyway and
// Linux CI does not, which is exactly how a red test reached main on 2026-08-21.

/**
 * crypto.randomUUID is not in every embedded webview; fall back rather than throw.
 *
 * EXPORTED ON PURPOSE (2026-08-25). An op id minted INSIDE the service is fresh
 * on every call, which protects nothing: the retry a lost response provokes is a
 * SECOND call, and a second call used to carry a second op id and move the money
 * twice. Every money leg below now takes an optional `opId`, and the screens that
 * own the button hold one in a ref across a failure and clear it on success -
 * the same shape CashierTradePage already uses (see
 * tests/cashier-idempotency-keys.test.ts). The default keeps every existing
 * caller working; it just cannot protect a retry it never sees.
 */
export function newOpId(): string {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fall through */
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** The shape every cashout RPC answers with. Refusals arrive as data, not throws. */
interface CashoutRpcResult {
  success?: boolean;
  error?: string;
  replayed?: boolean;
  cashout_id?: string;
  club_id?: string;
  agent_id?: string;
  player_id?: string;
  player_name?: string;
  amount?: number;
  agent_wallet_after?: number;
  player_balance_after?: number;
}

function unwrap(data: unknown): CashoutRpcResult | null {
  return (Array.isArray(data) ? data[0] : data) as CashoutRpcResult | null;
}

/**
 * RETIRED 2026-08-30 (#1498). This is now a no-op that the compiler will not
 * let anyone quietly re-point at a dead transport.
 *
 * The comment this replaces was right about the important part: the cash-out
 * RPCs already write an in-app notification INSIDE the money transaction --
 * fn_cashout_approve ('cashout_approved'), fn_cashout_release
 * ('cashout_cancelled' / 'cashout_denied'), fn_cashout_request
 * ('cashout_request_escrow'), fn_expire_stale_cashouts
 * ('cashout_expired_refund') -- and trg_mirror_notification_to_push_outbox
 * turns every one of those into a push. Cash-out notifications have been
 * working server-side the whole time.
 *
 * What this function added on top was a SECOND push over the same event, sent
 * from the browser through a transport that OneSignal's retirement on
 * 2026-08-19 had already killed. So it delivered nothing, and if it had been
 * repointed rather than removed it would have delivered everything twice.
 *
 * Kept as an empty shim rather than deleted so the three call sites below stay
 * readable as "the RPC notifies here" instead of losing the marker entirely.
 */
async function pushQuietly(
  _userId: string,
  _title: string,
  _message: string,
  _url: string
): Promise<void> {
  // Intentionally empty. See above: the RPC already notified.
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 'expired' was missing until 2026-08-25, and it is a status the database
 * genuinely writes: fn_expire_stale_cashouts flips a request that nobody acted
 * on and refunds the escrow. Without it here, an expired row narrowed to a
 * status this union says is impossible, and every `status === ...` branch in the
 * UI silently treated it as pending.
 */
export type CashoutStatus =
  | 'pending'
  | 'approved'
  | 'completed'
  | 'cancelled'
  | 'rejected'
  | 'expired';

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
    note?: string,
    opId?: string
  ): Promise<CashoutRequest | null> {
    const validation = validateCashoutAmount(typeof amount === 'number' ? amount : NaN);
    if (!validation.ok) throw new Error(validation.error);

    const resolvedClubId = await resolveClubUUID(clubId);

    /**
     * ONE CALL, ONE TRANSACTION. fn_cashout_request derives the player from
     * auth.uid() (so `playerId` is a display argument, never an authority),
     * locks the member row, refuses an overdraft or a second pending request,
     * debits the balance, opens the request, writes the chip_escrow hold, the
     * chip_transactions row AND the agent's in-app notification. The op_id
     * makes a retry after a lost response report the original rather than
     * escrowing the chips twice.
     */
    const { data, error } = await supabase.rpc('fn_cashout_request', {
      p_club_id: resolvedClubId,
      p_amount: amount,
      p_note: note || null,
      p_op_id: opId || newOpId(),
    });
    if (error) {
      reportError(error, 'CashoutService.requestCashout');
      throw new Error(error.message || 'Failed to request cashout');
    }
    const res = unwrap(data);
    if (!res?.success) throw new Error(res?.error || 'Failed to request cashout');

    const newCashoutId = res.cashout_id;
    if (!newCashoutId) {
      reportError(new Error('fn_cashout_request returned no id'), 'CashoutService.requestCashout');
      throw new Error('Failed to request cashout: no id returned');
    }

    // The MESSAGE is already written (in the same transaction as the money, so
    // it cannot exist for a cashout that did not happen). The PUSH is the half
    // a database cannot send, and it is the half that reaches an agent who does
    // not currently have the app open.
    //
    // NOT on a replay. `replayed: true` means this attempt found the original
    // row rather than escrowing anything, so the agent's phone already buzzed
    // for this exact request. Buzzing again would tell them a second cash out
    // arrived when no second cash out exists.
    if (!res.replayed) {
      await pushQuietly(
        res.agent_id || '',
        'Cash Out Requested',
        `${res.player_name || 'A Player'} Requested To Cash Out ${amount.toLocaleString()} Chips`,
        '/hub/club-arena/agent'
      );
    }

    const cashout = await this.getCashout(newCashoutId);

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
   *
   * fn_cashout_release is the same money leg an agent's decline uses; which one
   * it was is decided by whether auth.uid() is the player, and the ledger row
   * says so ('cashout_cancelled' versus 'cashout_denied').
   */
  async cancelCashout(cashoutId: string, playerId: string, opId?: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('fn_cashout_release', {
      p_cashout_id: cashoutId,
      p_note: null,
      p_op_id: opId || newOpId(),
    });
    if (error) {
      reportError(error, 'CashoutService.cancelCashout');
      throw new Error(error.message || 'Failed to cancel cashout');
    }
    const res = unwrap(data);
    if (!res?.success) throw new Error(res?.error || 'Failed to cancel cashout');

    masterBus.emit('BALANCE_UPDATED', { source: 'cashout_cancel', userId: playerId });
    masterBus.emit('CASHOUT_CANCELLED', { cashoutId, clubId: res.club_id || '' });

    return true;
  }

  /**
   * Agent: Approve a cashout request.
   *
   * TERMINAL for the money. fn_cashout_approve locks the request, requires an
   * unreleased chip_escrow row of the matching amount, credits the APPROVER'S
   * agents.agent_wallet_balance (Dan: "Once approved the chips go into the
   * agent's wallet"), releases the escrow, writes the ledger row and notifies
   * the player, all in one transaction.
   */
  async approveCashout(
    cashoutId: string,
    agentId: string,
    note?: string,
    opId?: string
  ): Promise<boolean> {
    void agentId; // the server takes the approver from auth.uid(), never from here
    const { data, error } = await supabase.rpc('fn_cashout_approve', {
      p_cashout_id: cashoutId,
      p_note: note || null,
      p_op_id: opId || newOpId(),
    });
    if (error) {
      reportError(error, 'CashoutService.approveCashout');
      throw new Error(error.message || 'Failed to approve cashout');
    }
    const res = unwrap(data);
    if (!res?.success) throw new Error(res?.error || 'Failed to approve cashout');

    // A replay moved nothing; the player was already told. See requestCashout.
    if (!res.replayed) {
      await pushQuietly(
        res.player_id || '',
        'Cash Out Approved',
        `Your Cash Out Of ${Number(res.amount || 0).toLocaleString()} Chips Was Approved`,
        '/hub/club-arena/cashier'
      );
    }

    masterBus.emit('CASHOUT_APPROVED', { cashoutId, clubId: res.club_id || '' });
    masterBus.emit('BALANCE_UPDATED', {
      source: 'cashout_approved',
      userId: res.player_id || '',
      amount: -(res.amount || 0),
    });

    return true;
  }

  /**
   * @deprecated Approval is now atomic and terminal.
   *
   * The old flow was two steps: `fn_agent_approve_cashout` then
   * `fn_complete_cashout`. Both were service_role-only, so neither ever ran from
   * the browser. `fn_cashout_approve` replaced them: it releases the escrow into
   * the approver's agent wallet and sets status='approved' in one locked
   * transaction.
   *
   * Kept as a no-op so any remaining caller cannot double-apply the money leg.
   * Callers should drop this call; `approveCashout` alone is sufficient.
   */
  async completeCashout(cashoutId: string, _agentId: string): Promise<boolean> {
    void cashoutId;
    void _agentId;
    return true;
  }

  /**
   * Agent or club staff: decline a cashout. Same money leg as a player's own
   * cancel, and the server decides which it was from auth.uid().
   *
   * The pre-flight `agentId` check that used to live here has gone: it read the
   * row through RLS the caller may not have had, and it duplicated an
   * authorisation the RPC performs under a row lock. Checking a permission in
   * the one place that can also enforce it is the point.
   */
  async rejectCashout(
    cashoutId: string,
    agentId: string,
    reason?: string,
    opId?: string
  ): Promise<boolean> {
    void agentId; // the server takes the actor from auth.uid()
    const { data, error } = await supabase.rpc('fn_cashout_release', {
      p_cashout_id: cashoutId,
      p_note: reason || null,
      p_op_id: opId || newOpId(),
    });
    if (error) {
      reportError(error, 'CashoutService.rejectCashout');
      throw new Error(error.message || 'Failed to reject cashout');
    }
    const res = unwrap(data);
    if (!res?.success) throw new Error(res?.error || 'Failed to reject cashout');

    // A replay moved nothing; the player was already told. See requestCashout.
    if (!res.replayed) {
      await pushQuietly(
        res.player_id || '',
        'Cash Out Declined',
        `Your Cash Out Of ${Number(res.amount || 0).toLocaleString()} Chips Was Declined And The Chips Are Back In Your Wallet`,
        '/hub/club-arena/cashier'
      );
    }

    masterBus.emit('BALANCE_UPDATED', {
      source: 'cashout_reject',
      userId: res.player_id || '',
      amount: res.amount || 0,
    });
    masterBus.emit('CASHOUT_CANCELLED', { cashoutId, clubId: res.club_id || '' });

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
                player:player_id(display_name, avatar_url:arena_avatar_url),
                agent:agent_id(display_name)
            `
      )
      .eq('id', cashoutId)
      .maybeSingle();

    if (error || !data) return null;

    return this.mapCashout(data);
  }

  /**
   * The queue an agent has to work.
   *
   * This used to select cashout_requests directly. Until 2026-08-25 the table's
   * ONLY select policy was `player_id = auth.uid()`, so this returned an empty
   * array to every agent it was written for, and AgentCashoutPanel rendered
   * "No Pending Cashout Requests" no matter how many were waiting.
   *
   * fn_cashout_queue answers the scoped question instead: the requests assigned
   * to you, plus anyone in your downline, plus everything in a club you run.
   */
  async getAgentPendingCashouts(agentId: string, clubId?: string): Promise<CashoutRequest[]> {
    void agentId; // the server scopes on auth.uid()
    const { data, error } = await supabase.rpc('fn_cashout_queue', {
      p_club_id: clubId ? await resolveClubUUID(clubId) : null,
      p_status: 'pending',
    });

    /**
     * THROWS, and that is the fix (2026-08-25). This used to report the error
     * and return `[]`, which AgentCashoutPanel renders as "No Pending Cashout
     * Requests" - the queue failing to load and the queue being empty told the
     * agent exactly the same thing. Worse, the panel already had a "Failed To
     * Load Cashout Requests" state with a Retry button that no code path could
     * ever reach. An agent must never be shown an empty worklist because a read
     * failed; there is money waiting behind it.
     */
    if (error) {
      reportError(error, 'CashoutService.getAgentCashouts');
      throw new Error(error.message || 'Failed to load cashout requests');
    }

    return ((data || []) as Array<Record<string, unknown>>).map((d) => ({
      id: d.id as string,
      clubId: d.club_id as string,
      playerId: d.player_id as string,
      playerName: (d.player_name as string) || undefined,
      playerAvatar: (d.player_avatar as string) || undefined,
      agentId: d.agent_id as string,
      amount: Number(d.amount) || 0,
      status: d.status as CashoutStatus,
      playerNote: (d.player_note as string) || undefined,
      agentNote: (d.agent_note as string) || undefined,
      createdAt: d.created_at as string,
      updatedAt: d.created_at as string,
    }));
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
                player:player_id(display_name, avatar_url:arena_avatar_url),
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
   * POLICY (Dan, 2026-08-15, binding; narrowed 2026-08-25): an AGENT may NEVER
   * remove chips from a downline player's BALANCE. The only way chips leave a
   * player's balance toward an agent is a player-initiated cashout: the player
   * requests, the chips are escrowed immediately, and on the agent's acceptance
   * they move to the agent's wallet. A club owner, co owner or admin may remove
   * chips at any time via `adminRemovePlayerChips` below.
   *
   * The ONE exception Dan added on 2026-08-25 is not a balance operation and so
   * does not live here: an agent may undo a send THEY made, from the specific
   * chip_transactions row that recorded it, for ten minutes. That is
   * `claimBackSend` below, and fn_agent_wallet_claim_back refuses it by the
   * clock. This method stays a flat refusal so the general power cannot be
   * re-enabled by widening the specific one.
   */
  async canRemoveChips(
    _agentId: string,
    _playerId: string,
    _clubId: string,
    _amount: number
  ): Promise<boolean> {
    return false;
  }

  /**
   * Agent: send chips from THE AGENT WALLET to a downline member.
   *
   * This used to call ChipFlowService.transfer, which capped the send against
   * agents.agent_wallet_balance and then debited `wallets` instead, and then
   * hand-inserted a chip_transactions row from the browser. That insert had no
   * INSERT policy behind it, so the ledger row it was trying to write for the
   * reversal window never landed either. Both halves are now one RPC.
   */
  async sendChipsToPlayer(
    agentId: string,
    playerId: string,
    clubId: string,
    amount: number,
    notes?: string,
    opId?: string
  ): Promise<boolean> {
    void agentId; // the server takes the sender from auth.uid()
    const resolvedClubId = await resolveClubUUID(clubId);
    const { data, error } = await supabase.rpc('fn_agent_wallet_send', {
      p_club_id: resolvedClubId,
      p_to_user_id: playerId,
      p_amount: amount,
      p_destination: 'player_wallet',
      p_reason: notes || null,
      p_op_id: opId || newOpId(),
    });
    if (error) {
      reportError(error, 'CashoutService.sendChipsToPlayer');
      throw new Error(error.message || 'Failed to send chips');
    }
    const res = unwrap(data);
    if (!res?.success) throw new Error(res?.error || 'Failed to send chips');

    masterBus.emit('BALANCE_UPDATED', { source: 'agent_wallet_send', userId: playerId, amount });
    return true;
  }

  /**
   * THE TEN MINUTE MISTAKE ERASER (Dan 2026-08-25, binding).
   *
   * "Agents can only claim back chips that were sent in the first 10 minutes
   *  (reconciling a mistake); after that they cannot remove chips from downline
   *  wallets unless the downline requests a cash out."
   *
   * Takes a TRANSACTION id, never a member id, because the power granted is
   * "undo that send" and not "take chips from that person". The window is
   * enforced against chip_transactions.reversible_until inside the RPC, so a
   * client with a wrong clock, or none, cannot widen it.
   */
  async claimBackSend(
    clubId: string,
    transactionId: string,
    amount?: number,
    reason?: string,
    opId?: string
  ): Promise<{ amount: number; agentWalletAfter: number }> {
    const resolvedClubId = await resolveClubUUID(clubId);
    const { data, error } = await supabase.rpc('fn_agent_wallet_claim_back', {
      p_club_id: resolvedClubId,
      p_transaction_id: transactionId,
      p_amount: amount ?? null,
      p_reason: reason || null,
      p_op_id: opId || newOpId(),
    });
    if (error) {
      reportError(error, 'CashoutService.claimBackSend');
      throw new Error(error.message || 'Failed to claim those chips back');
    }
    const res = unwrap(data) as (CashoutRpcResult & { source?: string }) | null;
    if (!res?.success) throw new Error(res?.error || 'Failed to claim those chips back');

    masterBus.emit('BALANCE_UPDATED', { source: 'agent_wallet_claim_back' });
    return {
      amount: Number(res.amount || 0),
      agentWalletAfter: Number(res.agent_wallet_after || 0),
    };
  }

  /**
   * FORBIDDEN by the chip-removal authority policy. Agents take chips only
   * through the player-initiated cashout flow (requestCashout -> approveCashout)
   * or, inside ten minutes, by undoing their own send (`claimBackSend`).
   * Club owners, co owners and admins use `adminRemovePlayerChips`.
   */
  async removeChipsFromPlayer(
    _agentId: string,
    _playerId: string,
    _clubId: string,
    _amount: number,
    _notes?: string
  ): Promise<boolean> {
    throw new Error(
      'Agents cannot remove chips from a player. The player must request a cashout; ' +
        'the chips are held in escrow immediately and transfer to you when you accept it.'
    );
  }

  /**
   * Club OWNER/ADMIN only: pull chips from any member at any time.
   * Enforced server-side by fn_admin_remove_player_chips, which derives the
   * actor from auth.uid(), refuses agents, row-locks the member, returns the
   * chips to the club pool and writes a chip_transactions audit row.
   *
   * `opId` closes the lost-response window. This was the ONE staff money path
   * with no idempotency key: a retry after a dropped reply pulled the chips a
   * second time. Migration 20260826 added p_op_id, a replay branch and a
   * partial unique index over (club_id, op_id) for admin_removal rows. Proved
   * against production inside a rolled-back transaction: two calls with one
   * key moved 300 chips once and wrote one ledger row.
   *
   * Pass a key HELD ACROSS A FAILURE. Minting one per call - which is what
   * every leg here used to do - makes the parameter decorative.
   */
  async adminRemovePlayerChips(
    clubId: string,
    playerId: string,
    amount: number,
    reason?: string,
    opId?: string
  ): Promise<{ removed: number; balanceAfter: number }> {
    const resolvedClubId = await resolveClubUUID(clubId);
    const { data, error } = await supabase.rpc('fn_admin_remove_player_chips', {
      p_club_id: resolvedClubId,
      p_player_id: playerId,
      p_amount: amount,
      p_reason: reason || null,
      p_op_id: opId || newOpId(),
    });
    if (error) {
      reportError(error, 'CashoutService.adminRemovePlayerChips');
      throw new Error(error.message || 'Failed to remove chips');
    }
    const res = data as {
      success?: boolean;
      error?: string;
      removed?: number;
      balance_after?: number;
    };
    if (!res?.success) throw new Error(res?.error || 'Failed to remove chips');

    masterBus.emit('BALANCE_UPDATED', { source: 'admin_removal', userId: playerId });
    return { removed: Number(res.removed || 0), balanceAfter: Number(res.balance_after || 0) };
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
   * Auto-expire stale pending cashouts: returns escrowed chips to the player.
   * Call via cron/edge function on a schedule (e.g. every 6 hours).
   *
   * THIS USED TO THROW THE MOMENT IT DID ANY WORK (fixed 2026-08-25).
   *
   * `fn_expire_stale_cashouts` RETURNS INTEGER - the count of requests it
   * expired. The repo migration that first created it (20260311_cashout_expiry)
   * returned a TABLE, and this method still read the newer scalar as if it were
   * that table: `for (const rec of data)` over a number is a TypeError, and
   * `data.length` on a number is undefined. It only ever looked healthy because
   * `0 || []` is `[]`, so a run that expired nothing returned a tidy zero and a
   * run that expired anything crashed. The live signature was confirmed against
   * production before this was changed.
   *
   * There are no per-player ids in a scalar, so one broadcast refresh is what
   * this can honestly emit. Every screen that cares listens for BALANCE_UPDATED
   * and refetches its own numbers.
   *
   * The retry is safe here and nowhere else in this file: the RPC selects only
   * `status = 'pending'` rows and flips each to 'expired' in the same
   * transaction, so a second attempt after a lost response finds nothing left to
   * refund and returns 0. It carries no op id, which is why it must stay that
   * self-limiting shape - see the server note in the audit report.
   */
  async expireStale(maxHours = 72): Promise<{ expired: number }> {
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
      return { expired: 0 };
    }

    // Defensive on shape, not on trust: a scalar today, a single-row table on an
    // older database. Anything else counts as nothing rather than crashing a
    // scheduled job.
    const raw = Array.isArray(data) ? (data[0] as unknown) : (data as unknown);
    const expired =
      typeof raw === 'number'
        ? raw
        : Number((raw as { expired?: number } | null)?.expired ?? 0) || 0;

    if (expired > 0) {
      masterBus.emit('BALANCE_UPDATED', { source: 'cashout_expired' });
      console.debug(`[Cashout] Expired ${expired} stale cashouts and refunded the escrow`);
    }

    return { expired };
  }
}

// Export singleton
export const cashoutService = new CashoutServiceClass();
