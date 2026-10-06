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
it.each(['returned', 'thrown', 'null'])(
  'unknown %s debt cannot reinstate and next read recovers',
  async (kind) => {
    m.invoices.push(
      kind === 'returned'
        ? { data: null, error: new Error('read failed') }
        : kind === 'thrown'
          ? new Error('network')
          : { data: null, error: null }
    );
    await expect(credit.reinstateAgent('a')).rejects.toBeDefined();
    expect(m.rpc).not.toHaveBeenCalled();
    m.invoices.push(empty());
    await expect(credit.reinstateAgent('a')).resolves.toBe(true);
  }
);
it('failure does not poison a different account', async () => {
  m.invoices.push(new Error('failed'));
  await credit.getAgentInvoices('a').catch(() => {});
  switchAccount();
  m.invoices.push(owed());
  expect((await credit.checkSuspension('b')).shouldSuspend).toBe(true);
});
it('pending old account cannot reinstate after switch', async () => {
  let resolve: any;
  m.invoices.push(new Promise((r) => (resolve = r)));
  const p = credit.reinstateAgent('a');
  await Promise.resolve();
  switchAccount();
  resolve(empty());
  await expect(p).rejects.toBeDefined();
  expect(m.rpc).not.toHaveBeenCalled();
});
it.each(['pending', 'partial', 'overdue', 'paid', 'void', 'disputed'])(
  'preserves owed status %s',
  async (status) => {
    m.invoices.push(owed(status));
    expect((await credit.checkSuspension('a')).shouldSuspend).toBe(
      ['pending', 'partial', 'overdue'].includes(status)
    );
  }
);
it('account switch between debt completion and reinstatement refuses status write', async () => {
  m.invoices.push(empty());
  const actual = credit.getAgentInvoices.bind(credit);
  vi.spyOn(credit, 'getAgentInvoices').mockImplementation(async (id: any) => {
    const value = await actual(id);
    switchAccount();
    return value;
  });
  await expect(credit.reinstateAgent('a')).rejects.toBeDefined();
  expect(m.rpc).not.toHaveBeenCalled();
});
