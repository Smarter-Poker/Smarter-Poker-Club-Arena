/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * AUTO-REBUY SERVICE — Keeps Horses Funded and Playing
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Monitors horse stacks across all tables and automatically rebuys when:
 * - Horse stack drops to 0 (busted)
 * - Horse stack drops below 20 BB (short-stacked)
 * - Horse is removed from table but should be re-seated
 *
 * Also handles:
 * - Topping up horse wallets when running low
 * - Reseating horses that got disconnected
 * - Maintaining minimum horse count per table
 */

import { supabase } from '../lib/supabase';
import { HydraService } from './HydraService';
import { horseBugReporter } from './HorseBugReporter';
import { WalletService } from './WalletService';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface AutoRebuyConfig {
  monitoringInterval: number; // ms between checks (default: 30000)
  minStackBB: number; // trigger rebuy if stack < minStackBB (default: 20)
  rebuyStackBB: number; // rebuy to this many BB (default: 100)
  minHorsesPerTable: number; // seed more if below this (default: 2)
  minWalletBalance: number; // top up wallet if below this (default: 50000)
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class AutoRebuyServiceCore {
  private isRunning = false;
  private monitoringInterval: number;
  private minStackBB: number;
  private rebuyStackBB: number;
  private minHorsesPerTable: number;
  private minWalletBalance: number;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private rebuyInProgress: Set<string> = new Set(); // Track concurrent rebuys by horse:table

  // ── Network circuit breaker — suppress Sentry spam on transient Supabase timeouts ──
  private _netCb = (() => {
    let failures = 0,
      trippedAt = 0;
    const THRESHOLD = 3,
      COOLDOWN_MS = 5 * 60_000;
    return {
      isOpen(): boolean {
        if (failures < THRESHOLD) return false;
        if (Date.now() - trippedAt > COOLDOWN_MS) {
          failures = 0;
          trippedAt = 0;
          return false;
        }
        return true;
      },
      trip(): void {
        failures++;
        if (failures >= THRESHOLD && trippedAt === 0) {
          trippedAt = Date.now();
          console.debug('[AutoRebuy] Network circuit OPEN — silencing repeated Supabase errors');
        }
      },
    };
  })();

  // ── Tab leader election (prevents multi-tab race conditions) ──
  private tabId = Math.random().toString(36).slice(2, 10);
  private isLeader = false;
  private leaderChannel: BroadcastChannel | null = null;
  private leaderHeartbeatHandle: ReturnType<typeof setInterval> | null = null;
  private lastLeaderHeartbeat = 0;

  constructor(config: Partial<AutoRebuyConfig> = {}) {
    this.monitoringInterval = config.monitoringInterval ?? 30000;
    this.minStackBB = config.minStackBB ?? 20;
    this.rebuyStackBB = config.rebuyStackBB ?? 100;
    this.minHorsesPerTable = config.minHorsesPerTable ?? 4;
    this.minWalletBalance = config.minWalletBalance ?? 50000;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TAB LEADER ELECTION — Only ONE tab runs AutoRebuy at a time
  // ─────────────────────────────────────────────────────────────────────────────

  private initLeaderElection(): void {
    try {
      this.leaderChannel = new BroadcastChannel('autorebuy-leader');
      this.leaderChannel.onmessage = (e) => {
        if (e.data?.type === 'heartbeat' && e.data.tabId !== this.tabId) {
          // Another tab is the leader — step down
          if (this.isLeader) {
            console.debug(`[AutoRebuy:${this.tabId}] Yielding leadership to ${e.data.tabId}`);
          }
          this.isLeader = false;
          this.lastLeaderHeartbeat = Date.now();
        } else if (e.data?.type === 'claim' && e.data.tabId !== this.tabId) {
          // Another tab wants leadership — if we're leader, reassert
          if (this.isLeader) {
            this.leaderChannel?.postMessage({ type: 'heartbeat', tabId: this.tabId });
          }
        }
      };

      // Try to claim leadership after a short random delay (jitter to avoid simultaneous claims)
      setTimeout(
        () => {
          if (!this.isLeader && Date.now() - this.lastLeaderHeartbeat > 5000) {
            this.claimLeadership();
          }
        },
        Math.random() * 2000 + 500
      );

      // Check for stale leader every 10 seconds
      this.leaderHeartbeatHandle = setInterval(() => {
        if (this.isLeader) {
          // We're leader — send heartbeat
          this.leaderChannel?.postMessage({ type: 'heartbeat', tabId: this.tabId });
        } else if (Date.now() - this.lastLeaderHeartbeat > 15000) {
          // No heartbeat in 15s — leader tab is gone, claim leadership
          this.claimLeadership();
        }
      }, 5000);
    } catch (e) {
      reportError(e, 'AutoRebuyService.setInterval');
      // BroadcastChannel not available — just become leader (single tab)
      this.isLeader = true;
      console.debug(
        `[AutoRebuy:${this.tabId}] BroadcastChannel unavailable — becoming leader by default`
      );
    }
  }

  private claimLeadership(): void {
    this.isLeader = true;
    this.leaderChannel?.postMessage({ type: 'heartbeat', tabId: this.tabId });
    console.debug(`[AutoRebuy:${this.tabId}] Claimed leadership`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // START / STOP
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Start auto-rebuy monitoring
   */
  start(): void {
    if (this.isRunning) {
      console.debug('[AutoRebuy] Already running');
      return;
    }

    this.isRunning = true;
    this.initLeaderElection();
    console.debug(
      `[AutoRebuy:${this.tabId}] Starting monitoring (interval: ${this.monitoringInterval}ms)`
    );

    // Initial check (delayed to let leader election settle)
    setTimeout(() => this.checkAllTables(), 3000);

    // Recurring checks
    this.intervalHandle = setInterval(() => {
      this.checkAllTables();
    }, this.monitoringInterval);
  }

  /**
   * Stop auto-rebuy monitoring
   */
  stop(): void {
    if (!this.isRunning) {
      console.debug('[AutoRebuy] Not running');
      return;
    }

    this.isRunning = false;
    this.isLeader = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.leaderHeartbeatHandle) {
      clearInterval(this.leaderHeartbeatHandle);
      this.leaderHeartbeatHandle = null;
    }
    if (this.leaderChannel) {
      this.leaderChannel.close();
      this.leaderChannel = null;
    }

    console.debug('[AutoRebuy] Stopped monitoring');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MAIN MONITORING LOGIC
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check all active tables and process rebuys
   */
  private async checkAllTables(): Promise<void> {
    // Only the leader tab runs AutoRebuy to prevent multi-tab race conditions
    if (!this.isLeader) {
      return;
    }

    try {
      // Get all active/waiting/running tables — horses should be managed in all live states.
      // Tables transition: waiting → active → running during gameplay.
      const { data: tables, error: tableError } = await supabase
        .from('tables')
        .select('id, big_blind')
        .in('status', ['active', 'waiting', 'running']);

      if (tableError) {
        // Transient network failures (TypeError: Load failed) should not flood Sentry.
        // Gate behind the instance-level circuit breaker.
        if (!this._netCb.isOpen()) {
          this._netCb.trip();
          reportError(tableError, 'AutoRebuyService.checkAllTables.fetchTables');
        } else {
          console.debug('[AutoRebuy] fetchTables error (circuit open):', tableError.message);
        }
        return;
      }

      if (!tables || tables.length === 0) {
        return;
      }

      // Process each table in parallel for improved throughput
      const results = await Promise.allSettled(
        tables.map((table) => this.processTable(table.id, table.big_blind))
      );

      // Log any individual table failures
      results.forEach((result, idx) => {
        if (result.status === 'rejected') {
          console.debug(
            '[AutoRebuy] Error processing table ' + tables[idx].id + ':',
            result.reason
          );
        }
      });
    } catch (err: unknown) {
      reportError(err, 'AutoRebuyService.checkAllTables');
    }
  }

  /**
   * Process a single table for rebuys and maintenance
   */
  private async processTable(tableId: string, bigBlind: number): Promise<void> {
    // Step 1: Check horse stacks and process rebuys
    const horseStacks = await this.getTableHorseStacks(tableId);

    for (const horse of horseStacks) {
      const stackInBB = horse.stack / bigBlind;

      if (horse.stack === 0) {
        // Horse is busted — direct stack update to rebuy amount.
        // DO NOT use reseatHorse() which does a destructive remove+reseat cycle
        // that conflicts with HeadlessTableEngine's autorebuyHorses (also does
        // direct stack updates). The remove+reseat path caused duplicate seats
        // and phantom "drain" as the old row was deleted mid-hand.
        const rebuyAmount = this.rebuyStackBB * bigBlind;
        await this.rebuyHorse(horse.horseId, tableId, rebuyAmount);
      } else if (stackInBB < this.minStackBB) {
        // Horse is short-stacked - top up stack
        const topupAmount = this.rebuyStackBB * bigBlind - horse.stack;
        await this.rebuyHorse(horse.horseId, tableId, topupAmount);
      }
    }

    // Step 2: Ensure minimum horses at table
    await this.ensureMinimumHorses(tableId, this.minHorsesPerTable);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // REBUY / RESEAT LOGIC
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get a consistent lock key for horse operations
   */
  private getHorseLockKey(horseId: string, tableId: string): string {
    return `${horseId}:${tableId}`;
  }

  /**
   * Rebuy a horse (top up stack via wallet)
   * Prevents concurrent rebuys for same horse:table combination
   */
  async rebuyHorse(horseId: string, tableId: string, amount: number): Promise<boolean> {
    const rebuyKey = this.getHorseLockKey(horseId, tableId);

    // Skip if rebuy already in progress for this horse:table
    if (this.rebuyInProgress.has(rebuyKey)) {
      console.debug('[AutoRebuy] Rebuy already in progress for ' + rebuyKey);
      return false;
    }

    this.rebuyInProgress.add(rebuyKey);
    try {
      // Direct stack UPDATE — atomic_table_rebuy RPC has UUID type mismatch bug.
      // This achieves the same result: add chips to horse's current stack.
      const { data: currentSeat, error: fetchErr } = await supabase
        .from('table_seats')
        .select('stack')
        .eq('table_id', tableId)
        .eq('user_id', horseId)
        .is('left_at', null)
        .maybeSingle();

      if (fetchErr || !currentSeat) {
        console.debug(
          '[AutoRebuy] Could not find seat for rebuy — horse ' +
            horseId +
            ': ' +
            (fetchErr?.message || 'seat not found')
        );
        return false;
      }

      const newStack = (currentSeat.stack || 0) + amount;
      const { error: updateErr } = await retryAsync(
        () =>
          supabase
            .from('table_seats')
            .update({ stack: newStack })
            .eq('table_id', tableId)
            .eq('user_id', horseId)
            .is('left_at', null),
        3
      );

      if (updateErr) {
        console.debug(
          '[AutoRebuy] Stack update failed for horse ' + horseId + ':',
          updateErr.message
        );
        horseBugReporter.report({
          horseName: 'AutoRebuy',
          horseId,
          tableId,
          tableName: tableId,
          handNumber: 0,
          category: 'wallet_sync',
          severity: 'high',
          title: 'Auto-rebuy failed',
          description:
            'Could not complete stack update of ' +
            amount +
            ' chips: ' +
            (updateErr.message || 'unknown error'),
          context: { horseId, tableId, amount },
        });
        return false;
      }

      masterBus.emit('BALANCE_UPDATED', { source: 'auto_rebuy_horse', userId: horseId });

      horseBugReporter.report({
        horseName: 'AutoRebuy',
        horseId,
        tableId,
        tableName: tableId,
        handNumber: 0,
        category: 'chip_integrity',
        severity: 'info',
        title: 'Auto-rebuy completed',
        description: 'Horse topped up with ' + amount + ' chips',
        context: { horseId, tableId, amount },
      });

      console.debug(
        '[AutoRebuy] Rebought horse ' + horseId + ' for ' + amount + ' at table ' + tableId
      );
      return true;
    } catch (err: unknown) {
      reportError(err, 'AutoRebuyService.rebuyHorse');
      return false;
    } finally {
      this.rebuyInProgress.delete(rebuyKey);
    }
  }

  /**
   * Reseat a busted horse with fresh stack
   * Prevents concurrent reseating for same horse:table combination
   */
  async reseatHorse(horseId: string, tableId: string): Promise<boolean> {
    const reseatKey = this.getHorseLockKey(horseId, tableId);

    // Skip if reseat already in progress for this horse:table
    if (this.rebuyInProgress.has(reseatKey)) {
      console.debug('[AutoRebuy] Reseat already in progress for ' + reseatKey);
      return false;
    }

    this.rebuyInProgress.add(reseatKey);
    try {
      // Get table info for BB
      const { data: tableData } = await supabase
        .from('tables')
        .select('big_blind')
        .eq('id', tableId)
        .maybeSingle();

      if (!tableData) {
        console.debug('[AutoRebuy] Table not found:', tableId);
        return false;
      }

      const bigBlind = tableData.big_blind || 2;

      // Random delay before reseating (5-15 seconds)
      const delay = 5000 + Math.random() * 10000;
      await new Promise((resolve) => setTimeout(resolve, delay));

      // Step 1: Remove the busted horse
      const removed = await HydraService.removeHorse(tableId, horseId);
      if (!removed) {
        console.debug('[AutoRebuy] Failed to remove busted horse ' + horseId);
        return false;
      }

      // Step 2: Check wallet balance and top up if needed
      await this.topUpWallet(horseId, this.rebuyStackBB * bigBlind);

      // Step 3: Reseat the horse
      const seated = await HydraService.seatHorse(horseId, tableId, bigBlind);
      if (!seated) {
        console.debug('[AutoRebuy] Failed to reseat horse ' + horseId);
        return false;
      }

      horseBugReporter.report({
        horseName: 'AutoRebuy',
        horseId,
        tableId,
        tableName: tableId,
        handNumber: 0,
        category: 'gameplay_anomaly',
        severity: 'info',
        title: 'Horse reseated after bust',
        description:
          'Busted horse removed and re-seated with fresh ' +
          this.rebuyStackBB * bigBlind +
          ' chip stack',
        context: { horseId, tableId, newStack: this.rebuyStackBB * bigBlind },
      });

      console.debug('[AutoRebuy] Reseated horse ' + horseId + ' at table ' + tableId);
      return true;
    } catch (err: unknown) {
      reportError(err, 'AutoRebuyService.reseatHorse');
      return false;
    } finally {
      const reseatKey = this.getHorseLockKey(horseId, tableId);
      this.rebuyInProgress.delete(reseatKey);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WALLET & SEATING MAINTENANCE
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Ensure minimum horses at table (seed if needed)
   */
  async ensureMinimumHorses(tableId: string, minCount: number): Promise<void> {
    try {
      const horses = await HydraService.getActiveHorses(tableId);
      const currentHorseCount = horses.length;

      if (currentHorseCount < minCount) {
        const needToAdd = minCount - currentHorseCount;

        // Get table info
        const { data: tableData } = await supabase
          .from('tables')
          .select('big_blind')
          .eq('id', tableId)
          .maybeSingle();

        if (!tableData) {
          console.debug('[AutoRebuy] Table not found:', tableId);
          return;
        }

        const bigBlind = tableData.big_blind || 2;

        // Seed additional horses
        const seeded = await HydraService.seedTable(tableId, bigBlind);
        if (seeded.length > 0) {
          console.debug('[AutoRebuy] Seeded ' + seeded.length + ' horses at table ' + tableId);
        }
      }
    } catch (err: unknown) {
      reportError(err, 'AutoRebuyService.ensureMinimumHorses');
    }
  }

  /**
   * Top up horse wallet if balance is low
   */
  async topUpWallet(horseId: string, requiredAmount: number): Promise<boolean> {
    try {
      // Get current wallet balance
      const { data: walletData, error: walletError } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', horseId)
        .eq('wallet_type', 'PLAYER')
        .maybeSingle();

      if (walletError) {
        reportError(walletError, 'AutoRebuyService.topUpWallet.fetchWallet', { horseId });
        return false;
      }

      const currentBalance = walletData?.balance || 0;

      // If balance is sufficient, no topup needed
      if (currentBalance >= this.minWalletBalance && currentBalance >= requiredAmount) {
        return true;
      }

      // Calculate topup amount (ensure it's non-negative)
      const topupAmount = Math.max(0, this.minWalletBalance - currentBalance);

      // If no topup needed, return success
      if (topupAmount === 0) {
        return true;
      }

      // Atomic credit and log via RPC
      const { data: creditResult, error: creditError } = await retryAsync(
        () =>
          supabase.rpc('atomic_credit_wallet_and_log', {
            p_user_id: horseId,
            p_amount: topupAmount,
            p_category: 'topup',
            p_description: 'Auto-rebuy: wallet topup ' + topupAmount + ' credits',
            p_table_id: null,
            p_hand_id: null,
            p_related_entity_id: null,
          }),
        3
      );

      if (creditError) {
        reportError(creditError, 'AutoRebuyService.executeRebuy');
        console.debug(
          '[AutoRebuy] Wallet topup failed for horse ' + horseId + ':',
          creditError.message
        );
        horseBugReporter.report({
          horseName: 'AutoRebuy',
          horseId,
          tableId: 'unknown',
          tableName: 'Unknown',
          handNumber: 0,
          category: 'wallet_sync',
          severity: 'high',
          title: 'Auto-rebuy wallet topup failed',
          description:
            'Could not credit ' +
            topupAmount +
            ' to horse wallet: ' +
            (creditError.message || 'unknown error'),
          context: { horseId, topupAmount },
        });
        return false;
      }

      masterBus.emit('BALANCE_UPDATED', { source: 'auto_rebuy_topup', userId: horseId });

      console.debug(
        '[AutoRebuy] Topped up horse ' +
          horseId +
          ' wallet with ' +
          topupAmount +
          ' credits (atomically logged)'
      );
      return true;
    } catch (err: unknown) {
      reportError(err, 'AutoRebuyService.topUpWallet');
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DATA QUERIES
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get all horses and their current stacks at a table
   */
  async getTableHorseStacks(tableId: string): Promise<Array<{ horseId: string; stack: number }>> {
    try {
      const horses = await HydraService.getActiveHorses(tableId);
      return horses.map((h) => ({
        horseId: h.id,
        stack: h.stack,
      }));
    } catch (err: unknown) {
      reportError(err, 'AutoRebuyService.getTableHorseStacks');
      return [];
    }
  }

  /**
   * Get status information
   */
  getStatus(): {
    isRunning: boolean;
    config: {
      monitoringInterval: number;
      minStackBB: number;
      rebuyStackBB: number;
      minHorsesPerTable: number;
      minWalletBalance: number;
    };
  } {
    return {
      isRunning: this.isRunning,
      config: {
        monitoringInterval: this.monitoringInterval,
        minStackBB: this.minStackBB,
        rebuyStackBB: this.rebuyStackBB,
        minHorsesPerTable: this.minHorsesPerTable,
        minWalletBalance: this.minWalletBalance,
      },
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export const AutoRebuyService = new AutoRebuyServiceCore();

export default AutoRebuyService;
