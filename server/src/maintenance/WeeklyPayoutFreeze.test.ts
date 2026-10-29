import { describe, expect, it, vi } from 'vitest';
import {
  setMaintenanceFrozen,
  setWeeklyPayoutFrozen,
  isMaintenanceFrozen,
  isTerminalSettlementFrozen,
  onMaintenanceThaw,
  setLastHandSettlementWindow,
} from './freezeState.js';
describe('the last pause owner releases the original business sweeps', () => {
  it('neither daily thaw nor a foreign payout owner lifts the payout hold', () => {
    const thaw = vi.fn();
    const off = onMaintenanceThaw(thaw);
    try {
      setMaintenanceFrozen(true);
      setWeeklyPayoutFrozen('one', 'paying');
      setMaintenanceFrozen(false);
      expect(isMaintenanceFrozen()).toBe(true);
      expect(thaw).not.toHaveBeenCalled();
      setWeeklyPayoutFrozen('foreign', null);
      expect(isMaintenanceFrozen()).toBe(true);
      setWeeklyPayoutFrozen('one', null);
      expect(isMaintenanceFrozen()).toBe(false);
      expect(thaw).toHaveBeenCalledTimes(1);
    } finally {
      off();
      setWeeklyPayoutFrozen('one', null);
      setMaintenanceFrozen(false);
    }
  });
  it('payout completion cannot lift daily maintenance and emits no early thaw', () => {
    const thaw = vi.fn();
    const off = onMaintenanceThaw(thaw);
    try {
      setMaintenanceFrozen(true);
      setWeeklyPayoutFrozen('one', 'ready');
      setWeeklyPayoutFrozen('one', null);
      expect(isMaintenanceFrozen()).toBe(true);
      expect(thaw).not.toHaveBeenCalled();
      setMaintenanceFrozen(false);
      expect(thaw).toHaveBeenCalledTimes(1);
    } finally {
      off();
      setWeeklyPayoutFrozen('one', null);
      setMaintenanceFrozen(false);
    }
  });
  it('drains the already decided terminal hand before exclusive financial admission', () => {
    try {
      setMaintenanceFrozen(true);
      setLastHandSettlementWindow(1000);
      setWeeklyPayoutFrozen('one', 'draining');
      expect(isTerminalSettlementFrozen(500)).toBe(false);
      setWeeklyPayoutFrozen('one', 'ready');
      expect(isTerminalSettlementFrozen(500)).toBe(true);
    } finally {
      setWeeklyPayoutFrozen('one', null);
      setMaintenanceFrozen(false);
    }
  });
});
