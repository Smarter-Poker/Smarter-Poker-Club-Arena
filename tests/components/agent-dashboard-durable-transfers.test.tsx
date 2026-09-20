import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { webcrypto } from 'node:crypto';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), emit: vi.fn() }));
const ids = vi.hoisted(() => ({
  actor: '10000000-0000-4000-8000-000000000001',
  club: '20000000-0000-4000-8000-000000000001',
  agent: '30000000-0000-4000-8000-000000000001',
  transaction: '40000000-0000-4000-8000-000000000001',
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: ids.actor } }),
}));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/resolvePageClubId', () => ({
  resolvePageClubId: async () => ids.club,
  pickPreferredClubId: () => ids.club,
}));
vi.mock('../../src/utils/retryFetch', () => ({ retryFetch: (fn: () => unknown) => fn() }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../src/services/WalletService', () => ({ WalletService: {} }));
vi.mock('../../src/services/CreditService', () => ({
  CreditService: { setCreditLine: vi.fn(), lowerCreditLine: vi.fn() },
}));
vi.mock('../../src/services/CashoutService', () => ({
  cashoutService: {},
  newOpId: vi.fn(),
  captureCashoutAccountGuard: () => () => true,
}));
vi.mock('../../src/components/common/TransactionLedgerView', () => ({ default: () => null }));
vi.mock('../../src/components/agent/AgentScoreCard', () => ({ default: () => null }));
vi.mock('../../src/components/agent/AgentBackOffice', () => ({ default: () => null }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: () => () => {},
    emit: mocks.emit,
    subscribeDebounced: () => () => {},
    removeRegisteredChannel: vi.fn(),
    getOrCreateChannel: () => {
      const channel = { on: () => channel, subscribe: vi.fn() };
      return channel;
    },
  },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mocks.rpc(...args),
    from: (table: string) => {
      let selection = '';
      const query: Record<string, unknown> = {};
      for (const method of ['eq', 'in', 'order', 'limit', 'or']) query[method] = () => query;
      query.select = (value: string) => {
        selection = value;
        return query;
      };
      query.maybeSingle = () => Promise.resolve({ data: { role: 'owner' }, error: null });
      query.then = (resolve: (value: unknown) => unknown) =>
        resolve({
          data:
            table === 'club_members' && selection.includes('user_id')
              ? [
                  {
                    user_id: ids.agent,
                    role: 'agent',
                    chip_balance: 10,
                    status: 'active',
                    created_at: '2026-09-10',
                    agent_id: ids.actor,
                  },
                ]
              : table === 'profiles'
                ? [{ id: ids.agent, display_name: 'Agent One' }]
                : [],
          error: null,
        });
      return query;
    },
  },
}));

import AgentDashboardPage from '../../src/pages/AgentDashboardPage';

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.emit.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  const locks = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (key: string, _options: unknown, fn: () => unknown) => {
        const next = (locks.get(key) || Promise.resolve()).then(fn);
        locks.set(
          key,
          next.catch(() => undefined)
        );
        return next;
      },
    },
  });
});

const receipt = (args: Record<string, unknown>) => ({
  success: true,
  transaction_id: ids.transaction,
  amount: args.p_amount,
  destination: args.p_destination,
  agent_wallet_after: 50,
  recipient_balance_after: 25,
});
const mount = () =>
  render(
    <MemoryRouter initialEntries={[`/?club=${ids.club}`]}>
      <AgentDashboardPage />
    </MemoryRouter>
  );

describe.each(['transfer', 'prepaid'])('dashboard %s retry', (flow) => {
  async function fill() {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Transfer' })).toBeTruthy());
    if (flow === 'transfer') {
      fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
      fireEvent.change(screen.getByPlaceholderText('UUID Of Receiving Agent'), {
        target: { value: ids.agent },
      });
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Credit' }));
      const selectors = screen.getAllByRole('combobox');
      fireEvent.change(selectors[0], { target: { value: ids.agent } });
      fireEvent.change(selectors[1], { target: { value: 'add_prepaid' } });
    }
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '25' } });
  }
  const submitButton = () =>
    screen.getByRole('button', {
      name: flow === 'transfer' ? /Transfer 25/ : 'Send Prepaid Chips',
    });

  it('survives a deferred unknown response and remount with exactly the original key', async () => {
    let rejectSend!: (error: Error) => void;
    mocks.rpc.mockImplementation((_name: string, args: Record<string, unknown>) => {
      if (mocks.rpc.mock.calls.length === 1)
        return new Promise((_resolve, reject) => {
          rejectSend = reject;
        });
      return Promise.resolve({ data: { ...receipt(args), replayed: true }, error: null });
    });
    const first = mount();
    await fill();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledOnce());
    expect(mocks.rpc.mock.calls[0][1].p_destination).toBe('agent_wallet');
    const original = mocks.rpc.mock.calls[0][1].p_op_id;
    first.unmount();
    await act(async () => {
      rejectSend(new Error('Response Lost'));
    });
    expect(mocks.emit).not.toHaveBeenCalled();
    mount();
    await fill();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    expect(mocks.rpc.mock.calls[1][1].p_op_id).toBe(original);
    await waitFor(() => expect(mocks.emit).toHaveBeenCalledOnce());
  });

  it('keeps the key after malformed success and sends once for a same-frame double click', async () => {
    mocks.rpc.mockResolvedValue({ data: { success: true }, error: null });
    mount();
    await fill();
    act(() => {
      fireEvent.click(submitButton());
      fireEvent.click(submitButton());
    });
    await waitFor(() => expect(screen.getByText(/The Cashier Did Not Confirm/)).toBeTruthy());
    expect(mocks.rpc).toHaveBeenCalledOnce();
    const original = mocks.rpc.mock.calls[0][1].p_op_id;
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    expect(mocks.rpc.mock.calls[1][1].p_op_id).toBe(original);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
