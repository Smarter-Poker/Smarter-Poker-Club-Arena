import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
const m = vi.hoisted(() => ({
  send: vi.fn(),
  error: vi.fn(),
  owner: '10000000-0000-4000-8000-000000000001',
  agentBalance: 100,
  memberBalance: 456,
  memberError: false,
  filters: [] as unknown[],
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const q: any = {
        select: () => q,
        eq: (key: string, value: string) => {
          m.filters.push([table, key, value]);
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
                  club_id: '20000000-0000-4000-8000-000000000001',
                  agent_wallet_balance: m.agentBalance,
                  player_wallet_balance: 999999,
                  credit_limit: 0,
                },
                error: null,
              }
            : {
                data: m.memberError ? null : { chip_balance: m.memberBalance },
                error: m.memberError ? new Error('denied') : null,
              },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
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
  useToast: () => ({ error: m.error, success: vi.fn() }),
}));
vi.mock('../../src/components/charts/FinancialChart', () => ({ FinancialChart: () => null }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribeDebounced: () => () => undefined,
    removeRegisteredChannel: vi.fn(),
    getOrCreateChannel: () => {
      const c: any = { on: () => c, subscribe: () => c };
      return c;
    },
  },
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (selector: any) =>
    selector({ currentClubId: '20000000-0000-4000-8000-000000000001' }),
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
