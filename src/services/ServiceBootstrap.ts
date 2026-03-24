/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SERVICE BOOTSTRAP — Centralized service initialization orchestrator
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Ensures all engine services start in the correct order with error isolation.
 * Call bootServices() once in App.tsx useEffect.
 */

import { masterBus } from '../core/MasterBus';
import { OfflineQueueService } from './OfflineQueueService';
import { SettlementCronService } from './SettlementCronService';
import { AutoRebuyService } from './AutoRebuyService';
import { FinancialCronService } from './FinancialCronService';

export interface BootResult {
  offlineQueue: boolean;
  settlementCron: boolean;
  autoRebuy: boolean;
  financialCron: boolean;
  timestamp: string;
}

let booted = false;

/**
 * Initialize all engine services in the correct order.
 * Idempotent — safe to call multiple times (only runs once).
 */
export async function bootServices(options?: {
  enableSettlementCron?: boolean;
}): Promise<BootResult> {
  if (booted) {
    console.debug('[ServiceBootstrap] Already booted — skipping');
    return {
      offlineQueue: true,
      settlementCron: true,
      autoRebuy: true,
      financialCron: true,
      timestamp: new Date().toISOString(),
    };
  }

  const result: BootResult = {
    offlineQueue: false,
    settlementCron: false,
    autoRebuy: false,
    financialCron: false,
    timestamp: new Date().toISOString(),
  };

  // 1. Offline Queue — must init before any financial operations
  try {
    await OfflineQueueService.init();
    result.offlineQueue = true;
    console.debug('[ServiceBootstrap] ✓ OfflineQueueService initialized');
  } catch (err: unknown) {
    console.debug('[ServiceBootstrap] ✗ OfflineQueueService failed:', err);
  }

  // 2. Settlement Cron — only for admin/owner roles
  if (options?.enableSettlementCron === true) {
    try {
      SettlementCronService.start({ checkIntervalMs: 60 * 60 * 1000 });
      result.settlementCron = true;
      console.debug('[ServiceBootstrap] ✓ SettlementCronService started');
    } catch (err: unknown) {
      console.debug('[ServiceBootstrap] ✗ SettlementCronService failed:', err);
    }
  }

  // 3. Auto-Rebuy Service — monitors all active tables, reseats busted horses, ensures 4 per table
  try {
    AutoRebuyService.start();
    result.autoRebuy = true;
    console.debug('[ServiceBootstrap] ✓ AutoRebuyService started');
  } catch (err: unknown) {
    console.debug('[ServiceBootstrap] ✗ AutoRebuyService failed:', err);
  }

  // 4. Financial Cron — reconciliation, suspension checks, audit trail
  try {
    FinancialCronService.start({
      reconciliationIntervalMs: 24 * 60 * 60 * 1000, // Daily
      suspensionCheckIntervalMs: 6 * 60 * 60 * 1000, // Every 6h
      autoSuspendEnabled: false, // Log-only by default
    });
    result.financialCron = true;
    console.debug('[ServiceBootstrap] ✓ FinancialCronService started');
  } catch (err: unknown) {
    console.debug('[ServiceBootstrap] ✗ FinancialCronService failed:', err);
  }

  booted = true;

  // Emit ready event so UI can react
  masterBus.emit('SERVICES_READY', {
    services: {
      offlineQueue: result.offlineQueue,
      settlementCron: result.settlementCron,
      autoRebuy: result.autoRebuy,
      financialCron: result.financialCron,
    } as Record<string, boolean>,
    timestamp: result.timestamp,
  });

  console.debug('[ServiceBootstrap] All services booted:', result);
  return result;
}

/**
 * Tear down all services (for cleanup/testing).
 */
export function shutdownServices(): void {
  OfflineQueueService.dispose();
  SettlementCronService.stop();
  FinancialCronService.stop();
  booted = false;
  console.debug('[ServiceBootstrap] Services shut down');
}
