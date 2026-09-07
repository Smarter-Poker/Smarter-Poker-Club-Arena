import { beforeEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ emit: vi.fn(), warm: vi.fn() }));
vi.mock('../src/core/MasterBus', () => ({ masterBus: { emit: calls.emit } }));
vi.mock('../src/services/tableWarmup', () => ({ warmTable: calls.warm }));
import { openTableAsObserver, requestObserveTable } from '../src/utils/observeTable';
beforeEach(() => vi.clearAllMocks());
describe('observer entry preparation', () => {
  it('warms the actual table before the screen event and navigation', () => {
    const order: string[] = [];
    calls.warm.mockImplementation(() => order.push('warm'));
    calls.emit.mockImplementation(() => order.push('screen'));
    const navigate = vi.fn(() => order.push('navigate'));
    expect(openTableAsObserver(navigate, { tableId: 'actual-table' })).toBe(true);
    expect(order).toEqual(['warm', 'screen', 'navigate']);
    expect(calls.warm).toHaveBeenCalledWith('actual-table');
    expect(navigate).toHaveBeenCalledWith('/table/actual-table');
  });
  it('does not warm or navigate an absent table', () => {
    const navigate = vi.fn();
    expect(requestObserveTable({ tableId: '' })).toBe(false);
    expect(openTableAsObserver(navigate, { tableId: '' })).toBe(false);
    expect(calls.warm).not.toHaveBeenCalled();
    expect(calls.emit).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
