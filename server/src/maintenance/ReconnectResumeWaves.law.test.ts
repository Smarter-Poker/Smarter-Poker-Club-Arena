import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MaintenanceBreak,
  type PersistedMaintenanceBreak,
  type PausableTableEngine,
} from './MaintenanceBreak.js';
import { DisconnectEngine } from '../engine/DisconnectEngine.js';
import { PreciseActionTimer } from '../engine/PreciseActionTimer.js';
import { setMaintenanceFrozen } from './freezeState.js';

let testEpoch = Date.parse('2026-09-09T20:54:50Z');
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setMaintenanceFrozen(false);
  vi.useRealTimers();
});

describe('maintenance resume waves preserve the remaining reconnect allowance', () => {
  it.each(['success', 'retry'] as const)(
    'covers database thaw %s and all eight waves without refilling any grant',
    async (thawMode) => {
      vi.useFakeTimers();
      testEpoch += 3_600_000;
      vi.setSystemTime(testEpoch);
      const timer = new PreciseActionTimer();
      const disconnect = new DisconnectEngine(timer);
      cleanups.push(
        () => timer.dispose(),
        () => disconnect.disposeAll()
      );
      const deadlineAtResume = new Map<string, { actual: number | null; expected: number }>();
      const engines = new Map<string, PausableTableEngine>();
      const membership = [
        { is_vip: false, vip_expires_at: null },
        { is_vip: true, vip_expires_at: null },
        { is_vip: true, vip_expires_at: '2026-10-01T00:00:00Z' },
        { is_vip: true, vip_expires_at: '2026-09-01T00:00:00Z' },
        { is_vip: false, vip_expires_at: '2026-10-01T00:00:00Z' },
      ];
      for (let i = 0; i < 200; i++) {
        const table = `wave-table-${i}`;
        const member = membership[i % membership.length];
        const remaining = i % 5 === 1 || i % 5 === 2 ? 35_000 : 20_000;
        disconnect.registerPlayer(table, 'u', member);
        disconnect.markDisconnected(table, 'u');
        engines.set(table, {
          pauseForMaintenance() {},
          isParkedBetweenHands: () => true,
          isBetweenHands: () => true,
          isRunning: () => true,
          resumeFromMaintenance() {
            // A real turn immediately consumes the clock at the resume boundary.
            disconnect.onPlayerTurn(table, 'u', true);
            deadlineAtResume.set(table, {
              actual: disconnect.armedAutoActionDeadlineMs(table, 'u'),
              expected: Date.now() + remaining,
            });
          },
        });
      }
      let releaseThaw!: () => void;
      const thawWait = new Promise<void>((resolve) => {
        releaseThaw = resolve;
      });
      let row: PersistedMaintenanceBreak | null = null;
      let thawCalls = 0;
      const mb = new MaintenanceBreak({
        store: {
          load: async () => row,
          loadReleaseBoundary: async () => null,
          save: async (state) => {
            row = { ...state };
          },
          clear: async () => {
            row = null;
          },
          claim: async (expected, replacement) => {
            if (!row || row.ownershipToken !== expected) return null;
            row = { ...row, ownershipToken: replacement };
            return row;
          },
        },
        engines: () => engines.entries(),
        isRunning: () => true,
        emit() {},
        thaw: async () => {
          thawCalls++;
          await thawWait;
          if (thawMode === 'retry' && thawCalls === 1) {
            throw new Error('isolated thaw failure');
          }
        },
      });
      cleanups.push(() => mb.stop());
      await mb.announceLastHand();
      vi.setSystemTime(Date.now() + 10_000);
      await mb.beginCountdown();
      vi.setSystemTime(Date.now() + 300_000);
      const ending = mb.end();
      // A snapshot can observe the original thaw while the DB request waits.
      disconnect.getFsmStatesForTable('wave-table-199');
      vi.setSystemTime(Date.now() + 8_000);
      releaseThaw();
      await Promise.resolve();
      await Promise.resolve();
      if (thawMode === 'retry') {
        expect(deadlineAtResume.size, 'a failed thaw installment admitted play').toBe(0);
        await vi.advanceTimersByTimeAsync(MaintenanceBreak.THAW_RECOVERY_RETRY_MS);
      }
      await ending;
      expect(deadlineAtResume.size).toBe(25);
      // Reading a waiting table must not prevent its later wave compensation.
      const partial = disconnect.getFsmStatesForTable('wave-table-199');
      await vi.advanceTimersByTimeAsync(MaintenanceBreak.RESUME_SPREAD_MS);
      expect(deadlineAtResume.size).toBe(200);
      for (const [table, receipt] of deadlineAtResume) {
        expect(receipt.actual, table).toBe(receipt.expected);
      }
      const restored = new DisconnectEngine(timer);
      cleanups.push(() => restored.disposeAll());
      restored.restoreFsmStates('wave-table-199', partial);
      const final = disconnect.getFsmState('wave-table-199', 'u');
      expect(restored.getFsmState('wave-table-199', 'u')?.graceDeadlineMs).toBe(
        final?.graceDeadlineMs
      );
      const settled = restored.getFsmStatesForTable('wave-table-199');
      restored.restoreFsmStates('wave-table-199', settled);
      expect(restored.getFsmState('wave-table-199', 'u')?.graceDeadlineMs).toBe(
        final?.graceDeadlineMs
      );
    }
  );
});
