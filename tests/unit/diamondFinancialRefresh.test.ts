import { renderHook, act } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  emit: vi.fn(),
  update: undefined as any,
  status: undefined as any,
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'hero' } }) }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mock.emit } }));
vi.mock('../../src/services/EngineStateClient', () => ({
  engineChannelClient: {
    onFinancialUpdate: (fn: any) => {
      mock.update = fn;
      return () => {};
    },
    onStatusChange: (fn: any) => {
      mock.status = fn;
      return () => {};
    },
  },
}));
import { useRealtimeFinancials } from '../../src/hooks/useRealtimeFinancials';
beforeEach(() => vi.clearAllMocks());
it('routes Diamond cash-out refresh without chip ledger or wallet events', () => {
  renderHook(() => useRealtimeFinancials());
  act(() =>
    mock.update({
      userId: 'hero',
      walletType: 'DIAMOND',
      available: 125,
      total: 125,
      ledgerEntry: { id: 'invalid-chip-entry' },
    })
  );
  expect(mock.emit.mock.calls).toEqual([
    [
      'DIAMOND_BALANCE_CHANGED',
      { newBalance: 125, delta: 0, source: 'engine_ws_financial_update' },
    ],
  ]);
});
it('does not accept fractional Diamond balances or another users payload', () => {
  renderHook(() => useRealtimeFinancials());
  act(() => mock.update({ userId: 'hero', walletType: 'DIAMOND', available: 1.5, total: 1.5 }));
  act(() => mock.update({ userId: 'other', walletType: 'DIAMOND', available: 100, total: 100 }));
  expect(mock.emit).not.toHaveBeenCalled();
});
