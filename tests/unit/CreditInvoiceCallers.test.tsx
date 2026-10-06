import { beforeEach, afterEach, it, expect, vi } from 'vitest';

// Canonical identity already exists before deferred service import; no synthetic bus seed.
vi.mock('../../src/core/IdentityDNA', () => ({
  getIdentityDNAStatus: vi.fn(() => ({ loaded: true, authenticated: true, userId: 'a' })),
}));
const m = vi.hoisted(() => ({
  invoices: [] as any[],
  listeners: [] as any[],
  rpc: vi.fn(),
  warning: vi.fn(),
  queries: [] as any[],
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: m.rpc,
    from: (table: string) => {
      const filters: any[] = [];
      const c: any = {};
      for (const op of ['select', 'eq', 'order', 'limit', 'gt'])
        c[op] = (...args: any[]) => {
          filters.push([op, ...args]);
          return c;
        };
      c.maybeSingle = async () => ({ data: null, error: null });
      c.then = (yes: any, no: any) => {
        m.queries.push({ table, filters });
        const value = (table === 'credit_invoices' ? m.invoices : []).shift() ?? {
          data: [],
          error: null,
        };
        return (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)).then(
          yes,
          no
        );
      };
      return c;
    },
  },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: (_n: any, fn: any) => {
      m.listeners.push(fn);
      return () => {};
    },
  },
}));
vi.mock('../../src/services/WalletService', () => ({ WalletService: {} }));
vi.mock('../../src/services/SettlementService', () => ({
  SettlementService: {},
}));
vi.mock('../../src/services/FinancialAlertService', () => ({
  FinancialAlertService: { logWarning: m.warning },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: vi.fn() }));
let credit: any;
beforeEach(async () => {
  vi.resetModules();
  m.invoices = [];
  m.listeners = [];
  m.queries = [];
  m.rpc.mockReset().mockResolvedValue({ data: { success: true }, error: null });
  m.warning.mockReset().mockResolvedValue(undefined);
  credit = (await import('../../src/services/CreditService')).CreditService;
});
afterEach(() => {
  vi.useRealTimers();
});
const empty = () => ({ data: [], error: null });
const owed = (status = 'overdue') => {
  const settled = status === 'paid' || status === 'void';
  const partial = status === 'partial';
  return {
    data: [
      {
        id: 'i',
        agent_id: 'a',
        period_start: '2019-12-22T00:00:00.000Z',
        period_end: '2019-12-29T00:00:00.000Z',
        debt_owed: 10,
        amount_paid: status === 'paid' ? 10 : partial ? 5 : 0,
        amount_remaining: settled ? 0 : partial ? 5 : 10,
        status,
        due_date: '2020-01-01T00:00:00.000Z',
        created_at: '2019-12-29T00:00:00.000Z',
        paid_at: status === 'paid' ? '2019-12-30T00:00:00.000Z' : null,
      },
    ],
    error: null,
  };
};
const switchAccount = () =>
  m.listeners.forEach((fn) => fn({ payload: { isAuthenticated: true, userId: 'b' } }));

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'a' } }) }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: () => {} }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
afterEach(() => cleanup());

it('0067 corrected: actual mounted invoice panel shows unavailable then successful empty on retry', async () => {
  m.invoices.push({ data: null, error: new Error('unavailable') });
  const Panel = (await import('../../src/components/agent/AgentInvoicesPanel')).default;
  render(<Panel agentId="a" />);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/unavailable/i));
  expect(screen.queryByText(/No Invoices. Weekly/)).toBeNull();
  m.invoices.push(empty());
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  await waitFor(() => expect(screen.getByText(/No Invoices. Weekly/)).toBeDefined());
});
it('0067 corrected: actual panel clears previous agent invoice after replacement agent read fails', async () => {
  m.invoices.push(owed());
  const Panel = (await import('../../src/components/agent/AgentInvoicesPanel')).default;
  const view = render(<Panel agentId="a" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Pay Now' })).toBeDefined());
  m.invoices.push({ data: null, error: new Error('new account unavailable') });
  view.rerender(<Panel agentId="b" />);
  await waitFor(() => expect(screen.queryByText('Loading Invoices...')).toBeNull());
  expect(screen.queryByRole('button', { name: 'Pay Now' })).toBeNull();
  expect(screen.getByRole('alert').textContent).toMatch(/unavailable/i);
});
it('0067 corrected: financial health never starts an unscoped browser scan', async () => {
  const Page = (await import('../../src/pages/FinancialHealthPage')).default;
  render(<Page />);
  const section = screen.getByText('Credit Enforcement').closest('section')!;
  expect(section.textContent).toMatch(/global browser scan/i);
  expect(section.textContent).toMatch(/unavailable/i);
  expect(screen.queryByRole('button', { name: /run now/i })).toBeNull();
  expect(m.queries.some((query) => query.table === 'agents')).toBe(false);
});
it('0067 corrected: reinstatement suppresses publication after auth scope changes during RPC', async () => {
  const bus = (await import('../../src/core/MasterBus')).masterBus as any;
  let finish: any;
  m.rpc.mockImplementation(() => new Promise((r) => (finish = r)));
  m.invoices.push(empty());
  const result = credit.reinstateAgent('a');
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  switchAccount();
  finish({ data: { success: true, club_id: 'old-club' }, error: null });
  await expect(result).rejects.toThrow(/may have committed/);
  expect(bus.emit).not.toHaveBeenCalledWith('CREDIT_UPDATED', { clubId: 'old-club' });
});
it('late agent A response cannot replace successful B rows', async () => {
  let finish: any;
  m.invoices.push(new Promise((r) => (finish = r)));
  const Panel = (await import('../../src/components/agent/AgentInvoicesPanel')).default;
  const view = render(<Panel agentId="a" />);
  await waitFor(() => expect(m.queries.some((q) => q.table === 'credit_invoices')).toBe(true));
  m.invoices.push(empty());
  view.rerender(<Panel agentId="b" />);
  await waitFor(() => expect(screen.getByText(/No Invoices. Weekly/)).toBeDefined());
  finish(owed());
  await new Promise((r) => setTimeout(r, 10));
  expect(screen.queryByRole('button', { name: 'Pay Now' })).toBeNull();
});
it('pending payment cannot publish or reload after agent replacement', async () => {
  const bus = (await import('../../src/core/MasterBus')).masterBus as any;
  let finish: any;
  const pay = vi
    .spyOn(credit, 'processPayment')
    .mockImplementation(() => new Promise((r) => (finish = r)));
  m.invoices.push(owed());
  const Panel = (await import('../../src/components/agent/AgentInvoicesPanel')).default;
  const view = render(<Panel agentId="a" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Pay Now' })).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: 'Pay Now' }));
  expect(pay).toHaveBeenCalledTimes(1);
  m.invoices.push(empty());
  view.rerender(<Panel agentId="b" />);
  await waitFor(() => expect(screen.getByText(/No Invoices. Weekly/)).toBeDefined());
  finish(true);
  await new Promise((r) => setTimeout(r, 10));
  expect(bus.emit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.anything());
  expect(m.queries.filter((q) => q.table === 'credit_invoices')).toHaveLength(2);
});
it('an uncertain payment retry retains the same operation identity', async () => {
  const pay = vi
    .spyOn(credit, 'processPayment')
    .mockRejectedValue(new Error('Payment status uncertain'));
  m.invoices.push(owed());
  const Panel = (await import('../../src/components/agent/AgentInvoicesPanel')).default;
  render(<Panel agentId="a" />);
  const button = await screen.findByRole('button', { name: 'Pay Now' });
  fireEvent.click(button);
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(pay).toHaveBeenCalledTimes(2));
  expect(pay.mock.calls[0][3]).toEqual(pay.mock.calls[1][3]);
  expect(pay.mock.calls[0][3].operationId).toMatch(/^[a-f0-9-]{36}$/);
});
it('same identity refresh preserves pending debt read; signout fences it', async () => {
  const auth = (id: string | null) =>
    m.listeners.forEach((fn) => fn({ payload: { isAuthenticated: !!id, userId: id } }));
  auth('a');
  let finish: any;
  m.invoices.push(new Promise((r) => (finish = r)));
  const read = credit.getAgentInvoices('a');
  await Promise.resolve();
  auth('a');
  finish(empty());
  await expect(read).resolves.toEqual([]);
  m.invoices.push(new Promise((r) => (finish = r)));
  const stale = credit.getAgentInvoices('a');
  await Promise.resolve();
  auth(null);
  finish(empty());
  await expect(stale).rejects.toThrow(/account changed/);
});
