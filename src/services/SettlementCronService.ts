/**
 * Retained import boundary for obsolete browser settlement callers.
 * Weekly accounting is recorded by the existing server coordinator. A browser
 * timer, wallet subtotal or local-clock countdown cannot certify that work.
 */
export interface CronConfig {
  checkIntervalMs?: number;
  autoExecutePayouts?: boolean;
  requireCanaryCheck?: boolean;
}

/** Legacy shape retained for callers during the coordinated reader upgrade. */
export interface CanaryResult {
  passed: boolean;
  totalCredits: number;
  totalDebits: number;
  difference: number;
}

function retired(): never {
  throw new Error('Weekly Accounting Is Automatic. Refresh The Recorded Accounting Status.');
}

export const SettlementCronService = Object.freeze({
  start(_config: CronConfig = {}): never {
    return retired();
  },
  async check(): Promise<never> {
    return retired();
  },
  async runCanaryCheck(): Promise<CanaryResult> {
    return retired();
  },
  // No timer is owned here. Cleanup is safe during app disposal.
  stop(): void {},
  getStatus() {
    return {
      state: 'browser_scheduler_retired' as const,
      isRunning: false as const,
      lastCheckAt: null,
      nextCheckMs: null,
      nextSnapshotAt: null,
      nextPayoutAt: null,
    };
  },
  getNextSundaySnapshot(): never {
    return retired();
  },
  getNextMondayPayout(): never {
    return retired();
  },
  formatCountdown(_target: Date): never {
    return retired();
  },
});

export default SettlementCronService;
