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
    try {
      // Get all horse profiles along with their wallets
      const { data: horses, error: horseErr } = await supabase
        .from('profiles')
        .select('id, display_name, username, use_real_name')
        .eq('is_horse', true);

      if (horseErr || !horses || horses.length === 0) return;

      const horseIds = horses.map((h) => h.id);

      const { data: wallets, error: walletErr } = await supabase
        .from('wallets')
        .select('user_id, balance')
        .eq('wallet_type', 'PLAYER')
        .in('user_id', horseIds);

      if (walletErr || !wallets) return;

      let refilledCount = 0;

      for (const wallet of wallets) {
        if (wallet.balance < MIN_WALLET_BALANCE) {
          const topupAmount = Math.max(0, REFILL_AMOUNT - wallet.balance);
          if (topupAmount <= 0) continue;

          const horseNameMatch = horses.find((h) => h.id === wallet.user_id);
          const horseName = horseNameMatch
            ? horseNameMatch.use_real_name
              ? horseNameMatch.display_name || horseNameMatch.username
              : horseNameMatch.username || horseNameMatch.display_name
            : wallet.user_id;

          // Execute ATOMIC wallet refill
          const { error: creditError } = await supabase.rpc('atomic_credit_wallet_and_log', {
            p_user_id: wallet.user_id,
            p_amount: topupAmount,
            p_category: 'deposit',
            p_description: `Server Auto-rebuy: wallet deposit ${topupAmount} credits`,
            p_table_id: null,
            p_hand_id: null,
            p_related_entity_id: null,
          });

          if (creditError) {
            reportError(
              new Error(
                `[AutoRebuyService] Failed to refill wallet for ${horseName}: ${creditError.message}`
              ),
              'AutoRebuyService.Failed_to_refill_wallet_for_ho'
            );
          } else {
            refilledCount++;
            console.log(
              `[AutoRebuyService] Refilled wallet for horse ${horseName} with ${topupAmount} chips.`
            );
          }
        }
      }

      if (refilledCount > 0) {
        console.log(
          `[AutoRebuyService] Cycle complete: Top-ups issued for ${refilledCount} horses.`
        );
      }
    } catch (err: any) {
      reportError(
        new Error(`[AutoRebuyService] Wallet check error: ${err.message}`),
        'AutoRebuyService.Wallet_check_error'
      );
    }
  }
}
