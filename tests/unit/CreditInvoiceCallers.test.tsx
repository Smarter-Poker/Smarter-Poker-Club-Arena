import { beforeEach, afterEach, it, expect, vi } from 'vitest';

// Canonical identity already exists before deferred service import; no synthetic bus seed.
vi.mock('../../src/core/IdentityDNA', () => ({
  getIdentityDNAStatus: vi.fn(() => ({ loaded: true, authenticated: true, userId: 'a' })),
}));
const m = vi.hoisted(() => ({
  invoices: [] as any[],
  scans: [] as any[],
  listeners: [] as any[],
  rpc: vi.fn(),
  warning: vi.fn(),
  queries: [] as any[],
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: m.rpc,
    from: (table: string) => {
      let scan = false;
      const filters: any[] = [];
      const c: any = {};
      for (const op of ['select', 'eq', 'order', 'limit', 'gt'])
        c[op] = (...args: any[]) => {
          filters.push([op, ...args]);
          if (op === 'gt') scan = true;
          return c;
        };
      c.maybeSingle = async () => ({ data: null, error: null });
      c.then = (yes: any, no: any) => {
        m.queries.push({ table, filters });
        const value = (table === 'credit_invoices' ? m.invoices : scan ? m.scans : []).shift() ?? {
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
let credit: any, cron: any;
beforeEach(async () => {
  vi.resetModules();
  m.invoices = [];
  m.scans = [];
  m.listeners = [];
  m.queries = [];
  m.rpc.mockReset().mockResolvedValue({ data: { success: true }, error: null });
  m.warning.mockReset().mockResolvedValue(undefined);
  credit = (await import('../../src/services/CreditService')).CreditService;
  cron = (await import('../../src/services/FinancialCronService')).FinancialCronService;
});
afterEach(() => {
  cron.stop();
  vi.useRealTimers();
});
const empty = () => ({ data: [], error: null });
const owed = (status = 'overdue') => ({
  data: [
    {
      id: 'i',
      agent_id: 'a',
      status,
      due_date: '2020-01-01',
      amount_remaining: 10,
    },
  ],
  error: null,
});
const agents = (n = 1) => ({
  data: Array.from({ length: n }, (_, i) => ({
    id: 'a' + i,
    status: 'active',
  })),
  error: null,
});
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
it('0067 corrected: failed full scan replaces previous clean last result', async () => {
  m.scans.push(empty());
  const clean = await cron.runSuspensionCheck();
  m.scans.push({ data: null, error: new Error('unavailable') });
  expect((await cron.runSuspensionCheck()).unavailable).toBe(true);
  expect(cron.getStatus().lastSuspensionCheck).not.toBe(clean);
  expect(cron.getStatus().lastSuspensionCheck.unavailable).toBe(true);
});
it('0067 corrected: actual mounted financial health page labels partial unavailable scan counts', async () => {
  const bus = (await import('../../src/core/MasterBus')).masterBus as any;
  bus.subscribeDebounced = () => () => {};
  m.scans.push(agents());
  m.invoices.push({ data: null, error: new Error('unavailable') });
  const Page = (await import('../../src/pages/FinancialHealthPage')).default;
  render(<Page />);
  const section = screen.getByText('Credit Suspension Check').closest('section')!;
  fireEvent.click(section.querySelector('button')!);
  await waitFor(() => expect(section.textContent).toContain('Agents Checked'));
  expect(section.textContent).toMatch(/unavailable|incomplete/i);
  expect(cron.getStatus().lastSuspensionCheck.unavailable).toBe(true);
});
it('0067 corrected: same-account token-refresh preserves a disabled circuit', async () => {
  m.listeners.forEach((fn) => fn({ payload: { isAuthenticated: true, userId: 'a' } }));
  m.scans.push(new Error('1'), new Error('2'));
  await cron.runSuspensionCheck();
  await cron.runSuspensionCheck();
  expect(cron._suspensionCheckDisabled).toBe(true);
  // IdentityDNA TOKEN_REFRESHED publishes this identical identity event.
  m.listeners.forEach((fn) => fn({ payload: { isAuthenticated: true, userId: 'a' } }));
  expect(cron._suspensionCheckDisabled).toBe(true);
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
it('0067 protection: successful whole agent attempt resets consecutive per-agent failures', async () => {
  m.scans.push(agents(5));
  m.invoices.push(new Error('1'), new Error('2'), empty(), new Error('3'), new Error('4'));
  const result = await cron.runSuspensionCheck();
  expect(result.agentsChecked).toBe(5);
  expect(result.unavailable).toBe(true);
  expect(cron._suspensionCheckDisabled).toBe(false);
});
it('0067 protection: auto-suspend enabled still requires genuinely owed invoice eligibility', async () => {
  cron._config.autoSuspendEnabled = true;
  m.scans.push(agents(3));
  m.invoices.push(owed('void'), owed('paid'), owed('disputed'));
  const result = await cron.runSuspensionCheck();
  expect(result.agentsSuspended).toBe(0);
  expect(result.agentsWarned).toBe(0);
  expect(m.rpc.mock.calls.filter(([name]) => name === 'fn_admin_update_agent')).toHaveLength(0);
  expect(
    m.queries
      .filter((q) => q.table === 'credit_invoices')
      .map((q) => q.filters.find((f: any) => f[0] === 'eq'))
  ).toEqual([
    ['eq', 'agent_id', 'a0'],
    ['eq', 'agent_id', 'a1'],
    ['eq', 'agent_id', 'a2'],
  ]);
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
it('disabled attempts publish fresh unavailable results without generating invoices', async () => {
  m.scans.push(new Error('1'), new Error('2'));
  await cron.runSuspensionCheck();
  await cron.runSuspensionCheck();
  const previous = cron.getStatus().lastSuspensionCheck;
  const calls = m.rpc.mock.calls.length;
  const next = await cron.runSuspensionCheck();
  expect(next).not.toBe(previous);
  expect(next.unavailable).toBe(true);
  expect(cron.getStatus().lastSuspensionCheck).toBe(next);
  expect(m.rpc).toHaveBeenCalledTimes(calls);
});
it('scheduled status snapshot renders unknown and partial counts', async () => {
  const bus = (await import('../../src/core/MasterBus')).masterBus as any;
  let refresh: any;
  bus.subscribeDebounced = (_name: any, fn: any) => {
    refresh = fn;
    return () => {};
  };
  const Page = (await import('../../src/pages/FinancialHealthPage')).default;
  render(<Page />);
  m.scans.push(agents(2));
  m.invoices.push(empty(), new Error('unknown'));
  await cron.runSuspensionCheck();
  const { act } = await import('@testing-library/react');
  act(() => refresh());
  expect(screen.getByRole('alert').textContent).toMatch(/partial/i);
  expect(screen.getByText('Agents Checked').previousElementSibling?.textContent).toBe('2');
});
