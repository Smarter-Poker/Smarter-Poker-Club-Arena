import React from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), reportError: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn() } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.reportError }));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'bonus-test' } }),
}));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/' }) }));
vi.mock('../../src/components/daily-bonus/DailyBonusSheet', () => ({ default: () => null }));

import DailyBonusEntry from '../../src/components/daily-bonus/DailyBonusEntry';
import { useDailyBonus } from '../../src/components/daily-bonus/useDailyBonus';

describe('Daily Bonus status failure ownership', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.reportError.mockReset();
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(cleanup);

  it('reports the original RPC cause exactly once through the real service and entry', async () => {
    const cause = { message: 'Failed to fetch', code: '' };
    mocks.rpc.mockResolvedValue({ data: null, error: cause, status: 0, statusText: '' });
    render(<DailyBonusEntry />);
    await waitFor(() => expect(mocks.reportError).toHaveBeenCalledTimes(1));
    expect(mocks.reportError).toHaveBeenCalledWith(cause, 'DailyBonusEntry.getStatus', {
      rpc: 'fn_ca_daily_bonus_status',
      failureKind: 'rpc_error',
      httpStatus: 0,
      httpStatusText: '',
      payloadKind: 'null',
    });
  });

  it('keeps an empty successful HTTP response visible as a distinct contract failure', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null, status: 204, statusText: 'No Content' });
    render(<DailyBonusEntry />);
    await waitFor(() => expect(mocks.reportError).toHaveBeenCalledTimes(1));
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Daily Bonus Status Returned null' }),
      'DailyBonusEntry.getStatus',
      expect.objectContaining({
        failureKind: 'invalid_payload',
        httpStatus: 204,
        payloadKind: 'null',
      })
    );
  });

  it('does not report a real service failure after the entry request is retired', async () => {
    let reject!: (error: unknown) => void;
    mocks.rpc.mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      })
    );
    const view = render(<DailyBonusEntry />);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => reject(new TypeError('Failed to fetch')));
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it('reports a manual sheet failure once while showing only the friendly message', async () => {
    const cause = { message: 'Backend diagnostic', code: 'XX000' };
    mocks.rpc.mockResolvedValue({
      data: null,
      error: cause,
      status: 500,
      statusText: 'Internal Server Error',
    });
    const { result } = renderHook(() => useDailyBonus(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBe('Could Not Load Your Daily Bonus');
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      cause,
      'useDailyBonus.getStatus',
      expect.objectContaining({ failureKind: 'rpc_error', httpStatus: 500 })
    );
  });
});
