/**
 * UNION OPERATIONS NAME THEIR UNION (2026-09-24)
 *
 * UnionOpsPanel used to default its union to Midway's, and the platform
 * Financial Admin Hub rendered it with no union at all, so the hub previewed,
 * previewed and swept one hardcoded union's books whatever the staff member
 * meant. The panel now requires a union and refuses a blank one, and the hub
 * renders no panel until a union has been chosen from its selector.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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
import UnionOpsPanel from '../../src/components/union/UnionOpsPanel';
import FinancialAdminHub from '../../src/pages/FinancialAdminHub';
import { UnionOpsService } from '../../src/services/UnionOpsService';

const UNION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const union = (id: string, name: string) => ({ id, name });
const unionOpsCss = readFileSync(
  resolve(process.cwd(), 'src/components/union/UnionOpsPanel.css'),
  'utf8'
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  vi.spyOn(UnionOpsService, 'getOverseerUnionOptions').mockResolvedValue([
    union(UNION_A, 'Alpha Union'),
    union(UNION_B, 'Bravo Union'),
  ]);
  vi.spyOn(UnionOpsService, 'getCoverageStrict').mockResolvedValue(null);
  vi.spyOn(UnionOpsService, 'getAgentRisk').mockResolvedValue([]);
  vi.spyOn(UnionOpsService, 'getSettlementRounds').mockResolvedValue([]);
  vi.spyOn(UnionOpsService, 'getDistributionCheck').mockResolvedValue(null);
  vi.spyOn(UnionOpsService, 'getLawSelfTest').mockResolvedValue(null);
  vi.spyOn(UnionOpsService, 'runIntegritySweep').mockImplementation(
    async (unionId, hours = 24) => ({
      union_id: unionId,
      window_hours: hours,
      signals: 0,
    })
  );
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
  document.body.style.overflow = '';
});

const unionReads = () => [
  UnionOpsService.getCoverageStrict,
  UnionOpsService.getAgentRisk,
  UnionOpsService.getSettlementRounds,
  UnionOpsService.getDistributionCheck,
  UnionOpsService.getSettlementPreview,
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
    fireEvent.click(await screen.findByRole('tab', { name: 'Integrity' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run Integrity Sweep (24h)' }));
    await waitFor(() =>
      expect(UnionOpsService.runIntegritySweep).toHaveBeenCalledWith(UNION_A, 24)
    );
    expect(UnionOpsService.getLawSelfTest).toHaveBeenCalledTimes(2);
    expect(UnionOpsService.getCoverageStrict).not.toHaveBeenCalled();
  });

  it('loads expensive reports only when their tab is selected', async () => {
    render(<UnionOpsPanel unionId={UNION_A} canRun />);
    await screen.findByText('No Agent Activity In This Period.');
    expect(UnionOpsService.getCoverageStrict).not.toHaveBeenCalled();
    expect(UnionOpsService.getDistributionCheck).not.toHaveBeenCalled();
    expect(UnionOpsService.getLawSelfTest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: 'Settlement' }));
    await waitFor(() => expect(UnionOpsService.getDistributionCheck).toHaveBeenCalledWith(UNION_A));
    expect(UnionOpsService.getLawSelfTest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: 'Integrity' }));
    await waitFor(() => expect(UnionOpsService.getLawSelfTest).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('tab', { name: 'Hierarchy' }));
    await waitFor(() => expect(UnionOpsService.getCoverageStrict).toHaveBeenCalledWith(UNION_A));
  });

  it('implements a linked keyboard-operable tablist and keeps Refresh outside it', async () => {
    render(<UnionOpsPanel unionId={UNION_A} canRun />);
    const riskTab = await screen.findByRole('tab', { name: 'Risk By Agent' });
    const tablist = screen.getByRole('tablist', { name: 'Union Operations' });
    const panel = screen.getByRole('tabpanel');
    expect(screen.getAllByRole('tab').every((item) => !item.hasAttribute('aria-controls'))).toBe(
      true
    );
    expect(panel).toHaveAttribute('aria-labelledby', riskTab.id);
    expect(riskTab).toHaveAttribute('tabindex', '0');
    expect(tablist.contains(screen.getByRole('button', { name: 'Refresh' }))).toBe(false);

    riskTab.focus();
    fireEvent.keyDown(riskTab, { key: 'ArrowRight' });
    const hierarchy = screen.getByRole('tab', { name: 'Hierarchy' });
    await waitFor(() => expect(hierarchy).toHaveFocus());
    expect(hierarchy).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(hierarchy, { key: 'End' });
    const integrity = screen.getByRole('tab', { name: 'Integrity' });
    await waitFor(() => expect(integrity).toHaveFocus());

    fireEvent.keyDown(integrity, { key: 'Home' });
    await waitFor(() => expect(riskTab).toHaveFocus());

    fireEvent.keyDown(riskTab, { key: 'ArrowLeft' });
    await waitFor(() => expect(integrity).toHaveFocus());
  });

  it('prints Unnamed Agent instead of leaking an agent UUID', async () => {
    vi.mocked(UnionOpsService.getAgentRisk).mockResolvedValueOnce([
      {
        agent_user_id: UNION_B,
        agent_name: null,
        club_name: 'midway club',
        role: 'super_agent',
        players: 1,
        seated_now: 0,
        rake_generated: 2,
        player_net: 0,
        commission_accrued: 1,
        credit_extended: 0,
      },
    ]);
    render(<UnionOpsPanel unionId={UNION_A} canRun />);
    expect(await screen.findByText('Unnamed Agent')).toBeTruthy();
    expect(screen.queryByText(UNION_B.slice(0, 8))).toBeNull();
  });

  it('renders an honest message for every successful unavailable report', async () => {
    render(<UnionOpsPanel unionId={UNION_A} canRun />);
    await screen.findByText('No Agent Activity In This Period.');

    fireEvent.click(screen.getByRole('tab', { name: 'Hierarchy' }));
    expect(await screen.findByText('Hierarchy Coverage Is Unavailable.')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Settlement' }));
    expect(await screen.findByText('Distribution Reading Is Unavailable.')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Integrity' }));
    expect(await screen.findByText('Union Law Verdict Is Unavailable.')).toBeTruthy();
  });

  it('prints half-point commission policy bands without rounding them to whole percentages', async () => {
    vi.mocked(UnionOpsService.getCoverageStrict).mockResolvedValueOnce({
      require_agent_for_players: true,
      players_total: 4,
      players_with_agent: 4,
      players_without_agent: 0,
      player_coverage_pct: 100,
      super_agents: 1,
      agents: 2,
      sub_agents: 1,
      agents_under_a_super_agent: 2,
      agents_orphaned: 0,
      sub_agents_under_an_agent: 1,
      sub_agents_orphaned: 0,
      agents_that_have_sub_agents: 1,
      commission_rates_out_of_policy: 0,
      player_rakeback_deals: 2,
      player_rakeback_gap_breaches: 0,
      policy_band: { min: 0.325, max: 0.375 },
    });
    render(<UnionOpsPanel unionId={UNION_A} canRun />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Hierarchy' }));
    expect(await screen.findByText('Band 32.5-37.5%')).toBeTruthy();
    expect(screen.queryByText('Band 33-38%')).toBeNull();
  });

  it('remounts for a new union so resolved A state cannot paint while B is pending', async () => {
    let resolveB!: (rows: Awaited<ReturnType<typeof UnionOpsService.getAgentRisk>>) => void;
    vi.mocked(UnionOpsService.getAgentRisk)
      .mockResolvedValueOnce([
        {
          agent_user_id: 'agent-a',
          agent_name: 'Agent Alpha',
          club_name: 'Alpha Club',
          role: 'agent',
          players: 1,
          seated_now: 0,
          rake_generated: 2,
          player_net: 0,
          commission_accrued: 1,
          credit_extended: 0,
        },
      ])
      .mockImplementationOnce(() => new Promise((resolve) => (resolveB = resolve)));
    const view = render(<UnionOpsPanel unionId={UNION_A} canRun />);
    expect(await screen.findByText('Agent Alpha')).toBeTruthy();

    view.rerender(<UnionOpsPanel unionId={UNION_B} canRun />);
    expect(screen.queryByText('Agent Alpha')).toBeNull();
    expect(screen.getByText('Loading Union Operations…')).toBeTruthy();
    await act(async () => resolveB([]));
    expect(await screen.findByText('No Agent Activity In This Period.')).toBeTruthy();
  });

  it('shows a timeout as failure and never claims there was no agent activity', async () => {
    vi.mocked(UnionOpsService.getAgentRisk).mockRejectedValueOnce({
      code: '57014',
      message: 'canceling statement due to statement timeout',
    });
    render(<UnionOpsPanel unionId={UNION_A} canRun />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That Took Too Long. Please Try Again.'
    );
    expect(screen.queryByText('No Agent Activity In This Period.')).toBeNull();
    expect(UnionOpsService.getDistributionCheck).not.toHaveBeenCalled();
    expect(UnionOpsService.getLawSelfTest).not.toHaveBeenCalled();
  });

  it('ignores a stale failed read after staff switch tabs', async () => {
    let rejectRisk!: (reason: unknown) => void;
    vi.mocked(UnionOpsService.getAgentRisk).mockImplementationOnce(
      () => new Promise((_, reject) => (rejectRisk = reject))
    );
    render(<UnionOpsPanel unionId={UNION_A} canRun />);
    await waitFor(() => expect(UnionOpsService.getAgentRisk).toHaveBeenCalledWith(UNION_A));

    fireEvent.click(screen.getByRole('tab', { name: 'Settlement' }));
    expect(await screen.findByText('No Settlement Runs Recorded Yet.')).toBeTruthy();
    await act(async () => {
      rejectRisk({ code: '57014', message: 'canceling statement due to statement timeout' });
      await Promise.resolve();
    });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('No Settlement Runs Recorded Yet.')).toBeTruthy();
  });

  it('keeps an uncached law status honest while leaving the sweep functional', async () => {
    vi.mocked(UnionOpsService.getLawSelfTest).mockResolvedValueOnce({
      available: false,
      healthy: false,
      breaches: [],
      warnings: [],
      run_status: 'pending',
      note: 'The Detailed Verdict Will Be Available After The Next Scheduled Audit.',
    });
    render(<UnionOpsPanel unionId={UNION_A} canRun />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Integrity' }));
    expect(await screen.findByText('Union Law Audit Status: Pending')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run Integrity Sweep (24h)' })).toBeEnabled();
  });

  it('does not let a completed sweep refresh the tab selected before it', async () => {
    let resolveSweep!: (value: { union_id: string; window_hours: number; signals: number }) => void;
    vi.mocked(UnionOpsService.runIntegritySweep).mockImplementationOnce(
      () => new Promise((resolve) => (resolveSweep = resolve))
    );
    render(<UnionOpsPanel unionId={UNION_A} canRun />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Integrity' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run Integrity Sweep (24h)' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Settlement' }));
    expect(await screen.findByText('No Settlement Runs Recorded Yet.')).toBeTruthy();
    const settlementReads = vi.mocked(UnionOpsService.getSettlementRounds).mock.calls.length;

    await act(async () => {
      resolveSweep({ union_id: UNION_A, window_hours: 24, signals: 0 });
      await Promise.resolve();
    });

    expect(screen.getByText('No Settlement Runs Recorded Yet.')).toBeTruthy();
    expect(UnionOpsService.getSettlementRounds).toHaveBeenCalledTimes(settlementReads);
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.info).not.toHaveBeenCalled();
  });

  it('suppresses a deferred sweep completion after the panel unmounts', async () => {
    let resolveSweep!: (value: { union_id: string; window_hours: number; signals: number }) => void;
    vi.mocked(UnionOpsService.runIntegritySweep).mockImplementationOnce(
      () => new Promise((resolve) => (resolveSweep = resolve))
    );
    const view = render(<UnionOpsPanel unionId={UNION_A} canRun />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Integrity' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run Integrity Sweep (24h)' }));
    view.unmount();

    await act(async () => {
      resolveSweep({ union_id: UNION_A, window_hours: 24, signals: 0 });
      await Promise.resolve();
    });

    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.info).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('bounds settlement history for a 393px viewport with a horizontal scroller', async () => {
    vi.mocked(UnionOpsService.getSettlementRounds).mockResolvedValueOnce([
      {
        round_no: 1,
        round_name: 'union_to_clubs',
        payees: 3,
        amount: 12,
        shortfalls: 0,
        executed_at: '2026-09-14T12:00:00Z',
        detail: null,
      },
    ]);
    const { container } = render(
      <div style={{ width: 393 }}>
        <UnionOpsPanel unionId={UNION_A} canRun />
      </div>
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Settlement' }));
    await screen.findByText('Union To Clubs');
    const scroller = container.querySelector('[data-mobile-width="393"]') as HTMLElement;
    const table = scroller.querySelector('.union-ops-panel__data-table') as HTMLElement;
    expect(scroller).toHaveClass('union-ops-panel__table-scroll');
    expect(scroller).toHaveStyle({ maxWidth: '100%', overflowX: 'auto' });
    expect(table).toHaveStyle({ minWidth: '680px' });
  });

  it('uses the approved read-only console review and never offers settlement execution', async () => {
    vi.mocked(UnionOpsService.getDistributionCheck).mockResolvedValueOnce({
      period_start: '2026-09-28',
      rake_collected: 10,
      agent_commissions: 2.5,
      player_rakeback: 1,
      total_distributed: 3.5,
      over_distributed_by: 0,
      healthy: true,
    });
    document.body.style.overflow = 'scroll';
    const { container } = render(
      <div style={{ containerType: 'inline-size' }} data-testid="containing-console-host">
        <UnionOpsPanel unionId={UNION_A} canRun />
      </div>
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Settlement' }));
    const review = await screen.findByRole('button', { name: 'Review Scheduled Settlement' });
    review.focus();
    fireEvent.click(review);
    const dialog = await screen.findByRole('dialog', { name: 'Scheduled Settlement Review' });
    expect(dialog.parentElement).toBe(document.body);
    expect(document.body.style.overflow).toBe('hidden');
    expect(dialog.querySelector('.sc--family-riveted')).not.toBeNull();
    expect(dialog.querySelector('[style*="border-radius"]')).toBeNull();
    const context = screen.getByText(
      'The Audited Weekly Close Runs Automatically. This Review Cannot Execute A Settlement.'
    );
    await waitFor(() => expect(document.activeElement).toBe(context));
    expect(screen.queryByRole('button', { name: /^Settle(?: |$)/ })).toBeNull();
    expect(
      screen.getByText(
        'The Audited Weekly Close Runs Automatically. This Review Cannot Execute A Settlement.'
      )
    ).toBeTruthy();
    expect(container.querySelector('.union-ops-panel__engraved')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.style.overflow).toBe('scroll');
    expect(document.activeElement).toBe(review);

    fireEvent.click(review);
    const reopened = await screen.findByRole('dialog', { name: 'Scheduled Settlement Review' });
    const close = within(reopened)
      .getAllByRole('button', { name: 'Close' })
      .find((button) => button.classList.contains('union-ops-panel__lit-action'))!;
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.style.overflow).toBe('scroll');
    expect(document.activeElement).toBe(review);
  });

  it('keeps an oversized mobile review reachable from the scroll origin', () => {
    const overlay = unionOpsCss.match(/\.union-ops-panel__overlay\s*\{([\s\S]*?)\}/)?.[1];
    const dialog = unionOpsCss.match(/\.union-ops-panel__dialog\s*\{([\s\S]*?)\}/)?.[1];
    expect(overlay).toContain('display: flex');
    expect(overlay).toContain('align-items: flex-start');
    expect(overlay).toContain('overflow-y: auto');
    expect(overlay).toContain('overscroll-behavior: contain');
    expect(dialog).toContain('margin: auto 0');
  });

  it.each([
    ['2026-09-07', '2026-09-14'],
    ['2026-09-07T07:00:00+00:00', '2026-09-14T07:00:00+00:00'],
  ])('prints the exact UTC settlement contract dates for %s', async (periodStart, periodEnd) => {
    vi.mocked(UnionOpsService.getSettlementPreview).mockResolvedValueOnce({
      union_id: UNION_A,
      period_start: periodStart,
      period_end: periodEnd,
      round1: { already_executed: true, rake_treasury_available: 100 },
      round2: { payees: 1, amount: 10, clubs_short: 0, short_by: 0, detail: [] },
      round3: { payees: 1, amount: 5, agents_short: 0, short_by: 0, detail: [] },
      total_to_move: 15,
      has_blockers: false,
    });
    render(<UnionOpsPanel unionId={UNION_A} canRun />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Settlement' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review Scheduled Settlement' }));
    const start = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 8, 7))
    );
    const end = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 8, 14))
    );
    expect(await screen.findByText(`${start} - ${end}`)).toBeTruthy();
    expect(screen.queryByText(/T07:00:00/)).toBeNull();
  });

  it('drops an A preview on an unkeyed A-to-B prop change', async () => {
    const view = render(<UnionOpsPanel unionId={UNION_A} canRun />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Settlement' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review Scheduled Settlement' }));
    expect(
      (await screen.findAllByRole('button', { name: 'Close' })).some((button) =>
        button.classList.contains('union-ops-panel__lit-action')
      )
    ).toBe(true);
    expect(UnionOpsService.getSettlementPreview).toHaveBeenCalledWith(UNION_A);

    view.rerender(<UnionOpsPanel unionId={UNION_B} canRun />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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
      'Choose An Authorized Union',
      'Alpha Union',
      'Bravo Union',
    ]);
    expect(screen.getByText('Choose An Authorized Union To See Its Operations')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Integrity' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Run Integrity Sweep/ })).toBeNull();
    for (const call of unionReads()) expect(call).not.toHaveBeenCalled();
  });

  it('renders no panel, reads or mutations when the caller oversees no unions', async () => {
    vi.mocked(UnionOpsService.getOverseerUnionOptions).mockResolvedValueOnce([]);
    renderHub();
    expect(await screen.findByText('No Authorized Unions Available')).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('button', { name: /Settlement|Integrity Sweep/ })).toBeNull();
    for (const call of unionReads()) expect(call).not.toHaveBeenCalled();
  });

  it('reads and sweeps the chosen union and never another', async () => {
    renderHub();
    const select = (await screen.findByLabelText('Union')) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: UNION_B } });

    fireEvent.click(await screen.findByRole('tab', { name: 'Integrity' }));
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
    fireEvent.click(await screen.findByRole('tab', { name: /^Settlement$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review Scheduled Settlement' }));
    expect(
      (await screen.findAllByRole('button', { name: 'Close' })).some((button) =>
        button.classList.contains('union-ops-panel__lit-action')
      )
    ).toBe(true);
    expect(UnionOpsService.getSettlementPreview).toHaveBeenCalledWith(UNION_B);

    fireEvent.change(select, { target: { value: UNION_A } });
    await waitFor(() => expect(UnionOpsService.getAgentRisk).toHaveBeenCalledWith(UNION_A));
    await screen.findByRole('tab', { name: 'Integrity' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so when the union list cannot be read, and renders no panel', async () => {
    vi.mocked(UnionOpsService.getOverseerUnionOptions).mockRejectedValueOnce(
      new Error('permission denied')
    );
    renderHub();
    expect(await screen.findByText('Unions Could Not Be Loaded')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Integrity' })).toBeNull();
    for (const call of unionReads()) expect(call).not.toHaveBeenCalled();
  });
});
