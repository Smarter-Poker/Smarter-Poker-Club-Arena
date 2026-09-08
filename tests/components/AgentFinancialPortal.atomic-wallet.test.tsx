import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
const m = vi.hoisted(() => ({
  send: vi.fn(),
  error: vi.fn(),
  owner: '10000000-0000-4000-8000-000000000001',
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
                  agent_wallet_balance: 100,
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
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => ({ error: m.error }) }));
vi.mock('../../src/components/charts/FinancialChart', () => ({ FinancialChart: () => null }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { subscribeDebounced: () => () => undefined },
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
