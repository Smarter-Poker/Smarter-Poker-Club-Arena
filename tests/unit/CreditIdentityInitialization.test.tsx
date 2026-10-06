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
  const { getIdentityDNAStatus } = await import('../../src/core/IdentityDNA');
  vi.mocked(getIdentityDNAStatus).mockReturnValue({
    loaded: true,
    authenticated: true,
    userId: 'a',
  } as any);
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

it('ADD01 corrected: first observed same-user refresh rejects a valid pending invoice read', async () => {
  let finish: any;
  m.invoices.push(new Promise((r) => (finish = r)));
  const read = credit.getAgentInvoices('a');
  await waitFor(() => expect(m.queries.some((q) => q.table === 'credit_invoices')).toBe(true));
  m.listeners.forEach((fn) => fn({ payload: { isAuthenticated: true, userId: 'a' } }));
  finish(empty());
  await expect(read).resolves.toEqual([]);
});
it('ADD01 protection: same initialized identity preserves pending reinstatement result', async () => {
  m.listeners.forEach((fn) => fn({ payload: { isAuthenticated: true, userId: 'a' } }));
  let finish: any;
  m.rpc.mockImplementation(() => new Promise((r) => (finish = r)));
  m.invoices.push(empty());
  const result = credit.reinstateAgent('a');
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  m.listeners.forEach((fn) => fn({ payload: { isAuthenticated: true, userId: 'a' } }));
  finish({ data: { success: true, club_id: 'a-club' }, error: null });
  await expect(result).resolves.toBe(true);
});

it('defers invoice reads until canonical identity initialization is complete', async () => {
  const { getIdentityDNAStatus } = await import('../../src/core/IdentityDNA');
  vi.mocked(getIdentityDNAStatus).mockReturnValue(null);
  await expect(credit.getAgentInvoices('a')).rejects.toThrow(/not initialized/);
  expect(m.queries).toHaveLength(0);
  expect(m.rpc).not.toHaveBeenCalled();
  // Actual replacement arrives during initialization, then canonical status completes.
  m.listeners.forEach((fn) => fn({ payload: { isAuthenticated: true, userId: 'b' } }));
  vi.mocked(getIdentityDNAStatus).mockReturnValue({
    loaded: true,
    authenticated: true,
    userId: 'b',
  } as any);
  let finish: any;
  m.invoices.push(new Promise((r) => (finish = r)));
  const read = credit.getAgentInvoices('b');
  await waitFor(() => expect(m.queries.some((q) => q.table === 'credit_invoices')).toBe(true));
  m.listeners.forEach((fn) => fn({ payload: { isAuthenticated: true, userId: 'c' } }));
  finish(empty());
  await expect(read).rejects.toThrow(/account changed/);
});
it('replacement before the first snapshot cannot be overwritten by bootstrap', async () => {
  const { getIdentityDNAStatus } = await import('../../src/core/IdentityDNA');
  vi.mocked(getIdentityDNAStatus).mockReturnValue({
    loaded: true,
    authenticated: true,
    userId: 'a',
  } as any);
  m.listeners.forEach((fn) => fn({ payload: { isAuthenticated: true, userId: 'b' } }));
  let finish: any;
  m.invoices.push(new Promise((r) => (finish = r)));
  const read = credit.getAgentInvoices('b');
  await waitFor(() => expect(m.queries.some((q) => q.table === 'credit_invoices')).toBe(true));
  m.listeners.forEach((fn) => fn({ payload: { isAuthenticated: true, userId: 'b' } }));
  finish(empty());
  await expect(read).resolves.toEqual([]);
});
