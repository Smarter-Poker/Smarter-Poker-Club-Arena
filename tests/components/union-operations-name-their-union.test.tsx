/**
 * UNION OPERATIONS NAME THEIR UNION (2026-09-24)
 *
 * UnionOpsPanel used to default its union to Midway's, and the platform
 * Financial Admin Hub rendered it with no union at all, so the hub previewed,
 * settled and swept one hardcoded union's books whatever the staff member
 * meant. The panel now requires a union and refuses a blank one, and the hub
 * renders no panel until a union has been chosen from its selector.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUnions: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  rpc: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => {
  const result = { data: [], count: 0, error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'in', 'eq', 'gte', 'order', 'limit']) chain[m] = () => chain;
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  chain.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
    Promise.resolve(result).then(ok, bad);
  return { supabase: { from: () => chain, rpc: mocks.rpc } };
});
vi.mock('../../src/core/MasterBus', () => {
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  return {
    masterBus: {
      subscribeDebounced: () => () => {},
      getOrCreateChannel: () => channel,
      removeRegisteredChannel: vi.fn(),
    },
  };
});
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'staff-1' }, isHydrating: false }),
}));
vi.mock('../../src/hooks/useFinancialAdminScope', async (original) => {
  const real = await original<typeof import('../../src/hooks/useFinancialAdminScope')>();
  return {
    ...real,
    useFinancialAdminScope: () => ({
      status: 'ready',
      clubId: null,
      platformWide: true,
      clubRole: null,
      isPlatformStaff: true,
      userId: 'staff-1',
      message: null,
      reload: vi.fn(),
    }),
  };
});
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/UnionService', () => ({
  unionService: { getUnions: mocks.getUnions },
}));

import UnionOpsPanel from '../../src/components/union/UnionOpsPanel';
import FinancialAdminHub from '../../src/pages/FinancialAdminHub';
import { UnionOpsService } from '../../src/services/UnionOpsService';

const UNION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const union = (id: string, name: string) => ({ id, name });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  mocks.getUnions.mockResolvedValue([union(UNION_B, 'Bravo Union'), union(UNION_A, 'Alpha Union')]);
  vi.spyOn(UnionOpsService, 'getCoverageStrict').mockResolvedValue(null);
  vi.spyOn(UnionOpsService, 'getAgentRisk').mockResolvedValue([]);
  vi.spyOn(UnionOpsService, 'getSettlementRounds').mockResolvedValue([]);
  vi.spyOn(UnionOpsService, 'getDistributionCheck').mockResolvedValue(null);
  vi.spyOn(UnionOpsService, 'getLawSelfTest').mockResolvedValue(null);
  vi.spyOn(UnionOpsService, 'runIntegritySweep').mockResolvedValue({ signals: 0 });
  vi.spyOn(UnionOpsService, 'runSettlementCascade').mockRejectedValue(new Error('not expected'));
  vi.spyOn(UnionOpsService, 'getSettlementPreview').mockImplementation(async (unionId) => ({
    union_id: unionId,
    period_start: '2026-09-14',
    period_end: '2026-09-21',
    round1: { already_executed: true, rake_treasury_available: 100 },
    round2: { payees: 1, amount: 10, clubs_short: 0, short_by: 0, detail: [] },
    round3: { payees: 1, amount: 5, agents_short: 0, short_by: 0, detail: [] },
    total_to_move: 15,
    has_blockers: false,
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const unionReads = () => [
  UnionOpsService.getCoverageStrict,
  UnionOpsService.getAgentRisk,
  UnionOpsService.getSettlementRounds,
  UnionOpsService.getDistributionCheck,
  UnionOpsService.getSettlementPreview,
  UnionOpsService.runSettlementCascade,
  UnionOpsService.runIntegritySweep,
];

describe('UnionOpsPanel cannot render or run without a union', () => {
  it.each(['', '   '])('refuses the blank union id %j and asks nothing', async (blank) => {
    render(<UnionOpsPanel unionId={blank} canRun />);
    expect(screen.getByRole('status').textContent).toBe('No Union Selected');
    expect(screen.queryByRole('button')).toBeNull();
    await Promise.resolve();
    for (const call of unionReads()) expect(call).not.toHaveBeenCalled();
  });

  it('runs its reads and its sweep against the union it was given', async () => {
    render(<UnionOpsPanel unionId={UNION_A} canRun />);
    fireEvent.click(await screen.findByRole('button', { name: 'Integrity' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run Integrity Sweep (24h)' }));
    await waitFor(() =>
      expect(UnionOpsService.runIntegritySweep).toHaveBeenCalledWith(UNION_A, 24)
    );
    expect(UnionOpsService.getCoverageStrict).toHaveBeenCalledWith(UNION_A);
  });
});

describe('the Financial Admin Hub runs union operations against the union staff chose', () => {
  const renderHub = () =>
    render(
      <MemoryRouter>
        <FinancialAdminHub />
      </MemoryRouter>
    );

  it('renders no union panel and runs nothing until a union is chosen', async () => {
    renderHub();
    const select = (await screen.findByLabelText('Union')) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe('');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Choose A Union',
      'Alpha Union',
      'Bravo Union',
    ]);
    expect(screen.getByText('Choose A Union To See Its Operations')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Integrity' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Run Integrity Sweep/ })).toBeNull();
    for (const call of unionReads()) expect(call).not.toHaveBeenCalled();
  });

  it('reads and sweeps the chosen union and never another', async () => {
    renderHub();
    const select = (await screen.findByLabelText('Union')) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: UNION_B } });

    fireEvent.click(await screen.findByRole('button', { name: 'Integrity' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run Integrity Sweep (24h)' }));
    await waitFor(() =>
      expect(UnionOpsService.runIntegritySweep).toHaveBeenCalledWith(UNION_B, 24)
    );

    for (const call of unionReads()) {
      for (const args of vi.mocked(call).mock.calls) expect(args[0]).toBe(UNION_B);
    }
  });

  it('drops an open settlement preview when the selector moves to another union', async () => {
    renderHub();
    const select = (await screen.findByLabelText('Union')) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: UNION_B } });
    fireEvent.click(await screen.findByRole('button', { name: /^Settlement$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review & Run Settlement' }));
    expect(await screen.findByRole('button', { name: /^Settle 15$/ })).toBeTruthy();
    expect(UnionOpsService.getSettlementPreview).toHaveBeenCalledWith(UNION_B);

    fireEvent.change(select, { target: { value: UNION_A } });
    await waitFor(() => expect(UnionOpsService.getCoverageStrict).toHaveBeenCalledWith(UNION_A));
    await screen.findByRole('button', { name: 'Integrity' });
    expect(screen.queryByRole('button', { name: /^Settle 15$/ })).toBeNull();
    expect(UnionOpsService.runSettlementCascade).not.toHaveBeenCalled();
  });

  it('says so when the union list cannot be read, and renders no panel', async () => {
    mocks.getUnions.mockRejectedValue(new Error('permission denied'));
    renderHub();
    expect(await screen.findByText('Unions Could Not Be Loaded')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Integrity' })).toBeNull();
    for (const call of unionReads()) expect(call).not.toHaveBeenCalled();
  });
});
