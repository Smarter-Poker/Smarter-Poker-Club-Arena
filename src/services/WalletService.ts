/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WALLET SERVICE — Complete Triple-Wallet System
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Core financial operations for Club Arena.
 * Implements the Triple-Wallet architecture:
 * - BUSINESS Wallet: Commissions, settlements, withdrawals
 * - PLAYER Wallet: Table buy-ins, gameplay chips
 * - PROMO Wallet: Bonuses, giveaways, leaderboard rewards
 *
 * MINT RATE (Dan 2026-08-21, BINDING): 100 Diamonds = 10,000 Chips.
 */

import { supabase, getAuthUser } from '../lib/supabase';
import {
  assertChipAmount,
  runAgentWalletOperation,
  confirmedAgentWalletReceipt,
} from './AgentWalletIntent';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { retryAsync } from '../utils/retryAsync';
import { retryFetch } from '../utils/retryFetch';
import { masterBus } from '../core/MasterBus';
import { FinancialAlertService } from './FinancialAlertService';
import { reportError } from '../utils/errorReporter';
import { useUserStore } from '../stores/useUserStore';

// ═══════════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY (Audit finding M1)
// ═══════════════════════════════════════════════════════════════════════════════
//
// AUDIT M17: `newIdempotencyKey` is removed along with its one caller.
//
// It existed for M1: client money RPCs are wrapped in retryAsync, so a
// commit-then-timeout could re-apply a credit unless every retry of one logical
// operation shared a key. That reasoning was correct, and it is now moot from
// this side — the client no longer initiates a wallet credit at all. Both
// generic credit wrappers are revoked from `authenticated`, and every client
// feature that used to credit now calls a purpose-built SECURITY DEFINER
// function that owns its own idempotency key, derived from the thing being paid
// for (`bonus:<id>`, `cashout:<seat_id>`, `daily_bonus:<user>:<date>`).
//
// That is the stronger design regardless of grants: a key minted by the browser
// only de-duplicates retries the browser knows about, whereas a key derived
// from the underlying row de-duplicates against every path that could pay it,
// including the engine's.
//
// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type WalletType = 'BUSINESS' | 'PLAYER' | 'PROMO';

export interface WalletBalance {
  userId: string;
  walletType: WalletType;
  balance: number;
  lockedBalance: number; // Chips currently at tables
  availableBalance: number;
  lastUpdated: string;
}

export interface TransferRequest {
  fromWallet: WalletType;
  toWallet: WalletType;
  amount: number;
  note?: string;
}

export interface TransactionRecord {
  id: string;
  userId: string;
  walletType: WalletType;
  amount: number;
  type: 'credit' | 'debit';
  category:
    | 'mint'
    | 'transfer'
    | 'buyin'
    | 'cashout'
    | 'rake'
    | 'commission'
    | 'promo'
    | 'settlement';
  description: string;
  relatedEntityId?: string;
  createdAt: string;
}

export interface ChipMintResult {
  success: boolean;
  chipsAdded: number;
  diamondsSpent: number;
  newBalance: number;
  /** Reason for a failed mint, surfaced to the user instead of a generic retry. */
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const WalletService = {
  // ─────────────────────────────────────────────────────────────────────────────
  // BALANCE QUERIES
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get all wallet balances for a user, FROM THE LIVE POOLS.
   *
   * ═══ THIS READ USED TO COME OFF A FROZEN TABLE (fixed 2026-08-27) ═══
   *
   * It read `public.wallets`, which has taken no write since
   * 2026-08-21 00:59 UTC (club-arena CLAUDE.md 11.5: "public.wallets is NOT
   * the live chip pool ... 732,591,994.33 chips stranded in it"). The rule
   * said "nothing reads it" — eleven call sites did, this one feeding
   * `useWalletStore`, which feeds `useCanAfford` and the "Playable Now" and
   * "Chips In Escrow" figures on PlayerWalletPage.
   *
   * The numbers were not zero, which is what made this survive: they were
   * SIX DAYS STALE AND PLAUSIBLE. Measured on production the day of the fix,
   * the frozen PLAYER pool summed to 732,581,244.32 against a real economy of
   * 121,018,710.03 — six times the chips that exist — and one sampled player
   * read 3,313,727.73 against a true balance of 34,818.60, a 95x lie rendered
   * as a formatted, confident number.
   *
   * THE LIVE POOLS, which every server money path actually moves:
   *   PLAYER   club_members.chip_balance   (+ locked_chips held at tables)
   *   PROMO    club_members.promo_balance
   *   BUSINESS agents.agent_wallet_balance (agents only; 0 for everyone else)
   *
   * Club-scoped by nature, so the totals here are the player's chips summed
   * across their clubs. What is SPENDABLE at a given table is a different and
   * narrower question — `readPlayerBalance` answers that with the same RPC the
   * buy-in itself uses, and callers gating a spend must use that, not this.
   */
  async getBalances(userId: string): Promise<WalletBalance[]> {
    const [membersRes, agentRes] = await Promise.all([
      supabase
        .from('club_members')
        .select('chip_balance, promo_balance, locked_chips')
        .eq('user_id', userId),
      /* AN AGENT IS AN AGENT PER CLUB, SO THERE IS RARELY ONE ROW (2026-09-05).
         This was `.maybeSingle()`, and `agents` is UNIQUE on (club_id, user_id)
         - a user who agents for two clubs has two rows, and maybeSingle answers
         PGRST116 "Results contain 2 rows". The `if (agentRes.error) throw`
         below then aborted the WHOLE read, so the club_members chips that had
         already loaded fine were thrown away with it: Playable Now, All
         Wallets, Player, Promo and Business every one of them rendered 0.
         Measured on production the day this was found: 16 users held more than
         one agents row, and every one of them saw an empty wallet. Dan's own
         account was one - 1,000,744.97 chips across four clubs and an 80,000
         agent balance, all of it reading zero.
         Summed, not picked: the Business wallet is "Commissions And
         Settlements", so it is the sum across the clubs the player agents for,
         exactly as PLAYER is the sum across their club memberships. */
      supabase.from('agents').select('agent_wallet_balance').eq('user_id', userId),
    ]);

    /* ABSORBED FROM THE CASHIER AUDIT (2026-08-27, P2), whose fix landed on
       main against the OLD body of this method: it added Number() coercion
       because PostgREST can return numeric columns as STRINGS, and a string
       minus a string is NaN — which string-concatenated into the wallet
       page's hero figure. That hazard is real and is handled below: every
       value goes through `num()` before it is summed or subtracted. Their
       patch hardened the arithmetic on a frozen source; this removes the
       frozen source and keeps the hardening. */
    if (membersRes.error) throw membersRes.error;
    // A non-agent has no `agents` row. That is a legitimate zero, not a
    // failure — only a real query error is worth throwing over.
    if (agentRes.error) throw agentRes.error;

    const rows = membersRes.data || [];
    const num = (v: unknown) => Number(v ?? 0) || 0;
    const playerTotal = rows.reduce((sum, r) => sum + num(r.chip_balance), 0);
    const playerLocked = rows.reduce((sum, r) => sum + num(r.locked_chips), 0);
    const promoTotal = rows.reduce((sum, r) => sum + num(r.promo_balance), 0);
    const businessTotal = (agentRes.data || []).reduce(
      (sum, r) => sum + num(r.agent_wallet_balance),
      0
    );
    const lastUpdated = new Date().toISOString();

    const make = (
      walletType: WalletType,
      balance: number,
      lockedBalance: number
    ): WalletBalance => ({
      userId,
      walletType,
      balance,
      lockedBalance,
      // `balance` is what the player holds; `locked_chips` is the part of it
      // already committed to a table. Available is the remainder, floored at
      // zero so a mid-flight lock can never render a negative "Playable Now".
      availableBalance: Math.max(0, balance - lockedBalance),
      lastUpdated,
    });

    return [
      make('PLAYER' as WalletType, playerTotal, playerLocked),
      make('PROMO' as WalletType, promoTotal, 0),
      make('BUSINESS' as WalletType, businessTotal, 0),
    ];
  },

  // AUDIT 2026-08-25: `getWalletBalance` and `getTotalAvailable` are deleted.
  //
  // Neither had a single call site anywhere in src/ or tests/, and both were
  // actively wrong in ways that would have bitten whoever used them next:
  //
  //   getWalletBalance THREW ("Wallet PLAYER not found for user X") when the
  //   row simply did not exist. A user who has never been provisioned has no
  //   row and a balance of zero; raising for that turns an ordinary state into
  //   an error on a display path. `readPlayerBalance` below is the correct
  //   shape - it distinguishes "zero" from "could not find out".
  //
  //   getTotalAvailable ADDED THE THREE WALLET TYPES TOGETHER and returned one
  //   number. BUSINESS is commissions and settlements, PLAYER is what buys into
  //   a game, PROMO is bonus chips with their own rules. They are three
  //   accounts; a single figure spanning them cannot be spent, cannot be
  //   reconciled, and is exactly the conflation this pass exists to remove
  //   (see the hero label on PlayerWalletPage for the same fix, made visible).
  //   Anyone who needs a total should say what it is a total OF.

  // ─────────────────────────────────────────────────────────────────────────────
  // CHIP MINTING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Mint chips using diamonds.
   *
   * MINTING RULES:
   * - If the club belongs to a Union, ONLY the Union owner can mint chips.
   *   The club's mint functionality is LOCKED once they join a union.
   *   All chips must originate from the Union level and flow down.
   * - If the club is standalone (no union affiliation), the club owner can mint directly.
   *
   * MINT RATE (Dan 2026-08-21, BINDING): 100 Diamonds = 10,000 Chips.
   */
  async mintChips(
    clubId: string,
    chipAmount: number,
    requestingUserId?: string
  ): Promise<ChipMintResult> {
    // Resolve the authenticated minter. Server-side authorization is enforced by
    // mint_club_chips (which now rejects a null minter), but we resolve it here so
    // the union-lock check below is never silently skipped when a caller omits the
    // id — previously callers that passed no requestingUserId bypassed the lock.
    let minterId = requestingUserId;
    if (!minterId) {
      const authData = await import('../lib/authUtils').then((m) => m.readLocalSession());
      minterId = authData?.userId;
    }
    if (!minterId) throw new Error('Authentication required to mint chips');

    // clubId from a route param may be an integer club_id; resolve to the uuid PK so
    // the lookup and the mint_club_chips RPC (uuid arg) don't reject it.
    const resolvedClubId = await resolveClubUUID(clubId);

    // 1. Check if club belongs to a union
    const { data: club } = await supabase
      .from('clubs')
      .select('id, name, owner_id, union_id')
      .eq('id', resolvedClubId)
      .maybeSingle();

    if (!club) throw new Error('Club not found');

    // 2. If club is in a union, minting must go through the union owner
    if (club.union_id) {
      const { data: union } = await supabase
        .from('unions')
        .select('id, owner_id, name')
        .eq('id', club.union_id)
        .maybeSingle();

      if (!union) throw new Error('Union not found');

      // Only the union owner can mint — club owners cannot mint when in a union
      if (minterId !== union.owner_id) {
        throw new Error(
          `Minting is locked for clubs in a union. Only the Union owner (${union.name}) can mint chips. ` +
            `Contact your union owner for chip allocation.`
        );
      }
    }

    // ── Dan 2026-08-21, BINDING: "100 DIAMONDS EQUALS 10,000 CHIPS." ──
    // The old 38-per-100 "75% cheaper law" is superseded. One rate, one place.
    // NOTE (audit 2026-08-21): this legacy path calls /api/club-arena/mint-chips
    // -> mint_club_chips, which credits the pool WITHOUT burning diamonds. The
    // diamond-backed mint is fn_mint_chips_from_diamonds (ChipMintModal). This
    // figure is therefore display-only here; do not treat it as a charge.
    const diamondCost = Math.ceil(chipAmount / 100);

    // Mint SERVER-SIDE via the World Hub API route. mint_club_chips is
    // service_role-only, so a direct browser supabase.rpc() returns 42501 -- that
    // was the dead "Mint" button this replaces. The route derives the minter from
    // the JWT (no client-supplied minter to spoof), enforces owner/union-admin
    // authorization, per-request + daily economy caps, settlement lock,
    // idempotency, and writes the chip_transactions mint row + audit log.
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('Authentication required to mint chips');

    const mintResp = await fetch('/api/club-arena/mint-chips', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        clubId: resolvedClubId,
        amount: chipAmount,
        notes: club.union_id ? 'Union mint' : 'Standalone club mint',
      }),
    });
    const mintData = await mintResp
      .json()
      .catch(() => ({ success: false, error: `HTTP ${mintResp.status}` }));
    if (!mintData.success) {
      throw new Error(mintData.error || `Mint failed (HTTP ${mintResp.status})`);
    }

    // 4. Determine who receives the minted chips
    const mintRecipientId = club.union_id
      ? (await supabase.from('unions').select('owner_id').eq('id', club.union_id).maybeSingle())
          .data?.owner_id
      : club.owner_id;

    // 5. Log mint transaction with full audit trail
    if (mintRecipientId) {
      await this.logTransaction(
        mintRecipientId,
        'PLAYER',
        chipAmount,
        'credit',
        'mint',
        club.union_id
          ? `Union mint: ${chipAmount} chips for ${club.name} (${diamondCost} diamonds spent)`
          : `Club mint: ${chipAmount} chips (${diamondCost} diamonds spent) - standalone club`,
        undefined,
        undefined,
        clubId
      );
    }

    // Emit bus event so other pages (CashierPage, ClubFinancials) refresh instantly
    masterBus.emit('BALANCE_UPDATED', {
      source: 'mint',
      userId: mintRecipientId || clubId,
      amount: chipAmount,
    });

    return {
      success: true,
      chipsAdded: chipAmount,
      diamondsSpent: diamondCost,
      newBalance: mintData.treasuryAfter ?? 0,
    };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // TRANSFERS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Transfer funds between wallets (same user)
   */
  async internalTransfer(userId: string, request: TransferRequest): Promise<boolean> {
    if (!Number.isFinite(request.amount) || request.amount <= 0)
      throw new Error('Transfer amount must be positive');
    if (request.fromWallet === request.toWallet) throw new Error('Cannot transfer to same wallet');

    const desc = request.note || `Transfer ${request.fromWallet} → ${request.toWallet}`;
    // Atomic wallet-TYPE transfer for a single user via SECURITY DEFINER RPC.
    // fn_wallet_type_transfer moves chips between wallet types (BUSINESS/PLAYER/PROMO)
    // in ONE transaction, honoring the real from/to wallets — this replaces the old
    // atomic_deduct + atomic_credit pair which was hardcoded to PLAYER (cross-wallet
    // no-op, plus a deduct-then-credit chip-loss edge if the credit leg failed).
    // 2026-08-27: retryAsync REMOVED from this call. fn_wallet_type_transfer
    // takes no idempotency key, so an automatic retry after a network-layer
    // REJECT (a thrown fetch, not a resolved { error }) could re-run a
    // transfer whose first attempt had committed - the double-move shape. The
    // wallet_user_transfer call below argues 42501 resolves rather than
    // throws; that argument never covered thrown rejects and was never made
    // for this call site at all. One attempt: a failure surfaces, and the
    // user retries deliberately.
    const { data: transferRes, error } = await supabase.rpc('fn_wallet_type_transfer', {
      p_user_id: userId,
      p_from_wallet: request.fromWallet,
      p_to_wallet: request.toWallet,
      p_amount: request.amount,
      p_note: desc,
    });

    if (error) throw error;
    if (transferRes?.success !== true) {
      throw new Error(transferRes?.error || 'Insufficient balance for transfer');
    }

    // Both history entries are part of the database transaction. A browser
    // insert here would duplicate them and could fail after money committed.
    if (
      transferRes.from !== request.fromWallet ||
      transferRes.to !== request.toWallet ||
      transferRes.amount !== request.amount ||
      !Number.isFinite(transferRes.from_balance) ||
      !Number.isFinite(transferRes.to_balance) ||
      transferRes.from_balance < 0 ||
      transferRes.to_balance < 0
    ) {
      throw new Error('Transfer receipt was not confirmed for the requested wallets and amount');
    }

    // Emit bus event so UI (header balances, cashier) updates immediately
    masterBus.emit('BALANCE_UPDATED', { source: 'internal_transfer', userId });

    return true;
  },

  /**
   * Agent self-transfer: Business → Player (to play at tables)
   */
  async agentSelfTransfer(clubId: string, amount: number): Promise<boolean> {
    assertChipAmount(amount);
    const { data: auth, error: authError } = await getAuthUser();
    if (authError || !auth.user) throw new Error('Sign In Before Transferring Chips');
    const resolvedId = (await resolveClubUUID(clubId)) || clubId;
    return runAgentWalletOperation(
      {
        userId: auth.user.id,
        clubId: resolvedId,
        targetId: auth.user.id,
        kind: 'self_stake',
        amount,
      },
      async (operation) => {
        const { data, error } = await supabase.rpc('fn_agent_wallet_self_stake', {
          p_club_id: resolvedId,
          p_amount: amount,
          p_reason: 'Agent Wallet To Own Player Wallet',
          p_op_id: operation.operationId,
        });
        if (error) throw error;
        if (!confirmedAgentWalletReceipt(data, amount, 'self_stake')) {
          throw new Error(data?.error || 'Transfer Was Not Confirmed By The Server');
        }
        masterBus.emit('BALANCE_UPDATED', { source: 'agent_self_stake', userId: auth.user.id });
      }
    );
  },

  /**
   * Legacy user-to-user transfer. This RPC has no operation key, so a lost
   * response must not trigger another submission. Only a positive server
   * receipt can authorize success events and the application audit entries.
   */
  async transferToUser(
    fromUserId: string,
    toUserId: string,
    amount: number,
    fromWallet: WalletType = 'PLAYER',
    toWallet: WalletType = 'PLAYER'
  ): Promise<boolean> {
    if (!Number.isFinite(amount) || amount <= 0)
      throw new Error('Transfer amount must be positive');

    const { data: transferData, error } = await supabase.rpc('wallet_user_transfer', {
      p_from_user_id: fromUserId,
      p_to_user_id: toUserId,
      p_amount: amount,
      p_from_wallet: fromWallet,
      p_to_wallet: toWallet,
    });

    if (error) throw error;
    const parsed = transferData as { success?: boolean; error?: string } | null;
    if (parsed?.success !== true) {
      throw new Error(parsed?.error || 'Transfer was not confirmed by the server');
    }

    // Log both sides of the user-to-user transfer
    await this.logTransaction(
      fromUserId,
      fromWallet,
      amount,
      'debit',
      'transfer',
      `Sent ${amount} chips to user`,
      undefined,
      undefined,
      toUserId
    );
    await this.logTransaction(
      toUserId,
      toWallet,
      amount,
      'credit',
      'transfer',
      `Received ${amount} chips from user`,
      undefined,
      undefined,
      fromUserId
    );

    // Emit bus events for both users so their UIs update immediately
    masterBus.emit('BALANCE_UPDATED', { source: 'transfer_sent', userId: fromUserId });
    masterBus.emit('BALANCE_UPDATED', { source: 'transfer_received', userId: toUserId });

    return true;
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // PROMO DISTRIBUTION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Disburse promo chips to a player, through the one owner door.
   *
   * Dan, 2026-09-03: "PROMO FUNDS ARE PAID DIRECTLY TO CLUBS, OR PLAYERS
   * DIRECTLY FROM THE UNION OWNER (OR CLUB OWNERS WITHOUT ANY UNION
   * AFFILIATION)." So the promo float belongs to the union when the club is in
   * one, and to the club itself when it is not; the database enforces that only
   * that owner may spend it. The chips land as ORDINARY cashable chips, because
   * promo chips are ordinary chips - they were raked out of the pots.
   *
   * This replaced `distribute_promo_chips`, which debited `agents.promo_balance`
   * - a column no sweep has maintained since the promo sweep was written, and
   * which is 0.00 estate-wide - and was granted to `service_role` only, so it
   * returned 42501 from any browser. It never moved a chip.
   */
  async disbursePromo(
    clubId: string,
    playerId: string,
    amount: number,
    note?: string
  ): Promise<boolean> {
    if (amount <= 0) throw new Error('Amount must be positive');

    // The union holds the promo float for its member clubs; an unaffiliated
    // club holds its own.
    const { data: club, error: clubErr } = await supabase
      .from('clubs')
      .select('id, union_id')
      .eq('id', clubId)
      .maybeSingle();
    if (clubErr) throw clubErr;
    if (!club) throw new Error('Club not found');

    // One payment identity survives every network retry, including a lost commit response.
    const operationId = crypto.randomUUID();
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('fn_promo_disburse', {
          p_source_kind: club.union_id ? 'union' : 'club',
          p_source_id: club.union_id ?? clubId,
          p_target_kind: 'player',
          p_target_id: playerId,
          p_amount: amount,
          p_note: note ?? null,
          p_club_id: clubId,
          p_op_id: operationId,
        }),
      3
    );

    if (error) throw error;
    // A { success: false } body must never report as a paid disbursement.
    const parsed = data as { success?: boolean; error?: string } | null;
    if (parsed?.success !== true) {
      throw new Error(parsed?.error || 'Promo disbursement outcome is unconfirmed');
    }

    masterBus.emit('BALANCE_UPDATED', { source: 'promo', userId: playerId });

    return true;
  },

  /**
   * @deprecated Kept so nothing calls the retired agent path by accident.
   * Use `disbursePromo(clubId, playerId, amount)`.
   */
  async distributePromo(_agentId: string, _playerId: string, _amount: number): Promise<boolean> {
    throw new Error(
      'distributePromo is retired: promo is disbursed by the union owner, or by an unaffiliated ' +
        'club owner, through WalletService.disbursePromo(clubId, playerId, amount).'
    );
  },

  /**
   * Bulk promo distribution (leaderboard rewards, etc.)
   */
  async bulkDistributePromo(
    clubId: string,
    distributions: Array<{ playerId: string; amount: number }>
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const dist of distributions) {
      try {
        await this.disbursePromo(clubId, dist.playerId, dist.amount);
        success++;
      } catch (err) {
        reportError(err, 'WalletService.bulkDistributePromo', { playerId: dist.playerId });
        failed++;
      }
    }

    return { success, failed };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // TABLE OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Lock chips for table buy-in
   * Deducts from Player Wallet (wallets table) using atomic RPC
   * Chip flow: Union → Club Bank → Agent Wallet → Player Wallet → Table Buy-in
   *
   * ── DORMANT, AND WOULD FAIL IF IT WERE NOT (verified 2026-08-25) ──────────
   * The note below already says `atomic_deduct_wallet_and_log` is service-role
   * only; the ACL confirms it (postgres + service_role, no `authenticated`), so
   * the "RPC returns false if insufficient balance" path is unreachable from a
   * browser — the call returns 42501 first and this throws "Buy-in failed:
   * permission denied for function atomic_deduct_wallet_and_log".
   *
   * Nothing reaches it today: the only caller is `useWalletStore.buyIn`, and
   * that store method has no UI call site left. Real buy-ins go through
   * `atomic_table_buyin` on the engine, which is the correct owner. Left in
   * place with the reason written down rather than deleted, because deleting it
   * would also mean editing useWalletStore, which is outside this pass.
   */
  async lockForBuyIn(userId: string, tableId: string, amount: number): Promise<boolean> {
    // VALIDATION: Prevent negative/zero/non-integer amounts before RPC call
    if (!amount || amount <= 0 || !Number.isFinite(amount)) {
      throw new Error('Buy-in amount must be a positive number');
    }

    // Atomically deduct from Player Wallet AND LOG using SECURITY DEFINER RPC.
    // The RPC returns false if insufficient balance —- no separate pre-check needed.
    // (Removing the pre-check eliminates a TOCTOU race condition where two concurrent
    // buy-ins could both pass the SELECT check but one would fail the deduct.)
    // NOTE (Audit M1): buy-in DEDUCTION is engine-owned — atomic_deduct_wallet_and_log
    // is service-role only, so client-side idempotency belongs on the server buy-in
    // path (atomic_table_buyin), not here. The cash-out CREDIT path (unlockFromTable)
    // is the client-initiated money mover and is made idempotent below.
    const { data: deductResult, error: deductError } = await retryAsync(async () => {
      const res = await supabase.rpc('atomic_deduct_wallet_and_log', {
        p_user_id: userId,
        p_amount: amount,
        p_category: 'buyin',
        p_description: 'Cash game buy-in at table',
        p_table_id: tableId,
        p_hand_id: null,
        p_related_entity_id: null,
      });
      return res;
    });

    if (deductError) {
      reportError(deductError, 'WalletService.lockForBuyIn', { userId, tableId, amount });
      throw new Error(`Buy-in failed: ${deductError.message}`);
    }

    if (deductResult === false) {
      throw new Error('Insufficient chips in Player Wallet for buy-in');
    }

    // Emit bus event so CashierPage/PlayerWalletPage refresh balances
    masterBus.emit('BALANCE_UPDATED', { source: 'buyin', userId, tableId });

    console.debug(
      `[WalletService] Buy-in: ${amount} chips deducted from Player Wallet for user ${userId} and logged`
    );
    return true;
  },

  // AUDIT M17: `unlockFromTable` is deleted, not repaired.
  //
  // It was the client-initiated cash-out: it credited the PLAYER wallet with the
  // amount the player TYPED INTO THE CASHIER, through a generic credit RPC, with
  // no seat-stack decrement anywhere on the path. `useWalletStore` adjusted
  // `locked` optimistically in browser memory and reverted on throw, which is
  // presentation, not accounting. So the only thing standing between this
  // function and an unlimited chip mint was the RLS policy that refused the
  // credit — which is also why M1's idempotency fix for this exact call site
  // could never have taken effect.
  //
  // Table cash-out is engine-owned. `TablePage.handleWithdrawChips` calls
  // `GameServerAPI.removeChips` -> `atomic_table_withdraw`, which credits the
  // wallet and reduces the seat stack atomically, only between hands, using the
  // authoritative stack rather than a text box. Leaving a table entirely goes
  // through the engine's `markSeatAsLeft`, which credits the actual seat stack
  // and refuses to vacate the seat if the credit fails.
  //
  // The Cashier now routes the player to the table instead of moving money,
  // exactly as its 'buyin' branch already did for the same reason.

  /**
   * Log a wallet transaction for audit trail.
   *
   * ── 2026-08-24: THIS NO LONGER WRITES FROM THE BROWSER. ──────────────────
   *
   * It never could. `log_wallet_transaction` is not SECURITY DEFINER and is
   * granted to service_role only, and `chip_ledger` grants `authenticated`
   * SELECT but not INSERT. Production logs for a single 3-hour window on
   * 2026-08-24 show 125 "permission denied for function log_wallet_transaction"
   * and 124 "permission denied for table chip_ledger" - a 100% failure rate for
   * as long as both have existed. `CashoutService` already carries the note:
   * "log_wallet_transaction is service_role-only and would silently no-op."
   *
   * What made it expensive rather than merely useless: the RPC was wrapped in
   * retryAsync(..., 3), so each call retried a PERMANENT authorization error
   * three times; the chip_ledger insert failed alongside it; and every failure
   * then awaited FinancialAlertService.logCritical(), which is itself another
   * database write. One doomed audit log therefore cost roughly six round trips
   * and raised a false "audit trail gap" CRITICAL alert - on a database already
   * saturated enough to be cancelling ~20 statements a minute. It also meant
   * the genuine critical-alert channel was full of noise.
   *
   * THE AUDIT TRAIL IS NOT LOST, because the browser was never the one keeping
   * it. Every real movement of money is written to `wallet_transactions`
   * server-side, inside the same transaction as the movement itself, by the
   * SECURITY DEFINER RPC that performs it: atomic_table_buyin,
   * atomic_table_cashout, atomic_table_rebuy, atomic_table_withdraw,
   * atomic_credit_wallet_and_log, atomic_distribute_rake, atomic_seat_horse and
   * atomic_table_addon. That is strictly better bookkeeping than a best-effort
   * client write, which could succeed while the money move failed, or vice
   * versa.
   *
   * These are deliberately NOT granted to `authenticated` to make the client
   * write work: doing so would let any logged-in user forge ledger rows for any
   * user with arbitrary amounts. The denial is the control working.
   *
   * Remaining gap, tracked and intentionally not papered over here: a few call
   * sites log non-monetary AUDIT NOTES that no atomic RPC writes - an agent
   * promotion (amount 0), a same-person union->club allocation note, a horse
   * seating note. Those need a service-role API route to land anywhere real.
   * Until that route exists they are reported once, locally, instead of
   * pretending to persist. See MIGRATION-CHANGELOG 2026-08-24.
   */
  async logTransaction(
    userId: string,
    walletType: string,
    amount: number,
    type: 'credit' | 'debit',
    category: string,
    description: string,
    tableId?: string,
    handId?: string,
    relatedEntityId?: string
  ): Promise<void> {
    // No network call. See the block comment above: both writes this used to
    // attempt are refused by the database for `authenticated`, deliberately, and
    // the authoritative row is written server-side by the atomic_* RPC that
    // moved the money. Retrying a permanent authorization error three times and
    // then raising a false CRITICAL alert cost ~6 database round trips per call
    // and produced nothing.
    //
    // Kept as a no-op rather than deleted at ~11 call sites so the intent stays
    // visible and the service-role route that will carry the non-monetary audit
    // notes has an obvious seam to land on.
    if (import.meta.env?.DEV) {
      console.debug('[WalletService.logTransaction] no-op (server-authoritative audit)', {
        userId,
        walletType,
        amount,
        type,
        category,
        description,
        tableId,
        handId,
        relatedEntityId,
      });
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // TRANSACTION HISTORY
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get transaction history for a user
   */
  async getTransactionHistory(
    userId: string,
    options?: {
      walletType?: WalletType;
      category?: TransactionRecord['category'];
      limit?: number;
      offset?: number;
    }
  ): Promise<TransactionRecord[]> {
    let query = supabase
      .from('wallet_transactions')
      .select(
        'id, user_id, wallet_type, amount, type, category, description, related_entity_id, created_at'
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(options?.limit || 50);

    if (options?.walletType) {
      query = query.eq('wallet_type', options.walletType);
    }
    if (options?.category) {
      query = query.eq('category', options.category);
    }
    if (options?.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
    }

    const { data, error } = await query;
    if (error) throw error;

    return data.map((t) => ({
      id: t.id,
      userId: t.user_id,
      walletType: t.wallet_type as WalletType,
      amount: t.amount,
      type: t.type,
      category: t.category,
      description: t.description,
      relatedEntityId: t.related_entity_id,
      createdAt: t.created_at,
    }));
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // SETTLEMENT OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  // AUDIT 2026-08-25: `creditCommission` and `creditRakeback` are deleted.
  //
  // They are the last two client-side wallet-CREDIT wrappers, and AUDIT M17 at
  // the top of this file already states the position: "the client no longer
  // initiates a wallet credit at all". These two were simply missed.
  //
  // Neither had a call site. Neither could have worked if it had one:
  // `credit_agent_commission` and `credit_player_rakeback` are both granted
  // EXECUTE to `postgres` and `service_role` only, so a browser call returns
  // 42501 - which is the control working, exactly as the logTransaction note
  // below explains. Settlement and rakeback are paid server-side by the
  // process that computes them, inside the same transaction, with an
  // idempotency key derived from the period rather than minted by a browser.

  // NOTE: dealer tipping was REMOVED ENTIRELY on 2026-08-20, by product
  // decision — Smarter Poker does not have dealers to tip and will not be
  // adding the feature. Everything that implemented it is gone: this service's
  // processDealerTip, the TipDealer modal, GameServerAPI.tipDealer, the
  // POST /tipdealer route, the engine's tipDealer method, and both database
  // functions (atomic_table_dealer_tip and deduct_table_chip_lock).
  //
  // Kept as a note because the old path was actively dangerous and should not
  // be recreated from memory: it called deduct_table_chip_lock from the
  // browser, writing table_seats.stack while the authoritative engine held a
  // different figure in memory. The next settlement overwrote the DB from
  // memory, so the player's stack came back while clubs.chip_treasury kept the
  // tip — it MINTED chips. Verified against prod before removal: zero rows had
  // ever been written with category 'TIP', so nothing was lost.

  // NOTE: processInsurance was removed — insurance is settled server-side by the
  // authoritative engine (it called the non-existent deduct_table_chip_lock RPC
  // and had zero call sites in the client).

  // ─────────────────────────────────────────────────────────────────────────────
  // DIRECT WALLET READS (routed from bypassing queries)
  // ─────────────────────────────────────────────────────────────────────────────

  // AUDIT 2026-08-25: `getWallet` and `getWallets` are deleted. Zero call
  // sites, and both collapsed a FAILED READ into an empty result - `getWallet`
  // returned null for both "no row" and "query refused", `getWallets` returned
  // [] for both. That is the ambiguity readPlayerBalance below was written to
  // escape, duplicated twice over. `getBalances` remains for the one caller
  // that needs the full set (useWalletStore).

  // AUDIT 2026-08-27: `getPlayerBalance` is DELETED, and it is the same
  // deletion as `getWallet`/`getWallets` above for the same reason.
  //
  // Its whole body was `return r.balance ?? 0` - it existed to turn "we could
  // not find out" into a definite zero, which its own docstring admitted and
  // which the 2026-08-25 audit had already called out as the cause of
  // "Insufficient Balance" on a funded player's sign-up dialog. That audit
  // fixed the ONE call site it was looking at and left the helper, so five
  // more sites kept the defect:
  //
  //   useGlobalBalanceSync   wrote the false 0 into useUserStore.totalChips -
  //                          the GLOBAL figure the whole app renders, so one
  //                          refused read blanked a funded player everywhere
  //   ChipTransferModal      `senderBalance` gates the send, so a false 0
  //                          BLOCKED AN AGENT FROM SENDING CHIPS THEY HELD
  //   TablePage x3           buy-in sheet, add-on affordability, realtime
  //                          balance resync
  //
  // All five now call `readPlayerBalance` and leave the last known good value
  // in place when it answers null - the rule `useWalletStore.loadBalances`
  // already states: "a transient network failure must not replace a good
  // number with zeros on screen". A `number`-returning shorthand cannot
  // express "unknown", so there is no safe version of this helper to keep.
  // If you want the number, call readPlayerBalance and decide what null means
  // AT THE CALL SITE, where the consequence is visible.

  /**
   * The same read, but it tells you whether it WORKED.
   *
   * 2026-08-25 (second audit). `getPlayerBalance` collapses every failure —
   * RPC error, RLS denial, an unresolvable club id, a dropped connection —
   * into the number 0, because a `?? 0` is the only sane return type for a
   * function that must hand back a number. That is fine for a display, and
   * actively dangerous for a GATE: the buy-in dialog read 0, concluded
   * "insufficient balance" and DISABLED Confirm for a player who was perfectly
   * well funded. A read that never happened is not a balance of zero.
   *
   * `balance: null` means "we could not find out". Callers that gate on funds
   * must treat that as unknown and let the server decide — the buy-in RPC
   * refuses an underfunded entry anyway, so failing open costs nothing and
   * failing closed locks people out of games they can afford.
   */
  async readPlayerBalance(
    userId: string,
    opts?: { clubId?: string | null; tableId?: string | null }
  ): Promise<{ balance: number | null; source: 'rpc' | 'wallet' | 'failed' }> {
    // UNION LAW (Dan 2026-08-20): under club-scoped chips a player spends the
    // chips of the club they entered through, not the global player wallet.
    // fn_player_spendable_balance resolves this with EXACTLY the same rule the
    // buy-in uses, so what we display can never disagree with what the
    // transaction will actually spend. Falls back to the global wallet when
    // club scoping is off or no club context resolves.
    try {
      // If opts.clubId is explicitly passed (even as null), use it. Otherwise fall back to currentClubId.
      const clubId =
        opts && 'clubId' in opts ? opts.clubId : (useUserStore.getState().currentClubId ?? null);
      const { data, error } = await retryFetch(
        () =>
          supabase
            .rpc('fn_player_spendable_balance', {
              p_user_id: userId,
              p_club_id: clubId,
              p_table_id: opts?.tableId ?? null,
            })
            .then((result) => result),
        { maxRetries: 4, baseDelayMs: 500 }
      );
      if (!error && data && typeof (data as any).balance !== 'undefined') {
        return { balance: Number((data as any).balance) || 0, source: 'rpc' };
      }
    } catch {
      /* fall through to the legacy wallet read */
    }
    /* ═══ THE FALLBACK WAS A FROZEN READ, AND IS GONE (2026-08-27) ═══
       This used to fall back to `public.wallets`, a pool that has taken no
       write since 2026-08-21 and reads up to 95x high (see getBalances). A
       fallback that answers with a confidently wrong number is worse than one
       that admits it does not know: this function's own contract says
       `balance: null` means "we could not find out", and that callers gating
       a spend must let the server decide, because the buy-in RPC refuses an
       underfunded entry anyway. So failing to 'unknown' costs nothing and
       cannot authorise a spend against six-day-old chips. */
    reportError(
      new Error('fn_player_spendable_balance did not answer; no live fallback exists'),
      'WalletService.readPlayerBalance',
      { userId }
    );
    return { balance: null, source: 'failed' };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // WALLET PROVISIONING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Ensure wallets exist for a user. Creates zero-balance wallets idempotently.
   * Use this instead of direct .from('wallets').insert() to ensure consistent
   * schema and avoid race conditions.
   *
   * @param userId - User ID
   * @param walletTypes - Array of wallet types to ensure exist (default: all three)
   */
  async ensureWalletsExist(
    _userId: string,
    _walletTypes: WalletType[] = ['PLAYER', 'BUSINESS', 'PROMO']
  ): Promise<void> {
    /* ═══ RETIRED 2026-08-27 — IT PROVISIONED ROWS IN THE FROZEN POOL ═══
       This upserted zero-balance rows into `public.wallets`, which has been
       frozen since 2026-08-21. That is a money path writing to the dead pool,
       which club-arena CLAUDE.md 11.5 names as broken by definition. It was
       harmless only by luck: the rows it wrote carried balance 0, so they did
       not move the pool's total and did not trip the freeze-invariant check
       added the same week — a nonzero write would have.

       Nothing needs provisioning now. The live pools create their own rows:
       `club_members` on join, `agents` on promotion (its caller in
       AgentService creates the agents row on the very next statement). Kept as
       a no-op rather than deleted so an in-flight caller cannot throw; the
       parameters keep their names, underscored, so the signature still reads.
       Remove the call sites and then this, in that order. */
    return;
  },
};

export default WalletService;
