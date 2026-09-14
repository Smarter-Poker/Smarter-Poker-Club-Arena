import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  certifyOperationGlobalRelease,
  isMaintenanceFrozen,
  isMaintenanceFrozenForTable,
  markOperationTableResumed,
  onNextMaintenanceThaw,
  setMaintenanceFrozen,
} from './freezeState.js';
afterEach(() => setMaintenanceFrozen(false));
describe('the certified global boundary is a synchronous predicate', () => {
  it('stays held without a receipt regardless of elapsed target/deadline time', () => {
    setMaintenanceFrozen(true);
    expect(isMaintenanceFrozen()).toBe(true);
    expect(isMaintenanceFrozenForTable('held')).toBe(true);
  });
  it('ends on the informed monotonic boundary without a timer callback', () => {
    let now = 99;
    setMaintenanceFrozen(true);
    markOperationTableResumed('already-acknowledged');
    certifyOperationGlobalRelease('durable-receipt', 100, () => now);
    expect(isMaintenanceFrozen()).toBe(true);
    expect(isMaintenanceFrozenForTable('already-acknowledged')).toBe(false);
    expect(isMaintenanceFrozenForTable('held')).toBe(true);
    now = 100;
    expect(isMaintenanceFrozen()).toBe(false);
    expect(isMaintenanceFrozenForTable('held')).toBe(false);
    now = 10000;
    expect(isMaintenanceFrozen()).toBe(false);
  });
  it('refuses a replacement certificate and a distinct pause clears the old boundary', () => {
    setMaintenanceFrozen(true);
    certifyOperationGlobalRelease('original', 100, () => 200);
    expect(() => certifyOperationGlobalRelease('different', 300, () => 200)).toThrow(
      'certificate_changed'
    );
    expect(isMaintenanceFrozen()).toBe(false);
    setMaintenanceFrozen(true);
    expect(isMaintenanceFrozen()).toBe(true);
    expect(isMaintenanceFrozenForTable('old')).toBe(true);
  });
  it('delivers owed work once when the predicate observes thaw before the timer', async () => {
    let now = 1;
    const owed = vi.fn(),
      cancelled = vi.fn(),
      controller = new AbortController();
    setMaintenanceFrozen(true);
    onNextMaintenanceThaw(owed);
    onNextMaintenanceThaw(cancelled, controller.signal);
    controller.abort();
    certifyOperationGlobalRelease('certificate', 2, () => now);
    expect(isMaintenanceFrozen()).toBe(true);
    expect(owed).not.toHaveBeenCalled();
    now = 3;
    expect(isMaintenanceFrozen()).toBe(false);
    expect(owed).toHaveBeenCalledTimes(1);
    setMaintenanceFrozen(false);
    expect(owed).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    const alreadyThawed = vi.fn(),
      retired = vi.fn();
    onNextMaintenanceThaw(alreadyThawed);
    const cancel = onNextMaintenanceThaw(retired);
    cancel();
    await Promise.resolve();
    expect(alreadyThawed).toHaveBeenCalledTimes(1);
    expect(retired).not.toHaveBeenCalled();
  });
});
