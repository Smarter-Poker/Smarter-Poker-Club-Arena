/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TIME BANK ENGINE — Extended Think Time for Critical Decisions
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages time bank allocations for poker players:
 * - Configurable time banks per session (default: 30s pool, 4 uses)
 * - Auto-activate when player's primary action timer expires
 * - Optional orbit-based refill (1 bank per orbit)
 * - Bus emissions for UI synchronization
 */

import { masterBus } from '../core/MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TimeBankConfig {
  /** Total time bank seconds available per session (default: 30) */
  totalBankSeconds: number;
  /** Maximum number of time bank uses per session (default: 4) */
  maxUses: number;
  /** Seconds per individual time bank use (default: 15) */
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
  /** Remaining time bank seconds */
  remainingSeconds: number;
  /** Number of uses remaining */
  usesRemaining: number;
  /** Whether time bank is currently active (counting down) */
  isActive: boolean;
  /** Active countdown timer */
  activeTimer?: ReturnType<typeof setTimeout>;
  /** When the current time bank activation started */
  activatedAt?: number;
  /** Seconds used in current activation */
  currentUseSeconds: number;
  /** Callback to execute when time bank expires */
  onExpire?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIME BANK ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class TimeBankEngineClass {
  private tableConfigs: Map<string, TimeBankConfig> = new Map();
  private playerBanks: Map<string, PlayerTimeBank> = new Map();

  private readonly DEFAULT_CONFIG: TimeBankConfig = {
    totalBankSeconds: 30,
    maxUses: 4,
    secondsPerUse: 15,
    refillPerOrbit: false,
    refillSeconds: 15,
    autoActivate: true,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Configure time bank for a table
   */
  configure(tableId: string, config: Partial<TimeBankConfig>): void {
    this.tableConfigs.set(tableId, { ...this.DEFAULT_CONFIG, ...config });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLAYER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Initialize time bank for a player at a table
   */
  initializePlayer(
    tableId: string,
    playerId: string,
    initialState?: { remainingSeconds?: number; usesRemaining?: number }
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
    });
  }

  /**
   * Remove time bank tracking for a player
   */
  removePlayer(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const bank = this.playerBanks.get(key);
    if (bank?.activeTimer) clearTimeout(bank.activeTimer);
    this.playerBanks.delete(key);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIME BANK ACTIVATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called when a player's primary action timer expires.
   * If auto-activate is on and player has time bank remaining,
   * automatically activates the time bank.
   *
   * @param onExpire - Callback to execute when time bank runs out (e.g., auto-fold)
   * @returns true if time bank was activated, false if no time bank available
   */
  onPrimaryTimerExpired(tableId: string, playerId: string, onExpire: () => void): boolean {
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    if (!config.autoActivate) return false;

    return this.activate(tableId, playerId, onExpire);
  }

  /**
   * Manually activate time bank for a player (player clicks "Use Time Bank" button)
   *
   * @param onExpire - Callback to execute when time bank runs out
   * @returns true if activated, false if no time bank available
   */
  activate(tableId: string, playerId: string, onExpire: () => void): boolean {
    const key = `${tableId}:${playerId}`;
    const bank = this.playerBanks.get(key);
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;

    if (!bank || bank.isActive) return false;
    if (bank.usesRemaining <= 0 || bank.remainingSeconds <= 0) return false;

    // Calculate how many seconds this use gets
    const useSeconds = Math.min(config.secondsPerUse, bank.remainingSeconds);

    bank.isActive = true;
    bank.activatedAt = Date.now();
    bank.currentUseSeconds = useSeconds;
    bank.usesRemaining--;
    bank.onExpire = onExpire;

    masterBus.emit('TIME_BANK_ACTIVATED', {
      tableId,
      playerId,
      secondsGranted: useSeconds,
      usesRemaining: bank.usesRemaining,
      totalRemaining: bank.remainingSeconds,
    });

    // Start the time bank countdown
    bank.activeTimer = setTimeout(() => {
      this.onTimeBankExpired(tableId, playerId);
    }, useSeconds * 1000);

    return true;
  }

  /**
   * Player acted before time bank expired — cancel the countdown
   */
  playerActed(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const bank = this.playerBanks.get(key);
    if (!bank || !bank.isActive) return;

    // Calculate how much time was actually used
    const elapsed = bank.activatedAt ? Math.ceil((Date.now() - bank.activatedAt) / 1000) : 0;

    const secondsUsed = Math.min(elapsed, bank.currentUseSeconds);
    bank.remainingSeconds = Math.max(0, bank.remainingSeconds - secondsUsed);

    // Clear timer
    if (bank.activeTimer) clearTimeout(bank.activeTimer);
    bank.isActive = false;
    bank.activeTimer = undefined;
    bank.activatedAt = undefined;
    bank.onExpire = undefined;

    masterBus.emit('TIME_BANK_STOPPED', {
      tableId,
      playerId,
      secondsUsed,
      remainingSeconds: bank.remainingSeconds,
      usesRemaining: bank.usesRemaining,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ORBIT REFILL
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called when the dealer button completes a full orbit.
   * Refills one time bank use for all players at the table (if configured).
   */
  onOrbitComplete(tableId: string): void {
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    if (!config.refillPerOrbit) return;

    for (const [key, bank] of this.playerBanks) {
      if (!key.startsWith(`${tableId}:`)) continue;

      if (bank.usesRemaining < config.maxUses) {
        bank.usesRemaining++;
        bank.remainingSeconds = Math.min(
          bank.remainingSeconds + config.refillSeconds,
          config.totalBankSeconds
        );

        masterBus.emit('TIME_BANK_REFILLED', {
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
    const key = `${tableId}:${playerId}`;
    return this.playerBanks.get(key) ?? null;
  }

  hasTimeBank(tableId: string, playerId: string): boolean {
    const bank = this.getPlayerBank(tableId, playerId);
    return !!bank && bank.usesRemaining > 0 && bank.remainingSeconds > 0;
  }

  getRemainingSeconds(tableId: string, playerId: string): number {
    return this.getPlayerBank(tableId, playerId)?.remainingSeconds ?? 0;
  }

  getUsesRemaining(tableId: string, playerId: string): number {
    return this.getPlayerBank(tableId, playerId)?.usesRemaining ?? 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VIP TIME BANK EXTENSIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Request a time bank extension via VIP quota or diamond purchase.
   * - VIP: consumes from monthly 120s allotment (free)
   * - Non-VIP: charges 5 diamonds per extension
   * - VIP exhausted: charges 5 diamonds (same as non-VIP)
   *
   * Returns true if extension was granted, false if denied.
   */
  async requestExtension(tableId: string, playerId: string): Promise<boolean> {
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    const key = `${tableId}:${playerId}`;
    const bank = this.playerBanks.get(key);

    if (!bank) return false;

    try {
      // vipService.useFeature handles the full flow:
      // 1. VIP with quota → consume quota (free)
      // 2. VIP exhausted → charge diamonds
      // 3. Non-VIP → charge diamonds
      const { vipService } = await import('../services/VIPService');
      const result = await vipService.useFeature(playerId, 'time_bank_seconds');

      if (!result.success) {
        masterBus.emit('TIME_BANK_EXTENSION_DENIED', {
          tableId,
          playerId,
          reason: result.charged === 0 ? 'insufficient_diamonds' : 'unknown',
        });
        return false;
      }

      // Grant the extension
      bank.usesRemaining += 1;
      bank.remainingSeconds += config.secondsPerUse;

      masterBus.emit('TIME_BANK_EXTENDED', {
        tableId,
        playerId,
        secondsAdded: config.secondsPerUse,
        diamondsCharged: result.charged,
        usesRemaining: bank.usesRemaining,
        remainingSeconds: bank.remainingSeconds,
      });

      return true;
    } catch (err) {
      console.error('[TimeBankEngine] Extension request failed:', err);
      masterBus.emit('TIME_BANK_EXTENSION_DENIED', {
        tableId,
        playerId,
        reason: 'error',
      });
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  dispose(tableId: string): void {
    for (const [key, bank] of this.playerBanks) {
      if (key.startsWith(`${tableId}:`)) {
        if (bank.activeTimer) clearTimeout(bank.activeTimer);
        this.playerBanks.delete(key);
      }
    }
    this.tableConfigs.delete(tableId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════════════════

  private onTimeBankExpired(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const bank = this.playerBanks.get(key);
    if (!bank) return;

    // Deduct full use seconds from remaining
    bank.remainingSeconds = Math.max(0, bank.remainingSeconds - bank.currentUseSeconds);
    bank.isActive = false;
    bank.activeTimer = undefined;
    bank.activatedAt = undefined;

    const isDepleted = bank.usesRemaining <= 0 || bank.remainingSeconds <= 0;

    masterBus.emit(isDepleted ? 'TIME_BANK_DEPLETED' : 'TIME_BANK_EXPIRED', {
      tableId,
      playerId,
      remainingSeconds: bank.remainingSeconds,
      usesRemaining: bank.usesRemaining,
    });

    // Execute the expiry callback (auto-fold/auto-check)
    if (bank.onExpire) {
      bank.onExpire();
      bank.onExpire = undefined;
    }
  }
}

export const timeBankEngine = new TimeBankEngineClass();
export default timeBankEngine;
