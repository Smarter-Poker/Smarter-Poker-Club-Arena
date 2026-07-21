/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SERVER AUTO-REBUY SERVICE — Keeps Horses Funded and Playing (Node.js Daemon)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Monitors horse wallets globally. Checks every 30 seconds.
 * If a horse wallet drops below 50,000 chips, it uses atomic_credit_wallet_and_log
 * to automatically refill their global wallet balance.
 *
 * NOTE: In-game busted rebuy logic is ALREADY handled separately by ServerTableEngine
 * at line 630 of ServerTableEngine.ts. This service exclusively handles wallet
 * top-ups so they never fail to buy back in.
 *
 * ZERO browser dependency — this is the SERVER version.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

const MIN_WALLET_BALANCE = 50000;
const REFILL_AMOUNT = 100000;

export class AutoRebuyService {
  private isRunning = false;
  private intervalHandle: NodeJS.Timeout | null = null;

  start(): void {
    if (this.isRunning) {
      console.log('[AutoRebuyService] Already running');
      return;
    }

    this.isRunning = true;
    console.log('[AutoRebuyService] Service started — wallet check every 30s');

    // Check every 30s
    this.intervalHandle = setInterval(() => this.checkAndRefillWallets(), 30 * 1000);
    this.checkAndRefillWallets();
  }

  stop(): void {
    if (!this.isRunning) return;

    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = null;
    this.isRunning = false;

    console.log('[AutoRebuyService] Stopped');
  }

  private async checkAndRefillWallets(): Promise<void> {
    // RETIRED (2026-07-21): this used to mint chips into every horse's global
    // PLAYER wallet (atomic_credit_wallet_and_log with no offsetting debit) —
    // the primary chip-conservation violation for horses. Horses are now funded
    // directly from the treasury of the club whose table they are playing at
    // (fn_horse_seat_from_treasury on seating, fn_horse_fund_from_treasury on
    // rebuy — see autoRebuyHorse), so horse wallets are no longer used for cash
    // rebuys and this global refill is intentionally a no-op.
    return;
  }
}
