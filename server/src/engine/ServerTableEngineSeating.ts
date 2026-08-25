/**
 * ServerTableEngine, layer 2/8 — buy-ins, cash-outs, sit-out/leave, admin locks, BB entry.
 *
 * Split out of the 5,623-line `src/engine/ServerTableEngine.ts` monolith on
 * 2026-08-08 (every deploy tool in this pipeline caps a single file at ~50 KB).
 * Behavior is preserved line-for-line: the only edits are module boundaries,
 * `private` widened to `protected` across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import {
  syncStacks,
  markSeatAsLeft,
  atomicCashout,
  processLeavePending,
  supabase,
} from '../services/supabase.js';
import type { SeatedPlayer } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { randomUUID } from 'node:crypto';
import { ServerTableEngineBase } from './ServerTableEngineBase.js';

export abstract class ServerTableEngineSeating extends ServerTableEngineBase {
  /**
   * AUDIT FIX 2026-07-19: `POST /addchips` previously credited the stack with
   * NO wallet debit and no buy-in cap — a seated player could mint chips. Now
   * the amount is capped to the table max buy-in BEFORE any money moves, and
   * the player's PLAYER wallet is debited atomically via `atomic_table_addon`;
   * the stack is only credited if that debit succeeds.
   *
   *  - Between hands: the RPC also bumps table_seats.stack (apply_to_seat=true)
   *    and we credit the in-memory stack immediately.
   *  - Mid-hand: the RPC debits the wallet only (the engine owns the live stack
   *    and persists it in postHandTasks) AND writes a durable row into
   *    `table_pending_addons` in the same transaction. The in-memory
   *    `pendingAddOns` map is now only a cache for the buy-in cap arithmetic
   *    below; the ledger row is the source of truth for delivery.
   *
   * A2 FIX (2026-08-08): before the ledger existed, mid-hand chips lived ONLY
   * in that in-memory map. A crash between the wallet debit and the end of the
   * hand meant the player was charged and the chips were never delivered and
   * never refunded — money simply gone, with nothing on disk to reconcile
   * against. The row now lands atomically with the debit, so the two can never
   * be separated by a crash.
   */
  public async addChips(
    userId: string,
    amount: number
  ): Promise<{ success: boolean; error?: string; queued?: boolean; applied?: number }> {
    const player = this.seatedPlayers.find((p) => p.user_id === userId);
    if (!player) return { success: false, error: 'Player not seated' };
    if (!(amount > 0)) return { success: false, error: 'Invalid amount' };

    const maxBuyIn = this.getMaxBuyIn();
    const midHand = !!this.handController;

    // Effective current chips for the cap: mid-hand include already-queued
    // (already-debited) pending add-ons so we never exceed the ceiling.
    const pending = this.pendingAddOns.get(userId) || 0;
    const effectiveStack = midHand ? player.stack + pending : player.stack;
    const headroom = Math.max(0, maxBuyIn - effectiveStack);
    const applied = Math.min(amount, headroom);
    if (applied <= 0) {
      return { success: false, error: 'Already at the maximum buy-in for this table' };
    }

    /**
     * FIX 2026-08-20 [P1]: retry the debit under a STABLE idempotency key.
     *
     * The between-hands branch applies the chips to table_seats inside the RPC,
     * and the engine only mirrors that into `player.stack` on success. So a
     * transaction that COMMITTED but whose response never arrived left the
     * player charged, the seat credited, and the engine unaware — and the next
     * syncStacks, which writes `stack` ABSOLUTELY from engine memory, erased
     * the chips while the wallet stayed debited. The mid-hand branch has been
     * covered by the table_pending_addons ledger since the A2 fix; this branch
     * had nothing.
     *
     * One key, generated once, used for every attempt: if the first attempt
     * actually committed, the second is a DB-side no-op that returns the
     * current balance, so we learn the chips landed instead of dropping them.
     */
    const addOnKey = `addon:${this.tableId}:${userId}:${randomUUID()}`;
    let lastError: { message?: string } | null = null;
    let debited = false;
    for (let attempt = 1; attempt <= 2 && !debited; attempt++) {
      const { error } = await supabase.rpc('atomic_table_addon', {
        p_user_id: userId,
        p_table_id: this.tableId,
        p_amount: applied,
        p_apply_to_seat: !midHand,
        p_idempotency_key: addOnKey,
      });
      if (!error) {
        debited = true;
        break;
      }
      lastError = error;
      // "Insufficient balance" is a verdict, not a transport failure — retrying
      // it just asks the same question twice.
      if (/insufficient/i.test(String(error.message || ''))) break;
      if (attempt === 1) await new Promise((r) => setTimeout(r, 250));
    }
    if (!debited) {
      const msg = String(lastError?.message || '');
      const clean = /insufficient/i.test(msg) ? 'Insufficient wallet balance' : 'Add-on failed';
      reportError(lastError, `ServerTableEngine.${this.tableId}.addChips_debit_failed`, {
        userId,
        amount: applied,
        idempotencyKey: addOnKey,
      });
      return { success: false, error: clean };
    }

    if (midHand) {
      // AUDIT M5: `pending` was captured before the `await atomic_table_addon`
      // above. On the single-threaded event loop another addChips for this same
      // user can interleave at that await and update pendingAddOns in between;
      // accumulating onto the stale snapshot would drop the concurrent add-on
      // from the buy-in-cap arithmetic (the durable table_pending_addons ledger
      // is unaffected and still delivers every debited chip — this map is only
      // the cap cache). Re-read the live value and accumulate onto that.
      const livePending = this.pendingAddOns.get(userId) || 0;
      this.pendingAddOns.set(userId, livePending + applied);
      // A2: a durable ledger row now exists (written by the RPC in the same
      // transaction as the debit). Make sure the next sweep looks for it.
      this.pendingAddOnSweepNeeded = true;
      console.log(
        `[ServerTableEngine:${this.tableId}] Add-on debited + queued for ${userId}: +${applied} (pending ${livePending + applied}) — hand in progress`
      );
      this.broadcastCurrentState();
      return { success: true, queued: true, applied };
    }

    // Between hands — wallet debited AND table_seats bumped by the RPC.
    player.stack += applied;
    this.broadcastCurrentState();
    return { success: true, applied };
  }

  /**
   * Server-authoritative partial cash-out (withdraw) — the mirror of `addChips`.
   *
   *  - Between hands: `atomic_table_withdraw` CREDITS the player's PLAYER wallet
   *    by `amount` and REDUCES `table_seats.stack` by the same amount
   *    (apply_to_seat=true); we reduce the in-memory stack immediately and
   *    broadcast. The RPC guards `amount > 0` and `amount <= seated stack`, so
   *    an over-withdraw is rejected atomically and no chips are minted.
   *  - Mid-hand: rejected outright — a player may not cash out chips that are
   *    live in a hand. Unlike an add-on, this is NOT queued.
   */
  public async withdrawChips(
    userId: string,
    amount: number
  ): Promise<{ success: boolean; error?: string }> {
    const player = this.seatedPlayers.find((p) => p.user_id === userId);
    if (!player) return { success: false, error: 'Player not seated' };
    if (!(amount > 0)) return { success: false, error: 'Invalid amount' };

    const midHand = !!this.handController;

    // Mid-hand cash-out is not allowed (do NOT queue).
    if (midHand) {
      return { success: false, error: 'Cannot cash out during a hand' };
    }

    // Guard client-side too so we can surface a clean message; the RPC also
    // rejects over-withdraw atomically as the authoritative check.
    if (amount > player.stack) {
      return { success: false, error: 'Cannot withdraw more than your table stack' };
    }

    // Credit the wallet AND reduce table_seats.stack atomically (between hands).
    const { error } = await supabase.rpc('atomic_table_withdraw', {
      p_user_id: userId,
      p_table_id: this.tableId,
      p_amount: amount,
      p_apply_to_seat: true,
    });
    if (error) {
      const msg = String(error.message || '');
      const clean = /exceeds seated stack/i.test(msg)
        ? 'Cannot withdraw more than your table stack'
        : 'Cash-out failed';
      reportError(error, `ServerTableEngine.${this.tableId}.withdrawChips_credit_failed`, {
        userId,
        amount,
      });
      return { success: false, error: clean };
    }

    // Between hands — wallet credited AND table_seats reduced by the RPC.
    player.stack -= amount;
    this.broadcastCurrentState();
    return { success: true };
  }

  /**
   * A2 FIX (2026-08-08): deliver pending add-ons from the DURABLE ledger.
   *
   * This used to iterate the in-memory `pendingAddOns` map, apply the chips to
   * the stack in JS, write `table_seats` directly, and refund the excess with a
   * second unkeyed RPC. Three ways to lose money: the map died with the
   * process; the stack write and the refund were separate non-atomic steps; and
   * a retry of either could double-apply.
   *
   * Now every unresolved `table_pending_addons` row for this table is handed to
   * `resolve_pending_addon`, which — in ONE transaction, with the row and the
   * seat locked — caps the add-on at the max buy-in, bumps `table_seats.stack`,
   * refunds any excess through `atomic_credit_wallet_and_log` under the
   * idempotency key `addon_refund:<row id>`, and stamps the row resolved. A
   * second call on an already-resolved row is a no-op that echoes what the
   * first call did, so retries, concurrent engines and crash-recovery sweeps
   * all converge instead of compounding.
   *
   * A row we fail to resolve is deliberately LEFT OPEN — the next hand (or the
   * next engine start) picks it up. Nothing is dropped on the floor.
   */
  protected async processPendingAddOns(players: SeatedPlayer[]): Promise<void> {
    if (!this.pendingAddOnSweepNeeded && this.pendingAddOns.size === 0) return;

    const maxBuyIn = this.getMaxBuyIn();

    const { data: rows, error: readErr } = await supabase
      .from('table_pending_addons')
      .select('id, user_id, amount')
      .eq('table_id', this.tableId)
      .is('resolved_at', null);

    if (readErr) {
      // Leave the map and the ledger alone; retry on the next hand.
      reportError(readErr, `ServerTableEngine.${this.tableId}.pending_addon_read_failed`);
      return;
    }
    if (!rows || rows.length === 0) {
      this.pendingAddOns.clear();
      this.pendingAddOnSweepNeeded = false;
      return;
    }

    let delivered = 0;
    let unresolved = 0;
    for (const row of rows as Array<{ id: string; user_id: string; amount: number }>) {
      const { data, error: resolveErr } = await supabase.rpc('resolve_pending_addon', {
        p_pending_id: row.id,
        p_max_buy_in: maxBuyIn,
      });

      if (resolveErr) {
        // Row stays unresolved -> retried next hand / next start. No chips move.
        reportError(resolveErr, `ServerTableEngine.${this.tableId}.pending_addon_resolve_failed`, {
          userId: row.user_id,
          pendingId: row.id,
          amount: row.amount,
        });
        unresolved++;
        continue;
      }

      const result = Array.isArray(data) ? data[0] : data;
      const applied = Number(result?.applied ?? 0);
      const refunded = Number(result?.refunded ?? 0);
      const wasResolvedByUs = result?.was_resolved !== false;

      // Mirror the DB's decision into the live in-memory stack. The RPC has
      // already written table_seats, so this only keeps the engine's view in
      // step until the next loadSeatedPlayers re-reads it.
      if (wasResolvedByUs && applied > 0) {
        const player = players.find((p) => p.user_id === row.user_id);
        if (player) player.stack = Math.round((player.stack + applied) * 100) / 100;
        delivered++;
      }

      console.log(
        `[ServerTableEngine:${this.tableId}] Pending add-on ${row.id} for ${row.user_id}: ` +
          `debited ${row.amount}, applied ${applied}, refunded ${refunded}` +
          (wasResolvedByUs ? '' : ' (already resolved elsewhere — no-op)')
      );
    }

    // Only forget the in-memory cache once the ledger agrees it is empty. If a
    // row could not be resolved, keep the sweep flag set so the next hand — or
    // the next engine start — tries again rather than stranding the money.
    if (unresolved === 0) {
      this.pendingAddOns.clear();
      this.pendingAddOnSweepNeeded = false;
    } else {
      this.pendingAddOnSweepNeeded = true;
    }
    if (delivered > 0) this.broadcastCurrentState();
  }

  /**
   * A2 FIX (2026-08-08): crash-recovery sweep, run on engine start.
   *
   * `processPendingAddOns` only runs at the end of a hand. If the process died
   * mid-hand and the table then sat idle, the debited-but-undelivered rows
   * would wait forever for a hand that never comes. This resolves them against
   * the seats as they currently stand — a player who is no longer seated simply
   * gets the whole amount refunded by the RPC.
   */
  protected async resolveOrphanedAddOns(): Promise<void> {
    try {
      await this.processPendingAddOns(this.seatedPlayers);
    } catch (err) {
      reportError(err, `ServerTableEngine.${this.tableId}.orphaned_addon_sweep_failed`);
    }
  }

  /**
   * @deprecated DEAD as of the A2 durable ledger — zero callers repo-wide.
   *
   * Refunds now happen inside resolve_pending_addon, keyed `addon_refund:<row
   * id>`, in the same transaction that resolves the ledger row. This helper is
   * retained only because a future non-ledger add-on path might need it, and it
   * is documented as dead so nobody calls it ALONGSIDE the RPC and refunds the
   * same chips twice. If you reach for this, pass an idempotency key.
   *
   * Refund unused add-on chips back to the player's PLAYER wallet (the same
   * balance atomic_table_addon debited). Uses atomic_credit_wallet_and_log so
   * the refund is logged and matches the debit side.
   */
  protected async _refundAddOnToWallet(
    userId: string,
    amount: number,
    idempotencyKey?: string
  ): Promise<void> {
    if (amount <= 0) return;
    try {
      const { error } = await supabase.rpc('atomic_credit_wallet_and_log', {
        p_user_id: userId,
        p_amount: amount,
        p_category: 'addon_refund',
        p_description: 'Add-on exceeded table max buy-in — refunded',
        p_table_id: this.tableId,
        p_hand_id: null,
        p_related_entity_id: null,
        // A2 FIX: the ledger path (resolve_pending_addon) keys its own refund on
        // `addon_refund:<row id>`. This helper is now only a fallback for
        // callers that have no ledger row, but it must still be keyable — an
        // unkeyed refund inside any retry is a mint waiting to happen.
        p_idempotency_key: idempotencyKey ?? null,
      });
      if (error) {
        reportError(error, `ServerTableEngine.${this.tableId}.addon_refund_failed`, {
          userId,
          amount,
        });
      } else {
        console.log(
          `[ServerTableEngine:${this.tableId}] Refunded ${amount} chips to ${userId}'s PLAYER wallet`
        );
      }
    } catch (err) {
      reportError(err, `ServerTableEngine.${this.tableId}.addon_refund_failed`, {
        userId,
        amount,
      });
    }
  }

  /**
   * POST /sitout — Bible V8 §7.12: Player sits out or back in
   */
  public sitOut(
    userId: string,
    sitOut: boolean
  ): { success: boolean; error?: string; willFoldNextHand: boolean } {
    const player = this.seatedPlayers.find((p) => p.user_id === userId);
    if (!player) {
      return { success: false, error: 'Player not found at this table', willFoldNextHand: false };
    }

    if (sitOut) {
      // FIX 143: Bible V8 §7.12 — Can't fold mid-hand.
      // If a hand is in progress, defer the sit-out until after the hand completes.
      // The player continues playing the current hand normally.
      if (this.handController !== null) {
        this.pendingSitOut.add(userId);
      } else {
        this.disconnectEngine.sitOut(this.tableId, userId, 'voluntary');
      }
    } else {
      // Cancel any pending sit-out
      this.pendingSitOut.delete(userId);
      this.disconnectEngine.sitBack(this.tableId, userId);
      // Bible V8 §4.2: Mark player as returning — must post dead blind on next hand (cash tables only)
      if (!this.isTournamentTable()) {
        this.returningFromSitout.add(userId);
      }
    }

    // FIX 143: willFoldNextHand is informational — player finishes current hand normally
    const willFoldNextHand = sitOut && this.handController !== null;

    return { success: true, willFoldNextHand };
  }

  /**
   * POST /leave — Player leaves the table. If mid-hand, auto-fold then mark leave_pending.
   * If between hands, mark seat as left immediately.
   */
  public leaveTable(userId: string): { success: boolean; error?: string; immediate: boolean } {
    const player = this.seatedPlayers.find((p) => p.user_id === userId);
    if (!player) {
      // Dan 2026-08-20 (leave-stuck fix): `seatedPlayers` is the HAND roster,
      // reloaded from the DB at each hand start. A player who reserved a seat
      // mid-hand ("Seat Reserved, you'll be dealt in next hand") is legally
      // absent from it. The old response was a hard failure -> HTTP 400 ->
      // TableService refused to cash out -> the player could NEVER leave while
      // waiting to be dealt in; the seat stayed reserved forever. The engine
      // holds no in-memory state for this player (no live stack, not in any
      // hand), so the departure is trivially safe to acknowledge: return
      // success + immediate so the client proceeds with atomic DB cashout,
      // exactly like the engine-not-running branch of the /leave handler.
      console.log(
        `[ServerTableEngine:${this.tableId}] leave for ${userId}: not in hand roster (reserved/waiting) — acking, client handles DB cleanup`
      );
      return { success: true, immediate: true };
    }

    // Phase X5 (2026-04-29) — Bible V8 §1.16 seat_left discrete event so
    // every connected client (including spectators) can re-render the
    // empty seat without diffing the next state snapshot.
    this.hub?.emitEvent(this.tableId, {
      type: 'seat_left',
      table_id: this.tableId,
      seat: player.seat_number,
      user_id: userId,
      mid_hand: this.handController !== null,
      timestamp: Date.now(),
    });

    if (this.handController !== null) {
      // Mid-hand: fold the player immediately if it's their turn or they're still in
      const state = this.handController.getState();
      const enginePlayer = state.players.find((p) => p.user_id === userId);

      if (enginePlayer && !enginePlayer.is_folded && !enginePlayer.is_all_in) {
        // FIX 2026-08-22: performAction RETURNS FALSE when it isn't the
        // player's turn — it does not throw (FreezeRegression pins this), so
        // the old catch-and-assume-"they'll be skipped" comment was wrong:
        // the leaving player stayed live in the hand and the disconnect
        // auto-action later CHECKED them down every street. If the immediate
        // fold doesn't land, queue an auto_fold pre-action so they fold the
        // moment action reaches them.
        let folded = false;
        try {
          folded = this.handController.performAction(enginePlayer.seat, 'fold') === true;
          if (folded) {
            console.log(
              `[ServerTableEngine:${this.tableId}] Player ${userId} auto-folded on leave`
            );
          }
        } catch (err) {
          console.warn(`[ServerTableEngine:${this.tableId}] Auto-fold on leave threw: ${err}`);
        }
        if (!folded) {
          this.preActionEngine.setPreAction(this.tableId, userId, 'auto_fold');
          console.log(
            `[ServerTableEngine:${this.tableId}] Player ${userId} left out of turn — auto_fold queued`
          );
        }
      }

      // Mark as leave_pending — processLeavePending will handle cashout at end of hand
      supabase
        .from('table_seats')
        .update({ leave_pending: true, status: 'sitting_out' })
        .eq('table_id', this.tableId)
        .eq('user_id', userId)
        .is('left_at', null)
        .then(({ error }) => {
          if (error)
            console.warn(`[ServerTableEngine] leave_pending update failed:`, error.message);
        });

      // Also mark in disconnect engine so they don't get dealt next hand
      this.disconnectEngine.sitOut(this.tableId, userId, 'voluntary');

      return { success: true, immediate: false };
    } else {
      // Between hands: remove immediately via atomic cashout.
      // AUDIT FIX 2026-07-19: the hand controller is nulled at HAND_COMPLETE
      // BEFORE postHandTasks (which runs syncStacks) finishes. A leave arriving
      // in that window would take this branch and cash out the STALE pre-hand
      // seat stack — the pot won vanishes (or a bust is refunded). Wait for any
      // in-flight settlement to persist the final stack first.
      const finishCashout = () =>
        atomicCashout(userId, this.tableId, player.seat_number)
          .then(() => {
            console.log(
              `[ServerTableEngine:${this.tableId}] Player ${userId} left table immediately (between hands)`
            );
            this.disconnectEngine.unregisterPlayer(this.tableId, userId);
            this.timeBankEngine.removePlayer(this.tableId, userId);
            this.straddleEngine.removePlayer(this.tableId, userId);
            this.preActionEngine.removePlayer(this.tableId, userId);
          })
          .catch((err) => {
            console.warn(`[ServerTableEngine:${this.tableId}] atomicCashout on leave failed:`, err);
            markSeatAsLeft(this.tableId, userId, player.seat_number);
            this.disconnectEngine.unregisterPlayer(this.tableId, userId);
            this.timeBankEngine.removePlayer(this.tableId, userId);
            this.straddleEngine.removePlayer(this.tableId, userId);
            this.preActionEngine.removePlayer(this.tableId, userId);
          });

      if (this.postHandTasksPromise) {
        // Settlement for the just-finished hand is still writing stacks — cash
        // out only after it lands.
        this.postHandTasksPromise.then(finishCashout, finishCashout);
      } else {
        finishCashout();
      }

      return { success: true, immediate: true };
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Bible V8 §6.17: ADMIN PAUSE / MAINTENANCE LOCK
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * POST /admin/pause — Bible V8 §6.17: Admin pause. Current hand finishes, then no new hands.
   */
  public adminPause(reason?: string): { success: boolean } {
    this.adminPauseLock = true;
    console.log(
      `[ServerTableEngine:${this.tableId}] Admin pause activated${reason ? `: ${reason}` : ''}`
    );
    // Phase X5 (2026-04-29) — Bible V8 §1.16 table_paused discrete event so
    // clients can render the paused-overlay + suppress the action timer.
    this.hub?.emitEvent(this.tableId, {
      type: 'table_paused',
      table_id: this.tableId,
      reason: reason ?? null,
      timestamp: Date.now(),
    });
    return { success: true };
  }

  /**
   * POST /admin/resume — Bible V8 §6.17: Resume dealing after admin pause.
   */
  public adminResume(): { success: boolean } {
    this.adminPauseLock = false;
    this.maintenanceLock = false;
    if (this.tableFSM.state === 'paused') {
      this.tableFSM.transition('running');
    }
    console.log(`[ServerTableEngine:${this.tableId}] Admin resume — dealing will continue`);
    // Phase X5 (2026-04-29) — Bible V8 §1.16 table_resumed discrete event.
    this.hub?.emitEvent(this.tableId, {
      type: 'table_resumed',
      table_id: this.tableId,
      timestamp: Date.now(),
    });
    return { success: true };
  }

  /**
   * POST /admin/maintenance — Bible V8 §6.17: Full maintenance lock. No hands, no new joins.
   */
  public setMaintenanceLock(locked: boolean): { success: boolean } {
    this.maintenanceLock = locked;
    if (locked && this.tableFSM.state === 'running') {
      this.tableFSM.transition('paused');
    }
    console.log(`[ServerTableEngine:${this.tableId}] Maintenance lock: ${locked}`);
    return { success: true };
  }

  /**
   * Bible V8 §4.2: Register a new player as waiting-for-BB.
   * Called when a player sits down at a table with wait_for_big_blind enabled.
   * The player cannot play until the BB position rotates to their seat.
   */
  public registerWaitForBB(userId: string): void {
    if (this.tableInfo?.wait_for_big_blind && !this.isTournamentTable()) {
      this.waitingForBB.add(userId);
    }
  }

  /**
   * Bible V8 §4.2: Player opts to "Post BB" to enter immediately.
   * When a new player sits at a cash game, they choose: post the BB now to be dealt
   * in immediately, OR wait for the BB to reach their seat naturally.
   * If they post, they pay 1× BB as a live blind and get dealt into the current hand.
   */
  public postBBToEnter(userId: string): { success: boolean; error?: string } {
    if (!this.waitingForBB.has(userId)) {
      return { success: false, error: 'Player is not waiting for BB' };
    }
    this.waitingForBB.delete(userId);
    // AUDIT FIX 2026-07-19: post ONLY a live BB to enter (no dead SB). Route
    // through postingBBToEnter, not returningFromSitout (which owes a dead SB
    // for a MISSED blind).
    this.postingBBToEnter.add(userId);
    return { success: true };
  }

  /**
   * Bible V8 §4.2: Check if a player is currently waiting for BB.
   */
  public isWaitingForBB(userId: string): boolean {
    return this.waitingForBB.has(userId);
  }

  /**
   * POST /straddle — Bible V8 §4.4: Toggle auto-straddle enrollment
   */
  public toggleStraddle(userId: string, enabled: boolean): { success: boolean; error?: string } {
    if (!this.tableInfo?.straddle_enabled) {
      return { success: false, error: 'Straddles are not enabled at this table' };
    }
    this.straddleEngine.toggleAutoStraddle(this.tableId, userId, enabled);
    return { success: true };
  }

  /**
   * Bible V8 §4.21: Player chooses to show hand at showdown (even if not required).
   * Auto-muck: losing hands are hidden unless player explicitly shows.
   */
  public showHand(
    userId: string,
    cardIndexes?: readonly number[]
  ): { success: boolean; error?: string; shownCardIndexes?: number[] } {
    if (!this.handController) {
      return { success: false, error: 'No active hand' };
    }

    // FIX-D3 2026-07-19 (Bible V8 §11): honor the table's show-hand toggle. The
    // column was loaded but never checked, so voluntary show-hand was always
    // allowed even when the host disabled it. Default allowed unless explicitly off.
    if ((this.tableInfo as { show_hand_enabled?: boolean })?.show_hand_enabled === false) {
      return { success: false, error: 'Showing hands is disabled at this table' };
    }

    const state = this.handController.getState();

    // ── Dan 2026-08-18: picking individual cards, any time in the hand ──
    //
    // The whole-hand form still requires showdown: revealing everything while
    // betting is live would leak information mid-hand.
    //
    // Picking SPECIFIC cards is different. The player clicks a card while they
    // are still holding it, and the promise is that it gets shown "after the
    // hand is over" - nothing is exposed at the moment of the click. So the
    // stage gate does not apply to that form; only the deferred reveal does.
    if (!cardIndexes && state.stage !== 'showdown') {
      return { success: false, error: 'Can only show hand during showdown' };
    }

    const player = state.players.find((p) => p.user_id === userId);
    if (!player) {
      return { success: false, error: 'Player not found at this table' };
    }

    if (player.is_folded) {
      return { success: false, error: 'Cannot show a folded hand' };
    }

    if (cardIndexes) {
      // Per-card selection. Validate every index against the hand this player
      // is actually holding, so a crafted request cannot name a card that does
      // not exist (or a negative/fractional index) and desync the reveal.
      const heldCount = player.cards?.length ?? 0;
      if (heldCount === 0) {
        return { success: false, error: 'No cards to show' };
      }
      const valid = cardIndexes.filter((i) => Number.isInteger(i) && i >= 0 && i < heldCount);
      if (valid.length === 0) {
        return { success: false, error: 'No valid card indexes' };
      }

      if (!this.showHandCards) {
        this.showHandCards = new Map<string, Set<number>>();
      }
      // Replace rather than merge: the client sends the player's full current
      // selection, so un-clicking a card has to be able to take it back off
      // the list. Selection is only additive at REVEAL time, never destructive
      // to what the showdown rules already expose.
      this.showHandCards.set(userId, new Set(valid));

      // Deliberately NOT broadcasting the picks. Telling the table which cards
      // someone intends to show, while betting is still live, is itself a tell.
      // The reveal happens at hand end through the normal state broadcast.
      return { success: true, shownCardIndexes: [...valid].sort((a, b) => a - b) };
    }

    // Mark this player as voluntarily showing their hand
    if (!this.showHandPlayers) {
      this.showHandPlayers = new Set<string>();
    }
    this.showHandPlayers.add(userId);

    // Broadcast updated state so this player's cards become visible
    this.broadcastCurrentState();

    return { success: true };
  }
}
