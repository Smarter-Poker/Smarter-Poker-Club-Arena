/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TIME BANK ENGINE — Extended Think Time for Critical Decisions
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * TIME BANK RULES (Dan 2026-08-23, binding — supersedes the earlier wording):
 * - A bank is NOT consumed until the ordinary action clock (15s) is genuinely
 *   exhausted. Pressing the button early ARMS the bank; it is spent at expiry.
 * - Consuming one RESETS the clock to exactly 20 more seconds (Bible V8 §6.2).
 *   It is not stacked on top of whatever the player had left.
 * - Hard cap of 2 activations PER STREET, never more.
 * - VIP members receive 120 time bank seconds per month
 * - Non-VIP (or depleted VIP) can purchase individually with Diamonds
 * - Auto-activate when player's primary action timer expires (if available)
 * - Player pool depletes over time; balance tracked in database
 *
 * Ported from client: src/engine/TimeBankEngine.ts
 * Server adaptation: No masterBus, no VIPService — uses callbacks for events.
 */

import { PreciseActionTimer } from './PreciseActionTimer.js';
import { reportError } from '../services/errorReporter.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TimeBankConfig {
  /** Total time bank seconds available per session (default: 30) */
  totalBankSeconds: number;
  /** Maximum number of time bank uses per session (default: 4) */
  maxUses: number;
  /** Seconds each time bank activation adds to the clock (default: 20) */
  secondsPerUse: number;
  /** Whether to refill 1 use per dealer orbit (default: false) */
  refillPerOrbit: boolean;
  /** Seconds to add per orbit refill (default: 15) */
  refillSeconds: number;
  /** Auto-activate time bank when action timer expires (default: true) */
  autoActivate: boolean;
}

export interface PlayerTimeBank {
  playerId: string;
  tableId: string;
  remainingSeconds: number;
  usesRemaining: number;
  isActive: boolean;
  activatedAt?: number;
  currentUseSeconds: number;
  onExpire?: () => void;
  /**
   * Activations used on the CURRENT STREET (Bible V8 §6.2: max 2 per street).
   * Reset at the start of every hand and again on every flop/turn/river.
   */
  streetActivations: number;
  /**
   * Dan 2026-08-23: the player pressed "use time bank" while their ordinary
   * action clock was STILL RUNNING. Nothing is spent at the press. The intent
   * is held here and redeemed by onPrimaryTimerExpired() the moment the 15s
   * clock is genuinely exhausted, which is also what makes the manual button
   * work on tables where autoActivate is off.
   */
  armed: boolean;
  /**
   * Lifetime VIP may request another standard activation after the finite
   * pool reaches zero. This never relaxes the per-street activation limit.
   */
  unlimitedActivations: boolean;
}

/**
 * Why activate() did or did not spend a bank. The boolean `activate()` wrapper
 * is kept for the existing call sites; callers that need to tell "you have no
 * banks" apart from "your clock is still running" use tryActivate().
 */
export type TimeBankActivationResult =
  | 'activated'
  | 'not_initialized'
  | 'already_active'
  | 'depleted'
  | 'street_limit'
  | 'clock_not_exhausted';

export type TimeBankEventType =
  | 'TIME_BANK_ACTIVATED'
  | 'TIME_BANK_STOPPED'
  | 'TIME_BANK_EXPIRED'
  | 'TIME_BANK_DEPLETED'
  | 'TIME_BANK_REFILLED';

export interface TimeBankEvent {
  type: TimeBankEventType;
  tableId: string;
  playerId: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIME BANK ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class TimeBankEngine {
  private tableConfigs: Map<string, TimeBankConfig> = new Map();
  private playerBanks: Map<string, PlayerTimeBank> = new Map();
  private preciseTimer: PreciseActionTimer;
  private onEvent?: (event: TimeBankEvent) => void;

  /**
   * How much ordinary turn clock may still be showing and still count as
   * "truly used your entire 15 seconds" (Dan 2026-08-23).
   *
   * It cannot be exactly zero. The client posts /timebank on its own RAF
   * countdown reaching 0, and the engine then measures the leftover from its
   * own stamps; network latency and the two clocks' skew routinely leave a
   * few hundred milliseconds on the board at that instant. A zero tolerance
   * would refuse every legitimate expiry-path activation and auto-fold the
   * player instead.
   */
  public static readonly CLOCK_EXHAUSTED_EPSILON_SECONDS = 0.75;

  private readonly DEFAULT_CONFIG: TimeBankConfig = {
    totalBankSeconds: 2400, // 120 uses × 20 seconds = 2400s per month (VIP default)
    maxUses: 120, // 120 time banks per month with VIP
    secondsPerUse: 20, // Bible V8 §6.2: each time bank adds 20 seconds to the clock
    refillPerOrbit: false,
    refillSeconds: 15,
    autoActivate: true,
  };

  constructor(preciseTimer: PreciseActionTimer, onEvent?: (event: TimeBankEvent) => void) {
    this.preciseTimer = preciseTimer;
    this.onEvent = onEvent;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════

  configure(tableId: string, config: Partial<TimeBankConfig>): void {
    this.tableConfigs.set(tableId, { ...this.DEFAULT_CONFIG, ...config });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLAYER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  initializePlayer(
    tableId: string,
    playerId: string,
    initialState?: {
      remainingSeconds?: number;
      usesRemaining?: number;
      unlimitedActivations?: boolean;
    }
  ): void {
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    const key = `${tableId}:${playerId}`;

    this.playerBanks.set(key, {
      playerId,
      tableId,
      remainingSeconds: initialState?.remainingSeconds ?? config.totalBankSeconds,
      usesRemaining: initialState?.usesRemaining ?? config.maxUses,
      isActive: false,
      currentUseSeconds: 0,
      streetActivations: 0,
      armed: false,
      unlimitedActivations: initialState?.unlimitedActivations === true,
    });
  }

  removePlayer(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const bank = this.playerBanks.get(key);
    if (bank?.isActive) {
      this.preciseTimer.cancelTimer(tableId, `timebank:${playerId}`);
    }
    this.playerBanks.delete(key);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIME BANK ACTIVATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called when a player's primary action timer expires. This is the ONLY
   * moment a bank may be spent (Dan 2026-08-23) — the 15s decision clock has
   * to be genuinely gone first.
   *
   * Spends a bank when either the table auto-activates, or the player armed
   * one by pressing the button earlier in the turn. The armed case is what
   * keeps the manual button working on a table with autoActivate off.
   */
  onPrimaryTimerExpired(tableId: string, playerId: string, onExpire: () => void): boolean {
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    const bank = this.playerBanks.get(`${tableId}:${playerId}`);
    if (!config.autoActivate && !bank?.armed) return false;
    return this.activate(tableId, playerId, onExpire);
  }

  /**
   * Record the player's INTENT to spend a bank on this decision, without
   * spending it. Pressing the button with time still on the clock must not
   * cost anything and must not add anything — see the file header.
   *
   * Returns false when there is nothing to arm (no bank in the pool, the
   * street allowance is used up, or one is already counting down), so the
   * caller can tell the player why rather than showing a clock that lies.
   */
  arm(tableId: string, playerId: string): boolean {
    const bank = this.playerBanks.get(`${tableId}:${playerId}`);
    if (!bank || bank.isActive) return false;
    if (!bank.unlimitedActivations && (bank.usesRemaining <= 0 || bank.remainingSeconds <= 0)) {
      return false;
    }
    if (bank.streetActivations >= 2) return false;
    bank.armed = true;
    return true;
  }

  isArmed(tableId: string, playerId: string): boolean {
    return this.playerBanks.get(`${tableId}:${playerId}`)?.armed === true;
  }

  disarm(tableId: string, playerId: string): void {
    const bank = this.playerBanks.get(`${tableId}:${playerId}`);
    if (bank) bank.armed = false;
  }

  /**
   * Spend one time bank. Boolean wrapper over tryActivate() so the existing
   * call sites and tests keep working; use tryActivate() when you need to tell
   * the player WHY it was refused.
   */
  activate(
    tableId: string,
    playerId: string,
    onExpire: () => void,
    extraCountdownSeconds = 0
  ): boolean {
    return this.tryActivate(tableId, playerId, onExpire, extraCountdownSeconds) === 'activated';
  }

  /**
   * Spend one time bank, reporting why if it refuses.
   *
   * @param extraCountdownSeconds ordinary turn clock the player still had left
   *   at the moment of the call.
   *
   *   Dan 2026-08-23, binding: "It should not take a time bank or add more time
   *   until you have truly used your entire 15 seconds. Then if the time bank
   *   is used, it must reset the clock for 20 more seconds."
   *
   *   So a non-zero leftover is now a REFUSAL ('clock_not_exhausted'), not an
   *   instruction to stack the bank on top of it. The caller's job in that case
   *   is arm(), which costs nothing; the bank is redeemed at expiry.
   *
   *   HISTORY, so this does not get "fixed" back:
   *   - Before 2026-08-18 this parameter did not exist. The manual path armed a
   *     bank-only countdown here while ServerTableEngineTurns armed a turn timer
   *     for `remaining + bank`. Two deadlines under different keys on the same
   *     PreciseActionTimer, both live, and the shorter one folded the player
   *     while the clock on screen was still counting down.
   *   - 2026-08-18 fixed that by making this countdown span `remaining + bank`
   *     too. Both deadlines agreed, but they agreed on the WRONG number: a bank
   *     pressed at 12s produced a 32s turn and a bank already spent.
   *   - 2026-08-23 removes the stacking entirely. There is nothing to span,
   *     because a bank is only ever granted from a standing start. The
   *     parameter survives as the exhaustion CHECK.
   */
  /**
   * WOULD A BANK BE GRANTED RIGHT NOW? THE ONE ANSWER (2026-09-09).
   *
   * Returns the exact refusal `tryActivate` would return, or null when it would
   * grant. `tryActivate` calls this, so a caller that asks first and a caller
   * that just tries cannot disagree.
   *
   * It exists because a caller that has to PLAN around a bank - the horse
   * cadence in ServerTableEngineTurns, which schedules an action past the turn
   * clock only when a bank is certain to catch it - was re-deriving the rules
   * by hand from `getPlayerBank()`. That copy read `time_bank_enabled`,
   * `usesRemaining` and `remainingSeconds` and MISSED the per-street cap
   * entirely, so a third bank-mode draw for one seat on one street scheduled
   * past the clock, `tryActivate` answered 'street_limit', and the seat was
   * auto-folded with a real decision already computed and about to be
   * discarded. That is the V28 failure the note at the call site says it closed,
   * re-opened by the one rule the hand-written copy did not carry.
   *
   * `extraCountdownSeconds` defaults to 0 - the standing-start case, which is
   * what a planner is asking about. Table-level `time_bank_enabled` is the
   * engine's own switch and stays with the caller.
   */
  activationRefusal(
    tableId: string,
    playerId: string,
    extraCountdownSeconds = 0
  ): Exclude<TimeBankActivationResult, 'activated'> | null {
    const bank = this.playerBanks.get(`${tableId}:${playerId}`);

    if (!bank) return 'not_initialized';
    if (bank.isActive) return 'already_active';
    if (!bank.unlimitedActivations && (bank.usesRemaining <= 0 || bank.remainingSeconds <= 0)) {
      return 'depleted';
    }
    // Bible V8 §6.2: max 2 activations PER STREET, never more. Preflop, flop,
    // turn and river each get their own allowance of 2; the counter is reset by
    // resetStreetActivations() at the start of the hand and on every new street.
    // The seconds pool is the other, harder cap — a player cannot activate a
    // bank they do not have, however many streets are left.
    if (bank.streetActivations >= 2) return 'street_limit';
    // The 15 seconds have to be genuinely gone first.
    if (extraCountdownSeconds > TimeBankEngine.CLOCK_EXHAUSTED_EPSILON_SECONDS) {
      return 'clock_not_exhausted';
    }
    return null;
  }

  tryActivate(
    tableId: string,
    playerId: string,
    onExpire: () => void,
    extraCountdownSeconds = 0
  ): TimeBankActivationResult {
    const key = `${tableId}:${playerId}`;
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;

    const refusal = this.activationRefusal(tableId, playerId, extraCountdownSeconds);
    if (refusal !== null) return refusal;
    // activationRefusal proved the bank exists and is grantable.
    const bank = this.playerBanks.get(key)!;

    /*
     * Lifetime VIP is explicit state, not a giant synthetic balance. Refill
     * only the activation that is about to start, and only after the active,
     * street-limit, and clock-exhaustion guards above have all passed.
     */
    if (bank.unlimitedActivations && (bank.usesRemaining <= 0 || bank.remainingSeconds <= 0)) {
      bank.remainingSeconds = config.secondsPerUse;
      bank.usesRemaining = 1;
    }

    const useSeconds = Math.min(config.secondsPerUse, bank.remainingSeconds);

    bank.isActive = true;
    bank.activatedAt = Date.now();
    bank.currentUseSeconds = useSeconds;
    bank.usesRemaining--;
    bank.streetActivations++;
    bank.armed = false;
    bank.onExpire = onExpire;

    this.emitEvent({
      type: 'TIME_BANK_ACTIVATED',
      tableId,
      playerId,
      secondsGranted: useSeconds,
      usesRemaining: bank.usesRemaining,
      totalRemaining: bank.remainingSeconds,
      unlimitedActivations: bank.unlimitedActivations,
    });

    // The countdown IS the new clock: exactly the bank allocation, from zero.
    // The caller arms its turn timer with the same number, so the enforcement
    // deadline and the deadline the client is shown cannot disagree.
    this.preciseTimer.startTimer(tableId, `timebank:${playerId}`, useSeconds * 1000, () => {
      this.onTimeBankExpired(tableId, playerId);
    });

    return 'activated';
  }

  /**
   * Player acted before time bank expired — cancel the countdown.
   * USE IT OR LOSE IT: The full time bank allocation (20s) is burned regardless
   * of how quickly the player acted. No partial refunds, no rollover.
   */
  playerActed(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const bank = this.playerBanks.get(key);
    // An intent that was never redeemed dies with the decision it was made
    // for. Leaving it set would spend a bank on the player's NEXT turn, which
    // they did not ask for.
    if (bank) bank.armed = false;
    if (!bank || !bank.isActive) return;

    // USE IT OR LOSE IT — deduct the FULL currentUseSeconds, not just elapsed time
    const secondsUsed = bank.currentUseSeconds;
    bank.remainingSeconds = Math.max(0, bank.remainingSeconds - secondsUsed);

    // Cancel PreciseActionTimer
    this.preciseTimer.cancelTimer(tableId, `timebank:${playerId}`);
    bank.isActive = false;
    bank.activatedAt = undefined;
    bank.onExpire = undefined;

    this.emitEvent({
      type: 'TIME_BANK_STOPPED',
      tableId,
      playerId,
      secondsUsed,
      remainingSeconds: bank.remainingSeconds,
      usesRemaining: bank.usesRemaining,
      unlimitedActivations: bank.unlimitedActivations,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PER-STREET RESET (Bible V8 §6.2: max 2 activations per street)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Reset the per-STREET activation counter for every player at a table.
   *
   * Must be called at the start of each hand AND on every new street, because
   * Bible V8 §6.2 allows 2 activations per street rather than 2 per hand. Miss
   * the street call and a player who used both banks preflop can never use one
   * again for the rest of the hand.
   */
  resetStreetActivations(tableId: string): void {
    for (const [key, bank] of this.playerBanks) {
      if (key.startsWith(`${tableId}:`)) {
        bank.streetActivations = 0;
        // A new street is a new decision. An intent armed on the previous one
        // must not carry over and silently spend a bank here.
        bank.armed = false;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ORBIT REFILL
  // ═══════════════════════════════════════════════════════════════════════════

  onOrbitComplete(tableId: string): void {
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    if (!config.refillPerOrbit) return;

    for (const [key, bank] of this.playerBanks) {
      if (!key.startsWith(`${tableId}:`)) continue;
      // Lifetime receives one standard activation on demand. Orbit refills
      // must not mutate that explicit unlimited entitlement into a partial use.
      if (bank.unlimitedActivations) continue;

      if (bank.usesRemaining < config.maxUses) {
        bank.usesRemaining++;
        bank.remainingSeconds = Math.min(
          bank.remainingSeconds + config.refillSeconds,
          config.totalBankSeconds
        );

        this.emitEvent({
          type: 'TIME_BANK_REFILLED',
          tableId,
          playerId: bank.playerId,
          usesRemaining: bank.usesRemaining,
          remainingSeconds: bank.remainingSeconds,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE QUERIES
  // ═══════════════════════════════════════════════════════════════════════════

  getPlayerBank(tableId: string, playerId: string): PlayerTimeBank | null {
    return this.playerBanks.get(`${tableId}:${playerId}`) ?? null;
  }

  hasTimeBank(tableId: string, playerId: string): boolean {
    const bank = this.getPlayerBank(tableId, playerId);
    return (
      !!bank && (bank.unlimitedActivations || (bank.usesRemaining > 0 && bank.remainingSeconds > 0))
    );
  }

  isUnlimited(tableId: string, playerId: string): boolean {
    return this.getPlayerBank(tableId, playerId)?.unlimitedActivations === true;
  }

  /**
   * Replace the cached Lifetime flag without changing a player's real finite
   * balance. The table engine uses this to fail closed when a bounded
   * revalidation cannot prove that an unlimited membership is still active.
   */
  setUnlimitedActivations(tableId: string, playerId: string, unlimited: boolean): boolean {
    const bank = this.getPlayerBank(tableId, playerId);
    if (!bank || bank.isActive) return false;
    bank.unlimitedActivations = unlimited;
    return true;
  }

  getRemainingSeconds(tableId: string, playerId: string): number {
    return this.getPlayerBank(tableId, playerId)?.remainingSeconds ?? 0;
  }

  getUsesRemaining(tableId: string, playerId: string): number {
    return this.getPlayerBank(tableId, playerId)?.usesRemaining ?? 0;
  }

  /**
   * VIP wiring 2026-08-17: rebase a player's bank to a fresh DB-derived
   * total mid-session (e.g. after a diamond top-up purchase). No-op while
   * a time bank is actively counting down.
   */
  rebase(
    tableId: string,
    playerId: string,
    remainingSeconds: number,
    unlimitedActivations?: boolean
  ): boolean {
    const bank = this.playerBanks.get(`${tableId}:${playerId}`);
    if (!bank || bank.isActive) return false;
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    bank.remainingSeconds = Math.max(0, remainingSeconds);
    bank.usesRemaining = Math.ceil(bank.remainingSeconds / config.secondsPerUse);
    if (unlimitedActivations !== undefined) {
      bank.unlimitedActivations = unlimitedActivations;
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  dispose(tableId: string): void {
    for (const [key, bank] of this.playerBanks) {
      if (key.startsWith(`${tableId}:`)) {
        if (bank.isActive) {
          this.preciseTimer.cancelTimer(tableId, `timebank:${bank.playerId}`);
        }
        this.playerBanks.delete(key);
      }
    }
    this.tableConfigs.delete(tableId);
  }

  disposeAll(): void {
    this.playerBanks.clear();
    this.tableConfigs.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * HAND-BOUNDARY CLEANUP (2026-08-22 review): deactivate any still-active
   * bank for the table. Semantics match playerActed (use it or lose it: the
   * activated allocation is burned). Without this, a bank left active at
   * HAND_COMPLETE either strands `isActive` with no countdown (blocking
   * rearmTurnTimerIfCurrent for a reconnecting player) or fires its expiry
   * into the NEXT hand and can fold a live player at the same seat.
   */
  cancelActiveForTable(tableId: string): void {
    const prefix = `${tableId}:`;
    for (const [key, bank] of this.playerBanks) {
      if (!key.startsWith(prefix) || !bank.isActive) continue;
      const playerId = key.slice(prefix.length);
      this.playerActed(tableId, playerId);
    }
  }

  private onTimeBankExpired(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const bank = this.playerBanks.get(key);
    if (!bank) return;

    bank.remainingSeconds = Math.max(0, bank.remainingSeconds - bank.currentUseSeconds);
    bank.isActive = false;
    bank.activatedAt = undefined;
    bank.armed = false;

    const isDepleted =
      !bank.unlimitedActivations && (bank.usesRemaining <= 0 || bank.remainingSeconds <= 0);

    this.emitEvent({
      type: isDepleted ? 'TIME_BANK_DEPLETED' : 'TIME_BANK_EXPIRED',
      tableId,
      playerId,
      secondsUsed: bank.currentUseSeconds,
      remainingSeconds: bank.remainingSeconds,
      usesRemaining: bank.usesRemaining,
      unlimitedActivations: bank.unlimitedActivations,
    });

    if (bank.onExpire) {
      bank.onExpire();
      bank.onExpire = undefined;
    }
  }

  private emitEvent(event: TimeBankEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'TimeBankEngine.Event_handler_error');
      }
    }
  }
}
