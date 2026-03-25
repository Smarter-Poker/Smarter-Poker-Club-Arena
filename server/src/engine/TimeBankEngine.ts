/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TIME BANK ENGINE — Extended Think Time for Critical Decisions
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages time bank allocations for poker players:
 * - Configurable time banks per session (default: 30s pool, 4 uses)
 * - Auto-activate when player's primary action timer expires
 * - Optional orbit-based refill (1 bank per orbit)
 * - Integrates with PreciseActionTimer for countdown
 *
 * Ported from client: src/engine/TimeBankEngine.ts
 * Server adaptation: No masterBus, no VIPService — uses callbacks for events.
 */

import { PreciseActionTimer } from './PreciseActionTimer.js';

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
  remainingSeconds: number;
  usesRemaining: number;
  isActive: boolean;
  activatedAt?: number;
  currentUseSeconds: number;
  onExpire?: () => void;
}

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

  private readonly DEFAULT_CONFIG: TimeBankConfig = {
    totalBankSeconds: 30,
    maxUses: 4,
    secondsPerUse: 15,
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
   * Called when a player's primary action timer expires.
   * If auto-activate is on and player has time bank remaining,
   * automatically activates the time bank.
   */
  onPrimaryTimerExpired(tableId: string, playerId: string, onExpire: () => void): boolean {
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    if (!config.autoActivate) return false;
    return this.activate(tableId, playerId, onExpire);
  }

  /**
   * Manually activate time bank for a player.
   */
  activate(tableId: string, playerId: string, onExpire: () => void): boolean {
    const key = `${tableId}:${playerId}`;
    const bank = this.playerBanks.get(key);
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;

    if (!bank || bank.isActive) return false;
    if (bank.usesRemaining <= 0 || bank.remainingSeconds <= 0) return false;

    const useSeconds = Math.min(config.secondsPerUse, bank.remainingSeconds);

    bank.isActive = true;
    bank.activatedAt = Date.now();
    bank.currentUseSeconds = useSeconds;
    bank.usesRemaining--;
    bank.onExpire = onExpire;

    this.emitEvent({
      type: 'TIME_BANK_ACTIVATED',
      tableId,
      playerId,
      secondsGranted: useSeconds,
      usesRemaining: bank.usesRemaining,
      totalRemaining: bank.remainingSeconds,
    });

    // Use PreciseActionTimer for the countdown
    this.preciseTimer.startTimer(tableId, `timebank:${playerId}`, useSeconds * 1000, () => {
      this.onTimeBankExpired(tableId, playerId);
    });

    return true;
  }

  /**
   * Player acted before time bank expired — cancel the countdown.
   */
  playerActed(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const bank = this.playerBanks.get(key);
    if (!bank || !bank.isActive) return;

    const elapsed = bank.activatedAt ? Math.ceil((Date.now() - bank.activatedAt) / 1000) : 0;
    const secondsUsed = Math.min(elapsed, bank.currentUseSeconds);
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
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ORBIT REFILL
  // ═══════════════════════════════════════════════════════════════════════════

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
    return !!bank && bank.usesRemaining > 0 && bank.remainingSeconds > 0;
  }

  getRemainingSeconds(tableId: string, playerId: string): number {
    return this.getPlayerBank(tableId, playerId)?.remainingSeconds ?? 0;
  }

  getUsesRemaining(tableId: string, playerId: string): number {
    return this.getPlayerBank(tableId, playerId)?.usesRemaining ?? 0;
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

  private onTimeBankExpired(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const bank = this.playerBanks.get(key);
    if (!bank) return;

    bank.remainingSeconds = Math.max(0, bank.remainingSeconds - bank.currentUseSeconds);
    bank.isActive = false;
    bank.activatedAt = undefined;

    const isDepleted = bank.usesRemaining <= 0 || bank.remainingSeconds <= 0;

    this.emitEvent({
      type: isDepleted ? 'TIME_BANK_DEPLETED' : 'TIME_BANK_EXPIRED',
      tableId,
      playerId,
      remainingSeconds: bank.remainingSeconds,
      usesRemaining: bank.usesRemaining,
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
        console.error('[TimeBankEngine] Event handler error:', err);
      }
    }
  }
}
