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
it.each(['returned', 'thrown'])(
  'scan %s failure is unavailable and success resets consecutive failures',
  async (kind) => {
    const failure = () =>
      kind === 'returned'
        ? { data: null, error: new Error('scan failed') }
        : new Error('scan failed');
    m.scans.push(failure(), empty(), failure());
    expect((await cron.runSuspensionCheck()).unavailable).toBe(true);
    await cron.runSuspensionCheck();
    expect((await cron.runSuspensionCheck()).unavailable).toBe(true);
    expect(cron._suspensionCheckDisabled).toBe(false);
  }
);
it('two consecutive global failures disable; explicit restart recovers and disabled run skips invoice generation', async () => {
  m.scans.push(new Error('1'), new Error('2'));
  await cron.runSuspensionCheck();
  await cron.runSuspensionCheck();
  expect(cron._suspensionCheckDisabled).toBe(true);
  m.rpc.mockClear();
  expect((await cron.runSuspensionCheck()).unavailable).toBe(true);
  expect(m.rpc).not.toHaveBeenCalled();
  vi.useFakeTimers();
  cron.start();
  m.scans.push(empty());
  expect((await cron.runSuspensionCheck()).unavailable).not.toBe(true);
  expect(cron._suspensionCheckDisabled).toBe(false);
});
it('failure after eligibility counts toward three consecutive agent failures', async () => {
  cron._config.autoSuspendEnabled = true;
  m.scans.push(agents(4));
  m.invoices.push(owed(), owed(), owed(), owed());
  m.rpc.mockImplementation(async (name: string) =>
    name === 'fn_admin_update_agent'
      ? { data: null, error: new Error('status failed') }
      : { data: { success: true }, error: null }
  );
  const result = await cron.runSuspensionCheck();
  expect(result.unavailable).toBe(true);
  expect(result.agentsChecked).toBe(3);
  expect(cron._suspensionCheckDisabled).toBe(true);
});
it('autoSuspend false only warns for genuinely owed invoices', async () => {
  m.scans.push(agents(2));
  m.invoices.push(owed(), owed('void'));
  const result = await cron.runSuspensionCheck();
  expect(result.agentsSuspended).toBe(0);
  expect(result.agentsWarned).toBe(1);
  expect(m.rpc.mock.calls.filter(([name]) => name === 'fn_admin_update_agent')).toHaveLength(0);
});
it('unknown invoice result yields unavailable scan without suspension', async () => {
  cron._config.autoSuspendEnabled = true;
  m.scans.push(agents());
  m.invoices.push({ data: null, error: new Error('unknown') });
  expect((await cron.runSuspensionCheck()).unavailable).toBe(true);
  expect(m.rpc.mock.calls.filter(([n]) => n === 'fn_admin_update_agent')).toHaveLength(0);
});
it('account switch during agent read cancels publication and resets disabled state', async () => {
  let resolve: any;
  m.scans.push(new Promise((r) => (resolve = r)));
  const p = cron.runSuspensionCheck();
  await Promise.resolve();
  await Promise.resolve();
  switchAccount();
  resolve(agents());
  const result = await p;
  expect(result.unavailable).toBe(true);
  expect(cron._lastSuspensionCheck).toBe(null);
  expect(m.queries.filter((q) => q.table === 'credit_invoices')).toHaveLength(0);
});

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
