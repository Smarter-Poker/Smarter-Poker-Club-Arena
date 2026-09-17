/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SERVICE BOOTSTRAP — Centralized service initialization orchestrator
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Ensures all engine services start in the correct order with error isolation.
 * Call bootServices() once in App.tsx useEffect.
 */

import { masterBus } from '../core/MasterBus';
import { soundService } from './SoundService';
import { OfflineQueueService } from './OfflineQueueService';
import { FinancialCronService } from './FinancialCronService';

export interface BootResult {
  offlineQueue: boolean;
  settlementCron: boolean;
  autoRebuy: boolean;
  financialCron: boolean;
  timestamp: string;
}

let bootResult: Readonly<BootResult> | null = null;

/**
 * Initialize all engine services in the correct order.
 * Idempotent — safe to call multiple times (only runs once).
 */
export async function bootServices(_options?: {
  /** Retired compatibility input; browser startup never starts accounting. */
  enableSettlementCron?: boolean;
}): Promise<BootResult> {
  if (bootResult) {
    console.debug('[ServiceBootstrap] Already booted - skipping');
    return { ...bootResult };
  }

  const result: BootResult = {
    offlineQueue: false,
    settlementCron: false,
    autoRebuy: false,
    financialCron: false,
    timestamp: new Date().toISOString(),
  };

  // 0. Sound — FIRST, and for one reason: its constructor installs the
  //    autoplay-unlock listeners, and those have to exist BEFORE the user's
  //    next click, not after it.
  //
  //    Dan 2026-08-24: "when you are spectating or watching a table it should
  //    have the same animations and graphics and game flow as if you're
  //    playing it... sound effects, everything."
  //
  //    Nothing in the sound path was ever gated on being seated - checked all
  //    of it. The gap was the AudioContext. SoundService was imported only by
  //    the lazily-loaded table chunk, so the context was constructed AFTER the
  //    click that opened the table had already been dispatched, and browsers
  //    only let a suspended context resume inside a gesture. A player who SITS
  //    clicks again within seconds (buy-in, fold, call) and unlocks it without
  //    noticing. A railbird clicks nothing, ever - so on iOS Safari and mobile
  //    Chrome the table stayed silent for the whole session.
  //
  //    Importing it here puts the listeners in place during boot, so the very
  //    first tap anywhere in the app unlocks audio for everyone.
  try {
    soundService.primeAudioUnlock();
    console.debug('[ServiceBootstrap] ✓ SoundService unlock listeners armed');
  } catch (err: unknown) {
    console.debug('[ServiceBootstrap] ✗ SoundService unlock failed:', err);
  }

  // 1. Offline Queue — must init before any financial operations
  try {
    await OfflineQueueService.init();
    result.offlineQueue = true;
    console.debug('[ServiceBootstrap] ✓ OfflineQueueService initialized');
  } catch (err: unknown) {
    console.debug('[ServiceBootstrap] ✗ OfflineQueueService failed:', err);
  }

  // 2. Weekly accounting belongs to the canonical server coordinator. The
  // compatibility field reports only that no browser accounting timer started;
  // it is not an observation of server scheduling or financial completion.

  // 3. Horse auto-rebuy / fleet management is SERVER-AUTHORITATIVE (Hetzner engine).
  //    The Hetzner engine fully owns horse funding and population:
  //      - HorseFleetManager (GameServer) maintains minimum horses per table + seating
  //        via fn_horse_seat_from_treasury.
  //      - ServerTableEngine rebuys busted horses (100BB, treasury-funded) with a
  //        stop-loss (leave after 2 rebuys) via fn_horse_fund_from_treasury.
  //    The old browser-side AutoRebuyService was a redundant second authority that
  //    double-debited the treasury / over-stacked horses (it topped up mid-session
  //    and rebought with NO stop-loss). It has been removed so the server is the
  //    single source of truth. Nothing to start client-side.
  result.autoRebuy = true;
  console.debug(
    '[ServiceBootstrap] ✓ Horse auto-rebuy is server-authoritative (no client monitor)'
  );

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

  // 5. Warm only the auth-token cache. Opening /ws/multi here made every
  //    authenticated route depend on the game engine even when the player was
  //    visiting Stats, Cashier, Challenges, or Settings. An engine deploy then
  //    surfaced as a browser-level 502 on otherwise healthy non-game pages and
  //    added a needless handshake to their load path. Table clients still call
  //    acquire() when a player actually joins a game, using this warm token.
  void import('../lib/authToken')
    .then(({ initAuthTokenCache }) => {
      initAuthTokenCache();
      console.debug('[ServiceBootstrap] ✓ Engine auth-token cache warmed');
    })
    .catch((err: unknown) => {
      console.debug('[ServiceBootstrap] ✗ Engine auth-token cache warm skipped:', err);
    });

  bootResult = Object.freeze({ ...result });

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
  FinancialCronService.stop();
  bootResult = null;
  console.debug('[ServiceBootstrap] Services shut down');
}
