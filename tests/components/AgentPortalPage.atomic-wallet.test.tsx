import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
const m = vi.hoisted(() => ({
  send: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  clubId: '20000000-0000-4000-8000-000000000001',
  readMember: vi.fn(),
  readCommissions: vi.fn(),
  balanceRefresh: () => undefined as unknown,
  commissionRefresh: undefined as undefined | (() => unknown),
  owner: '10000000-0000-4000-8000-000000000001',
  agentBalance: 100,
  memberBalance: 456,
  memberError: false,
  filters: [] as unknown[],
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const filters: Record<string, string> = {};
      const q: any = {
        select: () => q,
        eq: (key: string, value: string) => {
          m.filters.push([table, key, value]);
          filters[key] = value;
          return q;
        },
        gte: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () =>
          table === 'agents'
            ? {
                data: {
                  id: '30000000-0000-4000-8000-000000000001',
                  user_id: m.owner,
                  club_id: filters.club_id || m.clubId,
                  agent_wallet_balance: m.agentBalance,
                  player_wallet_balance: 999999,
                  credit_limit: 0,
                },
                error: null,
              }
            : m.readMember(filters),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(m.readCommissions(filters)).then(resolve),
      };
      return q;
    },
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: '10000000-0000-4000-8000-000000000001' } }),
}));
vi.mock('../../src/services/WalletService', () => ({
  WalletService: { agentSelfTransfer: m.send },
}));
vi.mock('../../src/services/CreditService', () => ({
  CreditService: { calculateDebt: async () => ({ debtOwed: 0 }) },
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ error: m.error, success: m.success }),
}));
vi.mock('../../src/components/charts/FinancialChart', () => ({ FinancialChart: () => null }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribeDebounced: (event: string, callback: () => unknown) => {
      if (event === 'BALANCE_UPDATED') m.balanceRefresh = callback;
      return () => undefined;
    },
    removeRegisteredChannel: vi.fn(),
    getOrCreateChannel: () => {
      const c: any = {
        on: (_event: string, filter: { table: string }, callback: () => unknown) => {
          if (filter.table === 'agent_commissions') m.commissionRefresh = callback;
          return c;
        },
        subscribe: () => c,
      };
      return c;
    },
  },
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (selector: any) => selector({ currentClubId: m.clubId }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/components/common/TransactionLedgerView', () => ({ default: () => null }));
vi.mock('../../src/components/agent/AgentInvoicesPanel', () => ({ default: () => null }));
import AgentPortalPage from '../../src/pages/AgentPortalPage';
const mount = () =>
  render(
    <MemoryRouter>
      <AgentPortalPage />
    </MemoryRouter>
  );
beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  m.owner = '10000000-0000-4000-8000-000000000001';
  m.memberBalance = 456;
  m.agentBalance = 100;
  m.memberError = false;
  m.filters = [];
  m.commissionRefresh = undefined;
  m.clubId = '20000000-0000-4000-8000-000000000001';
  m.readMember.mockReset().mockImplementation(() => ({
    data: m.memberError ? null : { chip_balance: m.memberBalance },
    error: m.memberError ? new Error('denied') : null,
  }));
  m.readCommissions.mockReset().mockReturnValue({ data: [], error: null });
  vi.stubGlobal('prompt', vi.fn().mockReturnValue('5'));
});

describe('routable agent wallet', () => {
  it('uses the selected club and the canonical member balance', async () => {
    m.send.mockResolvedValue(true);
    mount();
    await screen.findByText('456');
    expect(m.filters).toContainEqual(['agents', 'club_id', '20000000-0000-4000-8000-000000000001']);
    expect(screen.queryByText('999,999')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /LOAD FROM BIZ/ }));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    await waitFor(() =>
      expect(m.send).toHaveBeenCalledWith('20000000-0000-4000-8000-000000000001', 5)
    );
  });
  it('lets the server replay an intent even when the displayed balance was already debited', async () => {
    m.agentBalance = 0;
    m.send.mockResolvedValue(true);
    mount();
    await screen.findByText('456');
    fireEvent.click(screen.getByRole('button', { name: /LOAD FROM BIZ/ }));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    await waitFor(() => expect(m.send).toHaveBeenCalledTimes(1));
  });
  it('shows an unavailable canonical wallet instead of enabling a legacy transfer', async () => {
    m.memberError = true;
    mount();
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: /LOAD FROM BIZ/ })).toBeDisabled();
    expect(m.send).not.toHaveBeenCalled();
  });
});

const clubA = '20000000-0000-4000-8000-000000000001';
const clubB = '20000000-0000-4000-8000-000000000002';
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const memberResult = (chip_balance: number) => ({ data: { chip_balance }, error: null });
const commissionResult = (amount: number) => ({
  data: [{ amount, created_at: new Date().toISOString() }],
  error: null,
});

describe('agent page response ordering', () => {
  it('keeps club B selected when a transfer started in club A finishes late', async () => {
    const transfer = deferred<boolean>();
    m.send.mockReturnValueOnce(transfer.promise).mockResolvedValue(true);
    m.readMember.mockImplementation((filters) =>
      memberResult(filters.club_id === clubB ? 789 : 456)
    );
    const view = mount();
    await screen.findByText('456');
    fireEvent.click(screen.getByRole('button', { name: /LOAD FROM BIZ/ }));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    await waitFor(() => expect(m.send).toHaveBeenCalledWith(clubA, 5));

    m.clubId = clubB;
    view.rerender(
      <MemoryRouter>
        <AgentPortalPage />
      </MemoryRouter>
    );
    await screen.findByText('789');
    await act(async () => {
      transfer.resolve(true);
    });
    expect(screen.getByText('789')).toBeInTheDocument();
    expect(screen.queryByText('456')).toBeNull();
    expect(m.success).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /LOAD FROM BIZ/ }));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    await waitFor(() => expect(m.send).toHaveBeenLastCalledWith(clubB, 6));
  });

  it('keeps the latest balance when an older read in the same club finishes later', async () => {
    mount();
    await screen.findByText('456');
    const older = deferred<ReturnType<typeof memberResult>>();
    m.readMember.mockReturnValueOnce(older.promise).mockReturnValueOnce(memberResult(900));
    const calls = m.readMember.mock.calls.length;
    act(() => {
      m.balanceRefresh();
    });
    await waitFor(() => expect(m.readMember).toHaveBeenCalledTimes(calls + 1));
    act(() => {
      m.balanceRefresh();
    });
    await screen.findByText('900');
    await act(async () => {
      older.resolve(memberResult(600));
    });
    expect(screen.getByText('900')).toBeInTheDocument();
    expect(screen.queryByText('600')).toBeNull();
  });

  it('filters commissions by club and ignores a prior club response', async () => {
    m.readCommissions.mockReturnValue(commissionResult(31));
    const view = mount();
    await screen.findByText('Total: 31 Chips');
    // The initial read can render before the realtime effect registers. Never
    // dispatch through an unmounted prior test's callback or a pending channel.
    await waitFor(() => expect(m.commissionRefresh).toBeTypeOf('function'));
    const older = deferred<ReturnType<typeof commissionResult>>();
    m.readCommissions.mockReturnValueOnce(older.promise).mockReturnValue(commissionResult(37));
    const calls = m.readCommissions.mock.calls.length;
    act(() => {
      m.commissionRefresh!();
    });
    await waitFor(() => expect(m.readCommissions).toHaveBeenCalledTimes(calls + 1));
    m.clubId = clubB;
    view.rerender(
      <MemoryRouter>
        <AgentPortalPage />
      </MemoryRouter>
    );
    await screen.findByText('Total: 37 Chips');
    expect(m.readCommissions).toHaveBeenLastCalledWith(
      expect.objectContaining({ club_id: clubB, user_id: m.owner })
    );
    await act(async () => {
      older.resolve(commissionResult(99));
    });
    expect(screen.getByText('Total: 37 Chips')).toBeInTheDocument();
    expect(screen.queryByText('Total: 99 Chips')).toBeNull();
  });

  it('keeps the newest commission read within the same club', async () => {
    m.readCommissions.mockReturnValue(commissionResult(31));
    mount();
    await screen.findByText('Total: 31 Chips');
    await waitFor(() => expect(m.commissionRefresh).toBeTypeOf('function'));
    const older = deferred<ReturnType<typeof commissionResult>>();
    m.readCommissions.mockReturnValueOnce(older.promise).mockReturnValueOnce(commissionResult(37));
    const calls = m.readCommissions.mock.calls.length;
    act(() => {
      m.commissionRefresh!();
    });
    await waitFor(() => expect(m.readCommissions).toHaveBeenCalledTimes(calls + 1));
    act(() => {
      m.commissionRefresh!();
    });
    await screen.findByText('Total: 37 Chips');
    await act(async () => {
      older.resolve(commissionResult(99));
    });
    expect(screen.getByText('Total: 37 Chips')).toBeInTheDocument();
  });
});
