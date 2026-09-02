/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNION API SERVICE — World Hub ORB-4 union routes
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * UNION AUDIT FIX 2026-07-21: every union MUTATION must go through the World
 * Hub API routes (/api/club-arena/manage-union, union-wallet,
 * union-application). The union tables (unions, union_clubs, union_admins,
 * union_wallets) are service-role-write-only under RLS, so the SPA's old
 * direct Supabase writes silently failed for real browser users — union
 * create, settings saves, club joins, commission edits and every wallet
 * transfer were no-ops outside of service-role test scripts.
 *
 * Reads stay direct-to-Supabase where a SELECT policy exists (unions,
 * union_clubs, union_wallet_transactions, and union_wallets for admins).
 */

import { supabase } from '../lib/supabase';

interface ApiResult<T = Record<string, unknown>> {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

async function callUnionApi<T = Record<string, unknown>>(
  endpoint: 'manage-union' | 'union-wallet' | 'union-application',
  body: Record<string, unknown>,
  opts: { idempotent?: boolean } = {}
): Promise<ApiResult<T> & T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (opts.idempotent !== false) {
    headers['X-Idempotency-Key'] = crypto.randomUUID();
  }

  const response = await fetch(`/api/club-arena/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await response
    .json()
    .catch(() => ({ success: false, error: `HTTP ${response.status}` }));
  if (!data.success) {
    throw new Error(data.error || `Union API request failed (HTTP ${response.status})`);
  }
  return data;
}

export const unionApi = {
  // ── manage-union ──────────────────────────────────────────────────────────
  createUnion(name: string, description: string, settings?: Record<string, unknown>) {
    return callUnionApi('manage-union', { action: 'create', name, description, settings });
  },
  updateSettings(
    unionId: string,
    updates: { name?: string; description?: string; settings?: Record<string, unknown> }
  ) {
    return callUnionApi('manage-union', { action: 'update_settings', unionId, ...updates });
  },
  updateClubCommission(unionId: string, clubId: string, commissionRate: number) {
    return callUnionApi('manage-union', {
      action: 'update_club_commission',
      unionId,
      clubId,
      commissionRate,
    });
  },
  removeClub(unionId: string, clubId: string) {
    return callUnionApi('manage-union', { action: 'remove_club', unionId, clubId });
  },
  addAdmin(unionId: string, adminUserId: string) {
    return callUnionApi('manage-union', {
      action: 'add_admin',
      unionId,
      adminUserId,
      adminRole: 'union_admin',
    });
  },
  removeAdmin(unionId: string, adminUserId: string) {
    return callUnionApi('manage-union', { action: 'remove_admin', unionId, adminUserId });
  },
  /** Broadcast to all clubs (omit clubId) or a single club's feed. */
  announce(unionId: string, message: string, clubId?: string) {
    return callUnionApi('manage-union', { action: 'union_announcement', unionId, message, clubId });
  },
  /** Club owner asks to exit the union; the union lead approves/denies. */
  requestLeave(unionId: string, clubId: string, reason?: string) {
    return callUnionApi('manage-union', {
      action: 'request_leave',
      unionId,
      clubId,
      message: reason,
    });
  },
  listLeaveRequests(unionId: string) {
    return callUnionApi('manage-union', { action: 'list_leave', unionId }, { idempotent: false });
  },
  approveLeave(unionId: string, leaveRequestId: string) {
    return callUnionApi('manage-union', { action: 'approve_leave', unionId, leaveRequestId });
  },
  denyLeave(unionId: string, leaveRequestId: string) {
    return callUnionApi('manage-union', { action: 'deny_leave', unionId, leaveRequestId });
  },

  // ── union-application ─────────────────────────────────────────────────────
  apply(unionId: string, clubId: string, message?: string) {
    return callUnionApi('union-application', { action: 'apply', unionId, clubId, message });
  },
  applicationStatus(unionId: string, clubId: string) {
    return callUnionApi(
      'union-application',
      { action: 'status', unionId, clubId },
      { idempotent: false }
    );
  },
  listApplications(unionId: string, statusFilter = 'pending') {
    return callUnionApi(
      'union-application',
      { action: 'list', unionId, statusFilter },
      { idempotent: false }
    );
  },
  approveApplication(unionId: string, applicationId: string, commissionRate?: number) {
    return callUnionApi('union-application', {
      action: 'approve',
      unionId,
      applicationId,
      commissionRate,
    });
  },
  rejectApplication(unionId: string, applicationId: string, reason?: string) {
    return callUnionApi('union-application', { action: 'reject', unionId, applicationId, reason });
  },

  // ── union-wallet ──────────────────────────────────────────────────────────
  walletBalances(unionId: string) {
    return callUnionApi('union-wallet', { action: 'get_balances', unionId }, { idempotent: false });
  },
  walletTransactions(unionId: string, wallet?: string) {
    return callUnionApi(
      'union-wallet',
      { action: 'get_transactions', unionId, wallet },
      { idempotent: false }
    );
  },
  sendToClub(unionId: string, clubId: string, amount: number, notes?: string) {
    return callUnionApi('union-wallet', { action: 'send_to_club', unionId, clubId, amount, notes });
  },
  moveRakeToChips(unionId: string, amount: number, notes?: string) {
    return callUnionApi('union-wallet', { action: 'move_rake_to_chips', unionId, amount, notes });
  },
  processBbjPayout(params: {
    unionId: string;
    clubId: string;
    payoutAmount: number;
    winnerId: string;
    loserId: string;
    tableShare?: number;
    poolId?: string;
    payoutEventId?: string;
  }) {
    const { unionId, clubId, ...rest } = params;
    return callUnionApi('union-wallet', {
      action: 'process_bbj_payout',
      unionId,
      clubId,
      ...rest,
      // BBJ unification: per-event UUID gives DB-level payout dedup — a retry
      // or double-click can never pay the same jackpot twice. (Set AFTER the
      // spread so an undefined params.payoutEventId cannot clobber it.)
      payoutEventId: params.payoutEventId || crypto.randomUUID(),
    });
  },
  /** Move chips from the union bank into the shared BBJ jackpot pool. */
  fundBbjPool(unionId: string, amount: number, notes?: string) {
    return callUnionApi('union-wallet', { action: 'fund_bbj_pool', unionId, amount, notes });
  },
  /**
   * Move chips into the union's Spin reserve wallet, the capital every Spin
   * bonus pool this union owns is seeded from.
   *
   * fromWallet is required and is one of three real wallets. The database
   * function behind this reads a missing source as an operator deposit and
   * MINTS the chips, so there is deliberately no way to omit it from here.
   *
   * callUnionApi sends a fresh X-Idempotency-Key per call, which the endpoint
   * passes to the RPC as its op id. Two deliberate clicks are two funds; a
   * retry of one request is one.
   */
  fundSpinReserve(
    unionId: string,
    amount: number,
    fromWallet: 'promo_wallet' | 'rake_wallet' | 'chip_balance',
    notes?: string
  ) {
    return callUnionApi('union-wallet', {
      action: 'fund_spin_reserve',
      unionId,
      amount,
      fromWallet,
      notes,
    });
  },

  // ── Treasury detail reads (Dan 2026-08-24) ────────────────────────────────
  // "Rake treasury should open up to see all the data for all rake
  // accumulated" / "back up BBJ needs to be clickable as well and expand to
  // see data and transaction history and stats etc."
  //
  // Both are reads, so idempotent:false — they must not burn an idempotency
  // key, and re-requesting one is always safe.

  /** Wallet balance vs lifetime ledger, 30 days by day and by club, last 50 rows. */
  rakeDetail(unionId: string) {
    return callUnionApi(
      'union-wallet',
      { action: 'get_rake_detail', unionId },
      { idempotent: false }
    );
  },

  /**
   * The three BBJ banks, the live split against the 50/25/25 house rule, who
   * was credited for funding them, and recent jackpot movements.
   */
  bbjDetail(unionId: string) {
    return callUnionApi(
      'union-wallet',
      { action: 'get_bbj_detail', unionId },
      { idempotent: false }
    );
  },

  /**
   * Move chips out of the BACKUP jackpot bank.
   *
   * Only two destinations exist and both stay inside the union's own money:
   * 'main' tops the live jackpot back up, 'promo' credits union_wallets
   * .promo_wallet (NOT the pool's promo bank — different balances). There is
   * deliberately no club destination: backup is jackpot liability owed to
   * players, and paying it into a club treasury would turn player money into
   * operator money in one call.
   */
  bbjBackupTransfer(
    unionId: string,
    amount: number,
    destination: 'main' | 'promo',
    notes?: string
  ) {
    return callUnionApi('union-wallet', {
      action: 'bbj_backup_transfer',
      unionId,
      amount,
      destination,
      notes,
    });
  },

  /**
   * Spend the promo wallet: into a member club's treasury, or into the main
   * jackpot. clubId is required for 'club' and the endpoint rejects the call
   * without it; fn_union_promo_send independently verifies the club is in
   * this union, without which this would be a chip mint into any club.
   */
  promoSend(
    unionId: string,
    amount: number,
    destination: 'club' | 'bbj_main',
    clubId?: string,
    notes?: string
  ) {
    return callUnionApi('union-wallet', {
      action: 'promo_send',
      unionId,
      amount,
      destination,
      clubId,
      notes,
    });
  },
};

export default unionApi;
