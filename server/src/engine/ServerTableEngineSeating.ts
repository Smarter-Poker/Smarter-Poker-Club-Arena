/**
 * ServerTableEngine, layer 2/8 — buy-ins, cash-outs, sit-out/leave, admin locks, BB entry.
 *
 * Split out of the 5,623-line `src/engine/ServerTableEngine.ts` monolith on
 * 2026-08-08 (every deploy tool in this pipeline caps a single file at ~50 KB).
 * Behavior is preserved line-for-line: the only edits are module boundaries,
 * `private` widened to `protected` across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { supabase, atomicCashout, atomicCashoutVoluntary } from '../services/supabase.js';
import type { SeatedPlayer } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { randomUUID } from 'node:crypto';
import { ServerTableEngineBase } from './ServerTableEngineBase.js';
import { leaveLabel } from './ChipContinuity.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import { INSTANCE_ID } from '../services/tableLease.js';

type ExactPendingAddOnReceipt = {
  ok?: boolean;
  reason?: string;
  table_id?: string;
  lease_generation?: string;
  resolved?: number;
  rows?: Array<{
    id?: string;
    user_id?: string;
    kind?: string;
    applied?: number | string;
    refunded?: number | string;
  }>;
};

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
    amount: number,
    /**
     * Cashier audit 2026-08-27 (P0-1): a CALLER-HELD attempt id. The stable
     * key below only ever de-duplicated the two attempts of one invocation —
     * a second HTTP request minted a fresh randomUUID and a fresh debit, so
     * the exact window the key exists for (commit, then lost response, then
     * the player retries) still double-charged. When the client supplies its
     * per-attempt opId, the key is stable across HTTP retries too; callers
     * without one (the horse rotator) keep the per-invocation key.
     */
    opId?: string
  ): Promise<{ success: boolean; error?: string; queued?: boolean; applied?: number }> {
    if (isMaintenanceFrozen()) {
      return { success: false, error: 'Scheduled maintenance is in progress' };
    }
    const player = this.seatedPlayers.find((p) => p.user_id === userId);
    if (!player) return { success: false, error: 'Player not seated' };
    if (!(amount > 0)) return { success: false, error: 'Invalid amount' };

    const maxBuyIn = this.getMaxBuyIn();
    const midHand = !!this.handController;

    // Effective current chips for the cap: include already-queued (already-
    // debited) pending add-ons so we never exceed the ceiling.
    //
    // IN BOTH BRANCHES (Dan 2026-09-04, the add-on that must "auto adjust").
    // This used to add `pending` only while `midHand`, on the theory that a
    // pending row cannot exist between hands. It can: settlement fires with
    // `void this.handleHandEvent(...)` and `handController` is nulled at
    // once, so between that instant and settlement step 8e (which resolves
    // the ledger) the table is "between hands" with the mid-hand row still
    // unresolved. The client's auto top-up fires in exactly that window (its
    // gate is the early hand_complete broadcast), so it took this branch,
    // ignored the queued 49.95, applied straight to the seat, and the sweep
    // then found no headroom for the row that was queued FIRST and refunded
    // it - the wrong add-on adjusted, and the player told nothing. Counting
    // the queued chips here means the second request is sized to the real
    // remaining room from the start.
    const pending = this.pendingAddOns.get(userId) || 0;
    const effectiveStack = player.stack + pending;
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
    const addOnKey = `addon:${this.tableId}:${userId}:${opId || randomUUID()}`;
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
      this.requestPendingAddOnSweep();
      console.log(
        `[ServerTableEngine:${this.tableId}] Add-on debited + queued for ${userId}: +${applied} (pending ${livePending + applied}) - hand in progress`
      );
      this.broadcastCurrentState();
      return { success: true, queued: true, applied };
    }

    // Between hands — wallet debited AND table_seats bumped by the RPC.
    player.stack += applied;
    // CHIP CONTINUITY (I3): the database raised the baseline with the chips;
    // refresh the mirror so the countdown and the leave lock agree with it.
    void this.chipContinuity
      .evaluate([{ user_id: userId, stack: player.stack, active: this.isContinuityActive(userId) }])
      .then(() => this.broadcastCurrentState())
      .catch((err) =>
        reportError(err, `ServerTableEngine.${this.tableId}.continuity_addon_failed`)
      );
    this.broadcastCurrentState();
    return { success: true, applied };
  }

  /*
   * CHIP CONTINUITY (Operation Table Stakes, Slice 0, 2026-09-04): there is
   * no partial cash-out. `withdrawChips`, `POST /withdrawchips` and the SQL
   * function `atomic_table_withdraw` are gone. Chips on a cash table stay on
   * the table until the player leaves (OPORD 1.3 invariant I1). A tournament
   * stack was never withdrawable. Do not add a path back under another name.
   */

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

    const authority = this.getEngineLeaseAuthority();
    if (authority?.verified === true) {
      /* Protocol 2 freezes mid-hand rows into an accepted hand's immutable
         obligation envelope. A bust rebuy can also arrive while no hand is
         running, though, and waiting for a future envelope would deadlock the
         very hand its chips are needed to start.

         The exact-generation RPC resolves only rows that are NOT frozen in an
         accepted envelope. It shares that processor's per-table database
         mutex and serializes with hand acceptance at the tables-row boundary,
         so this is a disjoint pre-deal owner rather than a legacy second
         consumer. Tournament reloads have their own atomic lifecycle. */
      if (authority.scope !== 'cash') return;
      const genAtStart = this.pendingAddOnSweepGen;
      const beforeStack = new Map(players.map((player) => [player.user_id, Number(player.stack)]));
      let receipt: ExactPendingAddOnReceipt | null = null;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= 2; attempt++) {
        if (!this.hasCurrentEngineLeaseAuthority()) return;
        const { data, error } = await supabase.rpc('fn_ca_resolve_unbound_pending_addons', {
          p_table_id: this.tableId,
          p_max_buy_in: this.getMaxBuyIn(),
          p_instance_id: INSTANCE_ID,
          p_lease_generation: authority.generation,
        });
        if (!this.lifecycleCanMutate()) return;
        if (!error) {
          receipt = (data ?? null) as ExactPendingAddOnReceipt | null;
          break;
        }
        lastError = error;
        if (attempt === 1) await this.sleep(100);
      }

      if (!receipt) {
        reportError(lastError, `ServerTableEngine.${this.tableId}.pending_addon_exact_failed`);
        this.killForRestart('pending_addon_exact_unreachable');
        throw lastError instanceof Error
          ? lastError
          : new Error('Exact pending add-on resolver did not return a receipt');
      }
      if (receipt.ok !== true) {
        const reason = receipt.reason ?? 'malformed_receipt';
        if (reason === 'lease_lost') {
          this.fenceForEngineLeaseLoss('pending_addon_lease_lost', true);
          return;
        }
        const error = new Error(`Exact pending add-on resolver refused (${reason})`);
        reportError(error, `ServerTableEngine.${this.tableId}.pending_addon_exact_refused`);
        this.killForRestart('pending_addon_exact_refused');
        throw error;
      }

      const rows = Array.isArray(receipt.rows) ? receipt.rows : null;
      if (
        receipt.table_id !== this.tableId ||
        receipt.lease_generation?.toLowerCase() !== authority.generation.toLowerCase() ||
        !Number.isSafeInteger(Number(receipt.resolved)) ||
        Number(receipt.resolved) !== rows?.length
      ) {
        const error = new Error('Exact pending add-on resolver returned a malformed receipt');
        reportError(error, `ServerTableEngine.${this.tableId}.pending_addon_exact_malformed`);
        this.killForRestart('pending_addon_exact_malformed');
        throw error;
      }

      /* A committed response may have been lost before the identical retry.
         Re-read absolute seat truth even when the replay resolves zero rows;
         never infer a stack delta from which HTTP response happened to land. */
      const { data: persistedSeats, error: persistedSeatError } = await supabase
        .from('table_seats')
        .select('user_id,stack')
        .eq('table_id', this.tableId)
        .is('left_at', null);
      if (!this.lifecycleCanMutate()) return;
      if (persistedSeatError) {
        reportError(
          persistedSeatError,
          `ServerTableEngine.${this.tableId}.pending_addon_stack_refresh_failed`
        );
        this.killForRestart('pending_addon_stack_refresh_failed');
        throw persistedSeatError;
      }

      const stackByUser = new Map(
        (persistedSeats ?? []).map((seat) => [seat.user_id as string, Number(seat.stack)])
      );
      for (const player of players) {
        const persisted = stackByUser.get(player.user_id);
        if (persisted !== undefined && Number.isFinite(persisted)) player.stack = persisted;
      }

      let delivered = 0;
      for (const row of rows ?? []) {
        const applied = Number(row.applied ?? 0);
        const refunded = Number(row.refunded ?? 0);
        if (typeof row.user_id === 'string') {
          this.tellPlayerAddOnAdjusted(row.user_id, row.kind ?? 'addon', applied, refunded);
        }
        if (!(applied > 0) || !Number.isFinite(applied) || typeof row.user_id !== 'string') {
          continue;
        }
        delivered++;
        const player = players.find((candidate) => candidate.user_id === row.user_id);
        this.hub?.emitEvent(this.tableId, {
          type: 'add_on_applied',
          table_id: this.tableId,
          seat: player?.seat_number ?? null,
          user_id: row.user_id,
          amount: applied,
          stack: stackByUser.get(row.user_id) ?? null,
          kind: row.kind ?? 'addon',
          timestamp: Date.now(),
        });
      }

      this.pendingAddOns.clear();
      if (this.pendingAddOnSweepGen === genAtStart) this.pendingAddOnSweepNeeded = false;
      if (delivered > 0 || [...beforeStack].some(([id, stack]) => stackByUser.get(id) !== stack)) {
        this.broadcastCurrentState();
      }
      return;
    }

    /* CHIP STANDARD C3 (2026-09-02): rows now arrive from outside the engine
       (the browser's bust rebuy goes straight to atomic_table_rebuy). A sweep
       request that lands while THIS sweep's read is in flight must survive
       it, so the flag is only cleared below if the generation is unchanged.
       See pendingAddOnSweepGen on the base. */
    const genAtStart = this.pendingAddOnSweepGen;
    const maxBuyIn = this.getMaxBuyIn();

    const { data: rows, error: readErr } = await supabase
      .from('table_pending_addons')
      .select('id, user_id, amount, kind')
      .eq('table_id', this.tableId)
      .is('resolved_at', null);

    if (!this.lifecycleCanMutate()) return;

    if (readErr) {
      // Leave the map and the ledger alone; retry on the next hand.
      reportError(readErr, `ServerTableEngine.${this.tableId}.pending_addon_read_failed`);
      return;
    }
    if (!rows || rows.length === 0) {
      this.pendingAddOns.clear();
      if (this.pendingAddOnSweepGen === genAtStart) this.pendingAddOnSweepNeeded = false;
      return;
    }

    let delivered = 0;
    let unresolved = 0;
    for (const row of rows as Array<{
      id: string;
      user_id: string;
      amount: number;
      kind?: string | null;
    }>) {
      if (!this.lifecycleCanMutate()) return;
      const { data, error: resolveErr } = await supabase.rpc('resolve_pending_addon', {
        p_pending_id: row.id,
        p_max_buy_in: maxBuyIn,
      });

      if (!this.lifecycleCanMutate()) return;

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
      if (wasResolvedByUs) {
        this.tellPlayerAddOnAdjusted(row.user_id, row.kind ?? 'addon', applied, refunded);
      }

      // Mirror the DB's decision into the live in-memory stack. The RPC has
      // already written table_seats, so this only keeps the engine's view in
      // step until the next loadSeatedPlayers re-reads it.
      if (wasResolvedByUs && applied > 0) {
        const player = players.find((p) => p.user_id === row.user_id);
        if (player) player.stack = Math.round((player.stack + applied) * 100) / 100;
        delivered++;
        /* Dan 2026-09-04: "IF A PLAYER ADDS ON AFTER A HAND, THEY SHOULD GET
           A LITTLE POP UP ABOVE THEIR HEAD. 'HAS ADDED ON FOR XX.XX'."

           This is the ONE place add-on chips land on a stack (the ledger row
           is resolved here and nowhere else), so it is the one place the
           table can be told. `applied`, not `row.amount`: the RPC caps at the
           max buy-in and refunds the rest, and the bubble must say what the
           stack actually gained. Every subscriber sees it — the pop-up is
           for the table, not just the player. */
        this.hub?.emitEvent(this.tableId, {
          type: 'add_on_applied',
          table_id: this.tableId,
          seat: player?.seat_number ?? null,
          user_id: row.user_id,
          amount: applied,
          stack: player?.stack ?? null,
          // 'addon' (topping up a live stack) or 'rebuy' (C3: the bust rebuy
          // rides the same ledger). Same bubble today; the client may differ
          // the wording later without another engine change.
          kind: row.kind ?? 'addon',
          timestamp: Date.now(),
        });
      }

      console.log(
        `[ServerTableEngine:${this.tableId}] Pending add-on ${row.id} for ${row.user_id}: ` +
          `debited ${row.amount}, applied ${applied}, refunded ${refunded}` +
          (wasResolvedByUs ? '' : ' (already resolved elsewhere - no-op)')
      );
    }

    // Only forget the in-memory cache once the ledger agrees it is empty. If a
    // row could not be resolved, keep the sweep flag set so the next hand — or
    // the next engine start — tries again rather than stranding the money.
    if (unresolved === 0) {
      this.pendingAddOns.clear();
      if (this.pendingAddOnSweepGen === genAtStart) this.pendingAddOnSweepNeeded = false;
    } else {
      this.requestPendingAddOnSweep();
    }
    if (delivered > 0) this.broadcastCurrentState();
  }

  /**
   * ═══ THE ADD-ON THAT ADJUSTED ITSELF IS SAID OUT LOUD (Dan 2026-09-04) ═════
   *
   * Dan: "IF YOU ADD ON DURING A HAND ... AND YOU WIN THE POT, THE ADD ON NEEDS
   * TO BE AUTO ADJUSTED. I ADDED ON FOR $49.95 BUT THEN WON THE VERY SMALL
   * POT, MY ADD ON NEEDS TO ADJUST TO ONLY ALLOW FOR $49.95 - REMAINING CHIPS.
   * THIS NEEDS TO BE A REAL TIME ADJUSTMENT."
   *
   * The money side already did this: resolve_pending_addon caps the landing
   * at the max buy-in less the stack AS IT STANDS AFTER THE POT, and refunds
   * the rest to the wallet (his 49.95 landed as 48.88 with 1.07 returned,
   * table_pending_addons row cd60239c). What never happened was TELLING HIM:
   * the client had debited its balance and its session figures by the full
   * 49.95 and the refund reached only a console.log on this box. So the
   * adjustment was real and invisible, which reads as no adjustment at all.
   *
   * A private frame, because it is about one player's wallet. The table-wide
   * `add_on_applied` bubble still says what the stack gained.
   */
  protected tellPlayerAddOnAdjusted(
    userId: string,
    kind: string,
    applied: number,
    refunded: number
  ): void {
    // The hub type carries sendToUser; a test double that only stubs
    // emitEvent must not turn a refund notice into a thrown settlement.
    if (!this.hub || typeof this.hub.sendToUser !== 'function' || !userId) return;
    if (!(refunded > 0) || !Number.isFinite(refunded)) return;
    const safeApplied = Number.isFinite(applied) && applied > 0 ? applied : 0;
    this.hub.sendToUser(this.tableId, userId, {
      kind: 'add_on_adjusted',
      addon_kind: kind,
      requested: Math.round((safeApplied + refunded) * 100) / 100,
      applied: Math.round(safeApplied * 100) / 100,
      refunded: Math.round(refunded * 100) / 100,
      max_buy_in: this.getMaxBuyIn(),
      hand_number: this.handCount,
    });
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
        p_description: 'Add-on exceeded table max buy-in - refunded',
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

    /* PLAY A HAND BEFORE YOU CAN SIT OUT (Dan 2026-08-28, binding):
     * "A PLAYER MUST ALSO PLAY AT LEAST ONE HAND, BEFORE THEY CAN SIT OUT."
     *
     * Without this, sitting down and immediately sitting out is a way to hold a
     * seat at a table you never intend to play — the seat counts toward the
     * table, blocks a paying player, and the only thing that ends it is the
     * five-minute eviction clock, which the player can reset by sitting back in
     * for one beat. The rule closes that door at the point of entry instead.
     *
     * `dealtInUserIds` is the right oracle and already exists for the button
     * rule ("NEW PLAYERS NEVER GET THE BUTTON WHEN SITTING DOWN"): it is
     * per-table, written at the deal, and pruned the moment a seat empties, so
     * a player who leaves and comes back correctly counts as new again. It is
     * also seeded on the engine's first loop pass from whoever is already
     * seated, because anyone seated through a restart was playing before it.
     *
     * Only the OUTBOUND direction is gated. Sitting back IN is always allowed —
     * a player must never be trapped in a sit-out they cannot leave.
     *
     * Tournaments are exempt: a tournament seat is bought and the player is
     * already committed, they are dealt in and blinded off whether they sit out
     * or not, and a late-registered entrant who has not yet been dealt a hand
     * has an obvious legitimate reason to sit out immediately. */
    if (sitOut && !this.isTournamentTable() && !this.dealtInUserIds.has(userId)) {
      return {
        success: false,
        error: 'You Must Play At Least One Hand Before You Can Sit Out',
        willFoldNextHand: false,
      };
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
      // CHIP CONTINUITY: sitting back in withdraws a leave the clock was holding.
      this.leaveHeldByClock.delete(userId);
      this.disconnectEngine.sitBack(this.tableId, userId);
      // Bible V8 §4.2: Mark player as returning — must post dead blind on next hand (cash tables only)
      if (!this.isTournamentTable()) {
        this.returningFromSitout.add(userId);
      }
    }

    // FIX 143: willFoldNextHand is informational — player finishes current hand normally
    const willFoldNextHand = sitOut && this.handController !== null;

    // CHIP CONTINUITY: a sit-out freezes the stay clock, sitting back in
    // resumes it (remainder kept). Reported now rather than waiting for the
    // 10-second presence sweep so the countdown the player sees stops the
    // moment they stop. A pending (mid-hand) sit-out also counts as inactive:
    // isContinuityActive reads pendingSitOut.
    if (!this.isTournamentTable()) {
      void this.chipContinuity
        .evaluate([{ user_id: userId, active: this.isContinuityActive(userId) }])
        .then(() => this.broadcastCurrentState())
        .catch((err) =>
          reportError(err, `ServerTableEngine.${this.tableId}.continuity_sitout_failed`)
        );
    }

    return { success: true, willFoldNextHand };
  }

  /**
   * POST /leave — Player leaves the table. If mid-hand, auto-fold then mark leave_pending.
   * If between hands, mark seat as left immediately.
   */
  public async leaveTable(
    userId: string,
    /**
     * CHIP CONTINUITY (2026-09-04): `forced` marks a SYSTEM exit - the admin
     * kick - which the stay clock never blocks. Everything else that reaches
     * this method (POST /leave, the horse rotator) is the player's own choice
     * and is judged by the clock, mirror first, database second.
     */
    opts: { forced?: boolean; occupancyId?: string; seatNumber?: number } = {}
  ): Promise<{
    success: boolean;
    error?: string;
    immediate: boolean;
    /**
     * CHIP STANDARD C1 (2026-09-02): set ONLY when this engine will not cash
     * the seat out itself and the browser must (a reserved seat the engine
     * never loaded). Absent on the between-hands path, where the engine cashes
     * out after settlement persists the final stack; the browser used to race
     * that with its own cash-out of the stale pre-hand stack.
     */
    clientCashout?: boolean;
    tournament?: boolean;
    /**
     * CHIP CONTINUITY (2026-09-04): 'LEAVE_LOCKED' when the player is ahead
     * of their buy-in with stay clock remaining. `stay_remaining_ms` says how
     * long; `error` is the label the leave control shows. Nothing else.
     */
    code?: 'LEAVE_LOCKED' | 'STALE_OCCUPANCY';
    stay_remaining_ms?: number;
  }> {
    // Capture legacy internal callers' target before joining the boundary.
    // A queued leave must not acquire the identity of a subsequent rejoin.
    const requestedPlayer = this.seatedPlayers.find((p) => p.user_id === userId);
    if (opts.occupancyId === undefined && requestedPlayer?.occupancy_id) {
      opts = {
        ...opts,
        occupancyId: requestedPlayer.occupancy_id,
        seatNumber: requestedPlayer.seat_number,
      };
    }
    const releaseSeatBoundary = await this.acquireSeatBoundary();
    try {
      // ═══════════════════════════════════════════════════════════════════════
      // NOBODY LEAVES WHILE THEY ARE ALL-IN. CASH OR TOURNAMENT.
      //
      // Dan 2026-08-26, binding: "in cash games or tournaments, a player can
      // never leave the table while they are all in. they must wait for the hand
      // to be finished."
      //
      // This is FIRST, before the roster lookup and before the cash/tournament
      // split, because `leaveTable` is the single chokepoint every real departure
      // goes through: HTTP /leave, the admin kick, and the horse rotator. One
      // refusal here closes all three for both table types.
      //
      // What it used to do instead, on both branches:
      //
      //     if (enginePlayer && !enginePlayer.is_folded && !enginePlayer.is_all_in)
      //
      // -- it read is_all_in only to SKIP THE AUTO-FOLD, and then carried on
      // leaving. So an all-in player was marked sitting_out in a live pot and the
      // client navigated them away mid-runout, off the hand they still had every
      // chip in.
      //
      // `is_all_in` is engine memory, not a table_seats column, so the check has
      // to live here. It is set in HandController the moment a stack reaches zero
      // and is only cleared when the next hand builds a fresh player array, which
      // is exactly the window this rule is about.
      //
      // A folded player may leave the UI, but their contribution remains in
      // this hand until settlement. Their cashout must wait for that boundary.
      // ═══════════════════════════════════════════════════════════════════════
      const originalPlayer = this.seatedPlayers.find((p) => p.user_id === userId);
      const scoped = opts.occupancyId !== undefined || opts.seatNumber !== undefined;
      const stale = () => ({
        success: false,
        immediate: false,
        code: 'STALE_OCCUPANCY' as const,
        error: 'This Request Belongs To A Previous Seat.',
      });
      if (
        scoped &&
        (typeof opts.occupancyId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            opts.occupancyId
          ) ||
          !Number.isInteger(opts.seatNumber) ||
          (originalPlayer &&
            (originalPlayer.occupancy_id !== opts.occupancyId ||
              originalPlayer.seat_number !== opts.seatNumber)))
      )
        return stale();

      const liveHand = this.handController?.getState();
      const liveSelf = liveHand?.players.find((p) => p.user_id === userId);
      if (liveSelf?.is_all_in && !liveSelf.is_folded) {
        console.log(
          `[ServerTableEngine:${this.tableId}] refusing leave for ${userId} - all-in in a live hand`
        );
        return {
          success: false,
          error: 'You Are All In. You Cannot Leave Until The Hand Is Finished.',
          immediate: false,
        };
      }

      const player = this.seatedPlayers.find((p) => p.user_id === userId);
      if (!player) {
        if (scoped) {
          if (liveSelf)
            return {
              success: false,
              immediate: false,
              error: 'Your Hand Must Finish Before Cashout.',
            };
          // A bound reserved-seat departure is completed by this engine.
          // Never refresh its identity from a newly occupied seat.
          while (this.postHandTasksPromise) {
            const pending = this.postHandTasksPromise;
            await pending;
            if (this.postHandTasksPromise === pending) break;
          }
          if (this.isTournamentTable()) return stale();
          const replacement = this.seatedPlayers.find((p) => p.user_id === userId);
          if (
            replacement &&
            (replacement.occupancy_id !== opts.occupancyId ||
              replacement.seat_number !== opts.seatNumber)
          )
            return stale();
          const out: { locked: number | null; failed: string | null } = {
            locked: null,
            failed: null,
          };
          await atomicCashout(userId, this.tableId, opts.seatNumber!, {
            occupancyId: opts.occupancyId,
            leaveMode: opts.forced ? 'forced' : 'voluntary',
            onLocked: (ms) => {
              out.locked = ms;
            },
            onFailed: (message) => {
              out.failed = message;
            },
          });
          if (out.locked !== null)
            return {
              success: false,
              immediate: false,
              code: 'LEAVE_LOCKED',
              stay_remaining_ms: out.locked,
              error: leaveLabel(out.locked),
            };
          if (out.failed !== null)
            return {
              success: false,
              immediate: false,
              error: 'The Cashout Was Not Confirmed. Please Try Again.',
            };
          return { success: true, immediate: true };
        }

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
        if (opts.forced && !this.isTournamentTable()) {
          // CHIP CONTINUITY: an admin kick of a seat the engine never loaded is
          // still a system exit the engine can complete itself - the target's
          // browser is not the caller and would never do the "client cleanup".
          const { data: reserved, error: reservedError } = await supabase
            .from('table_seats')
            .select('seat_number, occupancy_id')
            .eq('table_id', this.tableId)
            .eq('user_id', userId)
            .is('left_at', null)
            .maybeSingle();
          if (reservedError) throw new Error(reservedError.message);
          if (!reserved) return { success: true, immediate: true };
          await atomicCashout(userId, this.tableId, reserved.seat_number, {
            occupancyId: reserved.occupancy_id,
            leaveMode: 'forced',
          });
          this.chipContinuity.forget(userId);
          return { success: true, immediate: true };
        }
        console.log(
          `[ServerTableEngine:${this.tableId}] leave for ${userId}: not in hand roster (reserved/waiting) - acking, client handles DB cleanup`
        );
        return { success: true, immediate: true, clientCashout: true };
      }

      if (this.isTournamentTable()) {
        // In tournaments, leaving the table NEVER cashes out or clears the seat.
        // The player is auto-folded if mid-hand, marked sitting_out in table_seats
        // and disconnectEngine, and continues to be dealt in / blinded out until
        // they return and sit down or run out of chips.
        if (!player.occupancy_id)
          return {
            success: false,
            immediate: false,
            error: 'Your Seat Identity Could Not Be Verified.',
          };
        const { data: sittingSeat, error: sittingError } = await supabase
          .from('table_seats')
          .update({ status: 'sitting_out', is_sitting_out: true })
          .eq('table_id', this.tableId)
          .eq('user_id', userId)
          .eq('seat_number', player.seat_number)
          .eq('occupancy_id', player.occupancy_id)
          .is('left_at', null)
          .select('occupancy_id')
          .maybeSingle();
        if (sittingError || sittingSeat?.occupancy_id !== player.occupancy_id)
          return {
            success: false,
            immediate: false,
            error: 'Could Not Confirm Your Leave Request. Please Try Again.',
          };
        if (
          this.seatedPlayers.some(
            (p) => p.user_id === userId && p.occupancy_id !== player.occupancy_id
          )
        )
          return stale();
        if (this.handController !== null) {
          const state = this.handController.getState();
          const enginePlayer = state.players.find((p) => p.user_id === userId);
          if (enginePlayer && !enginePlayer.is_folded && !enginePlayer.is_all_in) {
            let folded = false;
            try {
              folded = this.handController?.performAction(enginePlayer.seat, 'fold') === true;
              if (folded) {
                console.log(
                  `[ServerTableEngine:${this.tableId}] Tournament player ${userId} auto-folded on leave`
                );
              }
            } catch (err) {
              console.warn(
                `[ServerTableEngine:${this.tableId}] Auto-fold on tournament leave threw: ${err}`
              );
            }
            if (!folded) {
              this.preActionEngine.setPreAction(this.tableId, userId, 'auto_fold');
            }
          }
        }

        this.disconnectEngine.sitOut(this.tableId, userId, 'voluntary');
        /* The other devices have to be told here too (2026-09-05). The cash
         mid-hand branch below re-broadcasts and this one did not, so a
         tournament player who sat out from one device left every other client -
         including their own second screen - holding a snapshot in which they
         were still active. The seat legitimately stays theirs (a tournament
         sit-out is blinded off by design); what changes is that everyone can
         now see that it is sitting out. */
        this.broadcastCurrentState();
        return { success: true, immediate: true, tournament: true };
      }

      // ═══════════════════════════════════════════════════════════════════════
      // CHIP CONTINUITY (Operation Table Stakes, Slice 0 - OPORD 1.3 s6.4, I5).
      //
      // A cash player ahead of the money they put in stays seated until the
      // stay clock reaches zero. This is the synchronous answer from the
      // engine's mirror of cash_player_session; the database asks the same
      // question again under the seat lock inside atomic_seat_cashout_locked
      // (p_leave_mode = 'voluntary'), so a stale mirror cannot let anyone out
      // and a forged cash-out cannot get past the door either (A0.16).
      //
      // Mid-hand the mirror holds the state as of the last settlement - the
      // roster stack is the pre-hand stack - which is the only honest number
      // before the pot is awarded. The settlement re-check covers the rest.
      //
      // The label is the ONLY copy: "Leave Available In M:SS". No reason, no
      // essay, no forbidden words (section 6.1).
      // ═══════════════════════════════════════════════════════════════════════
      if (!opts.forced) {
        const lock = this.chipContinuity.leaveLock(userId, player.stack);
        if (lock.locked) {
          const label = leaveLabel(lock.remainingMs);
          console.log(
            `[ServerTableEngine:${this.tableId}] leave refused for ${userId} - stay clock ${lock.remainingMs}ms remaining`
          );
          this.hub?.emitEvent(this.tableId, {
            type: 'leave_blocked',
            table_id: this.tableId,
            user_id: userId,
            stay_remaining_ms: lock.remainingMs,
            timestamp: Date.now(),
          });
          return {
            success: false,
            error: label,
            immediate: false,
            code: 'LEAVE_LOCKED',
            stay_remaining_ms: lock.remainingMs,
          };
        }
      }

      // Phase X5 (2026-04-29) — Bible V8 §1.16 seat_left discrete event so
      // every connected client (including spectators) can re-render the
      // empty seat without diffing the next state snapshot.
      // CHIP CONTINUITY (2026-09-04): emitted only once the seat has actually
      // left - immediately on the mid-hand path (the player is folded out and
      // the seat is out of play), and AFTER the database has accepted the
      // cash-out on the between-hands path. It used to go out before the
      // cash-out, so a refusal at the door left every client showing an empty
      // chair with a player still in it.
      const emitSeatLeft = () =>
        this.hub?.emitEvent(this.tableId, {
          type: 'seat_left',
          table_id: this.tableId,
          seat: player.seat_number,
          user_id: userId,
          mid_hand: this.handController !== null,
          timestamp: Date.now(),
        });

      // Dan 2026-08-25, BINDING: "LEAVE TABLE SHOULD ALWAYS OVERRIDE ANYTHING
      // ELSE... LEAVE TABLE IS LIKE THE RESET BUTTON, CLEARS EVERYTHING FROM THAT
      // TABLE." And: "if you are SITTING OUT but click LEAVE TABLE, it doesn't
      // leave the table, it silently fails."
      //
      // THE BUG WAS THIS BRANCH. It asked "is a hand running AT THIS TABLE", not
      // "is THIS PLAYER in that hand". A sitting-out player is excluded from the
      // deal, so they took the mid-hand path anyway: the auto-fold was skipped
      // (there is no enginePlayer for them), and the seat was merely flagged
      // leave_pending. That flag is only ever processed by processLeavePending at
      // SETTLEMENT — so if no hand completed afterwards (the table dropped below
      // the minimum to deal, or the hand died on the safety timeout, which skips
      // settlement) the row was never touched again. The player was gone from the
      // UI, still in the seat, chips still on the table. It could sit like that
      // forever, and nothing swept it.
      //
      // Every participant in this live hand waits for settlement, including a
      // folded player. Folding removes winning eligibility, not the committed
      // contribution or the need to persist the final stack. A player who was
      // not dealt into this hand can still leave immediately.
      const handState = this.handController?.getState();
      const playerInLiveHand = handState?.players.find((p) => p.user_id === userId);

      if (this.handController !== null && playerInLiveHand) {
        // A deferred acknowledgement requires a durable request for this exact
        // occupancy. Database refusal must reach the caller before success events.
        if (!player.occupancy_id)
          return {
            success: false,
            immediate: false,
            error: 'Your Seat Identity Could Not Be Verified.',
          };
        const { data: pendingSeat, error: pendingError } = await supabase
          .from('table_seats')
          .update({ leave_pending: true, status: 'sitting_out', is_sitting_out: true })
          .eq('table_id', this.tableId)
          .eq('user_id', userId)
          .eq('seat_number', player.seat_number)
          .eq('occupancy_id', player.occupancy_id)
          .is('left_at', null)
          .select('occupancy_id')
          .maybeSingle();
        if (pendingError || pendingSeat?.occupancy_id !== player.occupancy_id)
          return {
            success: false,
            immediate: false,
            error: 'Could Not Confirm Your Leave Request. Please Try Again.',
          };
        if (
          this.seatedPlayers.some(
            (p) => p.user_id === userId && p.occupancy_id !== player.occupancy_id
          )
        )
          return stale();
        // The hand may finish while the database acknowledges the request.
        // Never perform an action using the previous controller's player snapshot.
        const enginePlayer = this.handController
          ?.getState()
          .players.find((p) => p.user_id === userId);
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
            folded = this.handController?.performAction(enginePlayer.seat, 'fold') === true;
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
              `[ServerTableEngine:${this.tableId}] Player ${userId} left out of turn - auto_fold queued`
            );
          }
        }

        emitSeatLeft();
        // CHIP CONTINUITY: a forced (kick) exit must not be judged by the clock
        // when settlement processes the leave_pending seat.
        if (opts.forced) this.forcedLeaves.add(userId);
        else this.forcedLeaves.delete(userId);

        // Also mark in disconnect engine so they don't get dealt next hand
        this.disconnectEngine.sitOut(this.tableId, userId, 'voluntary');

        /* THE OTHER DEVICES HAVE TO BE TOLD (Dan 2026-09-05). This branch emitted
         `seat_left` and then stopped: no state re-broadcast, so every connected
         client kept the snapshot in which this player was still in the hand.
         Between-hands leaves have always re-broadcast (see both calls below);
         the deferred path is the one a player actually hits when they leave
         mid-hand, and it was the silent one. */
        this.broadcastCurrentState();

        return { success: true, immediate: false };
      } else {
        // Between hands: remove immediately via atomic cashout.
        // AUDIT FIX 2026-07-19: the hand controller is nulled at HAND_COMPLETE
        // BEFORE postHandTasks (which runs syncStacks) finishes. A leave arriving
        // in that window would take this branch and cash out the STALE pre-hand
        // seat stack — the pot won vanishes (or a bust is refunded). Wait for any
        // in-flight settlement to persist the final stack first.
        // CHIP CONTINUITY (2026-09-04): the answer to POST /leave IS the
        // database's answer. This used to reply `success: true` and cash out in
        // the background; when the door refused (mirror empty after a restart,
        // a settlement landing between the check and the cash-out) the client
        // had already navigated away from a seat still holding its chips. Now
        // the cash-out is awaited, a refusal is returned as a refusal, and the
        // seat_left event follows the money, not the request.
        //
        // Voluntary leaves go through atomicCashoutVoluntary (the clock-guarded
        // door). A forced exit (admin kick) goes through atomicCashout with
        // leaveMode 'forced': a system exit the clock never blocks, which still
        // closes the session and writes the rejoin floor.
        //
        // There is NO markSeatAsLeft fallback on either path any more - it is the
        // same RPC and would fail for the same reason, and the old fallback then
        // tore down the player's engine registrations while they were still in
        // the chair.
        while (this.postHandTasksPromise) {
          // Settlement can append its stack/bank tasks while this leave is
          // waiting. Re-read the barrier before spending the seat balance.
          const pending = this.postHandTasksPromise;
          await pending;
          if (this.postHandTasksPromise === pending) break;
        }

        const teardown = () => {
          if (
            this.seatedPlayers.some(
              (p) => p.user_id === userId && p.occupancy_id !== player.occupancy_id
            )
          )
            return false;
          this.disconnectEngine.unregisterPlayer(this.tableId, userId);
          this.timeBankEngine.removePlayer(this.tableId, userId);
          this.straddleEngine.removePlayer(this.tableId, userId);
          this.preActionEngine.removePlayer(this.tableId, userId);
          this.leaveHeldByClock.delete(userId);
          this.forcedLeaves.delete(userId);
          this.chipContinuity.forget(userId);
          this.seatedPlayers = this.seatedPlayers.filter(
            (p) => p.user_id !== userId || p.occupancy_id !== player.occupancy_id
          );
          return true;
        };

        if (opts.forced) {
          const out: { failed: string | null } = { failed: null };
          await atomicCashout(userId, this.tableId, player.seat_number, {
            occupancyId: player.occupancy_id,
            leaveMode: 'forced',
            onFailed: (m) => {
              out.failed = m;
            },
          });
          if (out.failed !== null) {
            console.warn(
              `[ServerTableEngine:${this.tableId}] forced cash-out failed for ${userId} - seat preserved: ${out.failed}`
            );
            return {
              success: false,
              error: 'Could Not Remove The Player Right Now. Their Chips Are Still In The Seat.',
              immediate: false,
            };
          }
          console.log(
            `[ServerTableEngine:${this.tableId}] Player ${userId} removed (forced, between hands)`
          );
          if (teardown()) {
            emitSeatLeft();
            this.broadcastCurrentState();
            this.wakeClusterGame('seat_left');
          }
          return { success: true, immediate: true };
        }

        const res = await atomicCashoutVoluntary(
          userId,
          this.tableId,
          player.seat_number,
          player.occupancy_id
        );
        if (res.ok) {
          console.log(
            `[ServerTableEngine:${this.tableId}] Player ${userId} left table immediately (between hands)`
          );
          if (teardown()) {
            emitSeatLeft();
            this.broadcastCurrentState();
            this.wakeClusterGame('seat_left');
          }
          return { success: true, immediate: true };
        }
        if (res.code === 'LEAVE_LOCKED') {
          // The mirror was behind the database (empty after a restart, or a
          // settlement landed between the check above and the door). The player
          // is still seated, still in, and is told the clock. The mirror adopts
          // the database's remaining time.
          console.log(
            `[ServerTableEngine:${this.tableId}] leave refused at the door for ${userId} - stay clock ${res.stayRemainingMs}ms remaining`
          );
          this.chipContinuity.noteRefusal(userId, res.stayRemainingMs);
          const label = leaveLabel(res.stayRemainingMs);
          this.hub?.emitEvent(this.tableId, {
            type: 'leave_blocked',
            table_id: this.tableId,
            user_id: userId,
            stay_remaining_ms: res.stayRemainingMs,
            timestamp: Date.now(),
          });
          this.broadcastCurrentState();
          return {
            success: false,
            error: label,
            immediate: false,
            code: 'LEAVE_LOCKED',
            stay_remaining_ms: res.stayRemainingMs,
          };
        }
        // Transport or database failure: the seat is untouched (one transaction)
        // and the player can try again. Nothing to tear down, because nothing left.
        console.warn(
          `[ServerTableEngine:${this.tableId}] voluntary cash-out failed for ${userId} - seat preserved: ${res.message}`
        );
        return {
          success: false,
          error:
            'Could Not Leave The Table Right Now. Your Chips Are Still In Your Seat. Please Try Again.',
          immediate: false,
        };
      }
    } finally {
      releaseSeatBoundary();
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
    console.log(`[ServerTableEngine:${this.tableId}] Admin resume - dealing will continue`);
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
    // Dan 2026-08-26, binding: "Every single player needs to either wait for
    // the BB or post when entering a cash game... no free hands or coming in
    // behind the blinds."
    //
    // So this set means what its name says again. A player registered here is
    // NOT dealt in until either the big blind reaches their seat or they call
    // POST /post-bb and pay it. Between 2026-08-25 and 2026-08-26 it meant
    // almost nothing - the dealing loop released every waiter on the next tick,
    // free - and that is the behaviour being reversed.
    //
    // EVERY cash new-joiner is registered, whatever `wait_for_big_blind` says.
    // The flag used to gate this call, so a host who set it false skipped
    // registration entirely, which skipped the wait AND the hold-out that
    // enforces "CASH GAME PLAYERS CAN NEVER BE DEALT INTO THE SMALL BLIND". A
    // table setting must not be able to switch off a house rule.
    if (!this.isTournamentTable()) {
      this.waitingForBB.add(userId);
      // Dan 2026-08-30: and write it down. A Set on this process does not
      // survive the deploy that happens on every push to server/**, and a hold
      // that evaporates hands the player a free hand AND the button. See
      // persistEntryHold().
      this.persistEntryHold(userId, { hold: 'waiting' });
    }
  }

  /**
   * B2 2026-08-27 — THE TOURNAMENT COUNTERPART OF registerWaitForBB.
   *
   * A tournament player cannot be held out of a hand the way a cash player can:
   * tournament players must be dealt in and blinded off or the field never
   * shrinks. So the cash rule ("wait one hand, pay nothing") has no tournament
   * equivalent, and the two seats it exists to protect were simply unprotected
   * here — a late registrant or a balanced-in player who landed on the button
   * or the small blind for the coming hand played out most of an orbit before
   * the big blind reached them, for free, while everyone already at the table
   * had paid to be there.
   *
   * Those two seats — and ONLY those two — are the ones the big blind has just
   * passed (one and two hands ago). Every other seat reaches the big blind
   * inside the current orbit on its own and owes nothing. An arrival in the big
   * blind seat itself posts it naturally and is likewise left alone.
   *
   * Fewer than three in the rotation is heads-up or a table about to be broken,
   * where the button IS the small blind and both players pay every hand: there
   * is no free orbit available to take, so nothing is charged.
   *
   * TableBalancer keeps moved players out of these two seats wherever another
   * free seat exists (`findOpenSeat`), so in practice this fires for late
   * registrants and for the tail of a table break that had nowhere else to sit.
   */
  protected noteTournamentArrival(seatNumber: number, userId: string): void {
    if (!this.isTournamentTable()) return;
    const rotationSize = this.seatedPlayers.filter((p) => p.stack > 0).length;
    if (rotationSize < 3) return;

    const sbSeatIndex = this.getSBSeatIndex();
    const buttonSeatIndex = this.getButtonSeatIndex();
    if (
      (sbSeatIndex > 0 && seatNumber === sbSeatIndex) ||
      (buttonSeatIndex > 0 && seatNumber === buttonSeatIndex)
    ) {
      this.mustPostBB.add(userId);
      console.log(
        `[ServerTableEngine:${this.tableId}] tournament arrival ${userId} took the seat the big blind just passed - owes one big blind`
      );
    }
  }

  /**
   * Bible V8 §4.2: Player opts to "Post BB" to enter immediately.
   *
   * Dan 2026-08-26, binding: a cash entrant either waits for the big blind or
   * posts. This is the POST half, and it is a real product path again - the
   * overlay on TablePage offers it. It bills a LIVE BIG BLIND ONLY, via
   * postingBBToEnter -> bbOnlyPosts. No dead small blind: that is owed by a
   * player returning from sit-out who MISSED blinds, which is a different debt
   * and a different set (returningFromSitout).
   *
   * Two refusals stay, and neither may be bought:
   *   - the seat the small blind is about to reach ("CASH GAME PLAYERS CAN
   *     NEVER BE DEALT INTO THE SMALL BLIND")
   *   - the seat the button is about to reach ("NEW PLAYERS NEVER GET THE
   *     BUTTON WHEN SITTING DOWN")
   * Posting is a way past the WAIT, not past a house rule.
   *
   * Dan 2026-08-29: a positional refusal is no longer the END of the answer.
   * It is DEFERRED — the agreement is held in `postBBWhenClear` and the
   * dealing loop replays it once the seat clears. See that field. The two
   * rules above are untouched: the post still does not happen from either
   * seat, on this call or any later one. `deferred` is how the caller tells
   * "held, nothing more to do" apart from "posted now".
   */
  public postBBToEnter(userId: string): {
    success: boolean;
    error?: string;
    deferred?: boolean;
  } {
    if (!this.waitingForBB.has(userId)) {
      // RACE FIX 2026-08-27: mid-hand joiner not registered yet — see helper.
      if (this.queuePostToEnter(userId)) return { success: true };
      // A standing agreement outlives the moment the player is released to
      // post their own big blind, so it is dropped here rather than left to
      // fire against a player already in the rotation.
      this.postBBWhenClear.delete(userId);
      this.persistEntryHold(userId, { hold: null, agreed: false });
      return { success: false, error: 'Player is not waiting for BB' };
    }
    // This endpoint may NOT buy its way past either positional rule. Posting
    // skips the WAIT; it does not skip "CASH GAME PLAYERS CAN NEVER BE DEALT
    // INTO THE SMALL BLIND" or "NEW PLAYERS NEVER GET THE BUTTON WHEN SITTING
    // DOWN". A player refused here is not being charged and not being dealt in:
    // they stay in waitingForBB and the big blind will reach them shortly, at
    // which point they post it as their own blind.
    const seat = this.seatedPlayers.find((p) => p.user_id === userId);
    if (seat && !this.isTournamentTable()) {
      const sbSeatIndex = this.getSBSeatIndex();
      const buttonSeatIndex = this.getButtonSeatIndex();
      // BOTH hold-outs, not just the small blind. Otherwise a player could post
      // their way into the button on their first hand, which is the rule the
      // button hold-out exists to enforce.
      if (
        (sbSeatIndex > 0 && seat.seat_number === sbSeatIndex) ||
        (buttonSeatIndex > 0 && seat.seat_number === buttonSeatIndex)
      ) {
        // HELD, NOT REFUSED. The player has answered; the seat has not
        // cleared. The dealing loop replays this on every pass and it takes
        // effect the moment the small blind and the button are both past
        // them. Nothing is billed and nobody is dealt in from this seat.
        this.postBBWhenClear.add(userId);
        this.persistEntryHold(userId, { hold: 'waiting', agreed: true });
        return {
          success: true,
          deferred: true,
          error: 'You Are In Between The Blinds, And Will Be Dealt In When The Button Passes.',
        };
      }
    }
    this.waitingForBB.delete(userId);
    this.postBBWhenClear.delete(userId);
    // 'posting', not null: the live big blind is owed on the NEXT deal, and a
    // restart in that window would otherwise deal them in without billing it.
    this.persistEntryHold(userId, { hold: 'posting', agreed: false });
    // AUDIT FIX 2026-07-19: post ONLY a live BB to enter (no dead SB). Route
    // through postingBBToEnter, not returningFromSitout (which owes a dead SB
    // for a MISSED blind).
    this.postingBBToEnter.add(userId);
    return { success: true };
  }

  /**
   * POST-TO-ENTER RACE FIX 2026-08-27 (Dan: "the post to get dealt in
   * feature in cash games isn't working"): a brand-new joiner is only
   * registered as waiting by the dealing loop's next pass, which mid-hand
   * can be minutes away. A post tapped in that window used to come back
   * "Player is not waiting for BB" and die. The intent is queued here; the
   * dealing loop replays it through postBBToEnter the moment the joiner is
   * registered — positional hold-outs and the live-BB bill included. Anyone
   * the engine already knows and is not holding out is simply in the
   * rotation, and posting means nothing for them (returns false).
   */
  protected queuePostToEnter(userId: string): boolean {
    if (this.isTournamentTable() || this.knownPlayerIds.has(userId)) return false;
    this.pendingPostToEnter.add(userId);
    return true;
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

      /* ── AN EMPTY LIST IS A CLEAR, NOT AN ERROR (Dan 2026-09-05) ──────────
         "THE EYE BALL STAYS LOCKED, YOU CAN NEVER UNLOCK IT OR UNSHOW."

         There was no clear verb. The client sends its full current selection
         every time, so un-picking the LAST card means sending `[]` - and that
         landed here, found nothing valid, and returned 'No valid card
         indexes'. ShowCardsService then made the empty case a local no-op to
         avoid the error, which meant the client silently kept a selection the
         player had just taken back: the badge went out, the card still turned
         over at hand end, and there was no way to stop it.

         Distinguish the two cases. An empty list is a deliberate "show
         nothing"; a NON-empty list with nothing valid in it is a malformed
         request and still an error. */
      if (cardIndexes.length === 0) {
        this.showHandCards?.delete(userId);
        return { success: true, shownCardIndexes: [] };
      }
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
