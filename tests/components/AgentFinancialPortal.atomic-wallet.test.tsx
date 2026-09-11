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
  commissionRefresh: () => undefined as unknown,
  owner: '10000000-0000-4000-8000-000000000001',
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
                  club_id:
                    filters.id === '30000000-0000-4000-8000-000000000002'
                      ? '20000000-0000-4000-8000-000000000002'
                      : '20000000-0000-4000-8000-000000000001',
                  agent_wallet_balance: 100,
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
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => ({ error: m.error }) }));
vi.mock('../../src/components/charts/FinancialChart', () => ({
  FinancialChart: ({ data }: { data: Array<{ commissions: number }> }) => (
    <div data-testid="commissions">{data.reduce((total, day) => total + day.commissions, 0)}</div>
  ),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribeDebounced: (event: string, callback: () => unknown) => {
      if (event === 'BALANCE_UPDATED') m.balanceRefresh = callback;
      if (event === 'COMMISSION_PAID') m.commissionRefresh = callback;
      return () => undefined;
    },
  },
}));
import { AgentFinancialPortal } from '../../src/components/dashboard/AgentFinancialPortal';
const mount = () =>
  render(
    <MemoryRouter>
      <AgentFinancialPortal agentId="30000000-0000-4000-8000-000000000001" />
    </MemoryRouter>
  );
beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  m.owner = '10000000-0000-4000-8000-000000000001';
  m.memberBalance = 456;
  m.memberError = false;
  m.filters = [];
  m.clubId = '20000000-0000-4000-8000-000000000001';
  m.readMember.mockReset().mockImplementation(() => ({
    data: m.memberError ? null : { chip_balance: m.memberBalance },
    error: m.memberError ? new Error('denied') : null,
  }));
  m.readCommissions.mockReset().mockReturnValue({ data: [], error: null });
  vi.stubGlobal('prompt', vi.fn().mockReturnValue('5'));
});
describe('agent portal canonical wallet wiring', () => {
  it('renders the club player balance and sends the club UUID, never the agent PK', async () => {
    m.send.mockResolvedValue(true);
    mount();
    await screen.findByText('456');
    expect(screen.queryByText('999,999')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /LOAD FROM BIZ/ }));
    await waitFor(() =>
      expect(m.send).toHaveBeenCalledWith('20000000-0000-4000-8000-000000000001', 5)
    );
    expect(m.filters).toContainEqual(['club_members', 'user_id', m.owner]);
    expect(m.filters).toContainEqual([
      'club_members',
      'club_id',
      '20000000-0000-4000-8000-000000000001',
    ]);
  });
  it('cannot submit the same in-flight gesture twice', async () => {
    let done!: (value: boolean) => void;
    m.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          done = resolve;
        })
    );
    mount();
    await screen.findByText('456');
    const button = screen.getByRole('button', { name: /LOAD FROM BIZ/ });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(m.send).toHaveBeenCalledTimes(1);
    done(true);
    await waitFor(() => expect(button).not.toBeDisabled());
  });
  it('does not offer self-stake from another agent display', async () => {
    m.owner = '50000000-0000-4000-8000-000000000001';
    mount();
    await screen.findByText('456');
    const button = screen.getByRole('button', { name: /LOAD FROM BIZ/ });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(m.send).not.toHaveBeenCalled();
  });
  it('does not use the legacy player column if the actual wallet lookup fails', async () => {
    m.memberError = true;
    mount();
    await waitFor(() => expect(m.filters).toContainEqual(['club_members', 'user_id', m.owner]));
    expect(screen.queryByText('999,999')).toBeNull();
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

describe('embedded agent portal response ordering', () => {
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

  it('filters commissions by club and ignores a prior agent response', async () => {
    m.readCommissions.mockReturnValue(commissionResult(31));
    const view = mount();
    await waitFor(() => expect(screen.getByTestId('commissions')).toHaveTextContent('31'));
    const older = deferred<ReturnType<typeof commissionResult>>();
    m.readCommissions.mockReturnValueOnce(older.promise).mockReturnValue(commissionResult(37));
    const calls = m.readCommissions.mock.calls.length;
    act(() => {
      m.commissionRefresh();
    });
    await waitFor(() => expect(m.readCommissions).toHaveBeenCalledTimes(calls + 1));
    view.rerender(
      <MemoryRouter>
        <AgentFinancialPortal agentId="30000000-0000-4000-8000-000000000002" />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByTestId('commissions')).toHaveTextContent('37'));
    expect(m.readCommissions).toHaveBeenLastCalledWith(
      expect.objectContaining({ club_id: clubB, user_id: m.owner })
    );
    await act(async () => {
      older.resolve(commissionResult(99));
    });
    expect(screen.getByTestId('commissions')).toHaveTextContent('37');
  });

  it('keeps the newest commission read within the same club', async () => {
    m.readCommissions.mockReturnValue(commissionResult(31));
    mount();
    await waitFor(() => expect(screen.getByTestId('commissions')).toHaveTextContent('31'));
    const older = deferred<ReturnType<typeof commissionResult>>();
    m.readCommissions.mockReturnValueOnce(older.promise).mockReturnValueOnce(commissionResult(37));
    const calls = m.readCommissions.mock.calls.length;
    act(() => {
      m.commissionRefresh();
    });
    await waitFor(() => expect(m.readCommissions).toHaveBeenCalledTimes(calls + 1));
    act(() => {
      m.commissionRefresh();
    });
    await waitFor(() => expect(screen.getByTestId('commissions')).toHaveTextContent('37'));
    await act(async () => {
      older.resolve(commissionResult(99));
    });
    expect(screen.getByTestId('commissions')).toHaveTextContent('37');
  });

  it('does not show an old agent transfer failure in a new agent view', async () => {
    const transfer = deferred<boolean>();
    m.send.mockReturnValue(transfer.promise);
    m.readMember.mockImplementation((filters) =>
      memberResult(filters.club_id === clubB ? 789 : 456)
    );
    const view = mount();
    await screen.findByText('456');
    fireEvent.click(screen.getByRole('button', { name: /LOAD FROM BIZ/ }));
    expect(m.send).toHaveBeenCalledWith(clubA, 5);
    view.rerender(
      <MemoryRouter>
        <AgentFinancialPortal agentId="30000000-0000-4000-8000-000000000002" />
      </MemoryRouter>
    );
    await screen.findByText('789');
    await act(async () => {
      transfer.resolve(false);
    });
    expect(m.error).not.toHaveBeenCalled();
    expect(screen.getByText('789')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /LOAD FROM BIZ/ })).not.toBeDisabled();
  });
});
