import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks }));
import UnionOpsPanel from '../../src/components/union/UnionOpsPanel';
import { UnionOpsService } from '../../src/services/UnionOpsService';

const UNION_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(UnionOpsService, 'getCoverageStrict').mockResolvedValue(null!);
  vi.spyOn(UnionOpsService, 'getAgentRisk').mockResolvedValue([]);
  vi.spyOn(UnionOpsService, 'getSettlementRounds').mockResolvedValue([]);
  vi.spyOn(UnionOpsService, 'getDistributionCheck').mockResolvedValue(null);
  vi.spyOn(UnionOpsService, 'getLawSelfTest').mockResolvedValue(null);
  vi.spyOn(UnionOpsService, 'getSettlementPreview').mockResolvedValue({
    union_id: UNION_ID,
    period_start: '2026-09-07',
    period_end: '2026-09-14',
    round1: { already_executed: true, rake_treasury_available: 100 },
    round2: { payees: 1, amount: 10, clubs_short: 0, short_by: 0, detail: [] },
    round3: { payees: 1, amount: 5, agents_short: 0, short_by: 0, detail: [] },
    total_to_move: 15,
    has_blockers: false,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('union settlement remains a read-only scheduled-close review', () => {
  it('offers Close only and never calls the private settlement coordinator', async () => {
    render(<UnionOpsPanel unionId={UNION_ID} canRun />);
    fireEvent.click(await screen.findByRole('tab', { name: /^Settlement$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review Scheduled Settlement' }));
    expect(await screen.findByRole('dialog', { name: 'Scheduled Settlement Review' })).toBeTruthy();
    expect(
      screen
        .getAllByRole('button', { name: 'Close' })
        .some((button) => button.classList.contains('union-ops-panel__lit-action'))
    ).toBe(true);
    expect(screen.queryByRole('button', { name: /^Settle(?: |$)/ })).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalledWith('fn_union_settlement_cascade', expect.anything());
  });

  it('describes shortfalls without claiming the private coordinator will skip and pay', async () => {
    vi.mocked(UnionOpsService.getSettlementPreview).mockResolvedValueOnce({
      union_id: UNION_ID,
      period_start: '2026-09-07',
      period_end: '2026-09-14',
      round1: { already_executed: true, rake_treasury_available: 100 },
      round2: {
        payees: 1,
        amount: 10,
        clubs_short: 1,
        short_by: 2,
        detail: [{ club: 'short club', owed: 10, treasury: 8, short_by: 2 }],
      },
      round3: { payees: 1, amount: 5, agents_short: 0, short_by: 0, detail: [] },
      total_to_move: 15,
      has_blockers: true,
    });
    render(<UnionOpsPanel unionId={UNION_ID} canRun />);
    fireEvent.click(await screen.findByRole('tab', { name: /^Settlement$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review Scheduled Settlement' }));
    expect(
      await screen.findByText(
        'Funded Recipients May Already Be Paid, But The Period Remains Unsettled Until Every Shortfall Is Cleared. Review Recorded Rounds Before Any Retry.'
      )
    ).toBeTruthy();
    expect(screen.queryByText(/Everyone Else Is Still Paid/)).toBeNull();
  });

  it('does not call zero Round 2 and 3 pending Clear while Round 1 is unrecorded', async () => {
    vi.mocked(UnionOpsService.getSettlementPreview).mockResolvedValueOnce({
      union_id: UNION_ID,
      period_start: '2026-09-07',
      period_end: '2026-09-14',
      round1: { already_executed: false, rake_treasury_available: 100 },
      round2: { payees: 0, amount: 0, clubs_short: 0, short_by: 0, detail: [] },
      round3: { payees: 0, amount: 0, agents_short: 0, short_by: 0, detail: [] },
      total_to_move: 0,
      has_blockers: false,
    });
    render(<UnionOpsPanel unionId={UNION_ID} canRun />);
    fireEvent.click(await screen.findByRole('tab', { name: /^Settlement$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review Scheduled Settlement' }));
    expect(await screen.findByText('Round 2 + 3 Pending')).toBeTruthy();
    expect(
      screen.getByText('Round 1 Is Not Yet Recorded. Its Amount Is Not Estimated By This Preview.')
    ).toBeTruthy();
    expect(screen.queryByText('Clear')).toBeNull();
    expect(screen.queryByText(/Nothing Outstanding/)).toBeNull();
  });
});

describe('union integrity completion message through the real service', () => {
  it.each([
    null,
    { union_id: 'another-union', window_hours: 24, signals: 0 },
    { union_id: UNION_ID, window_hours: 12, signals: 0 },
    { union_id: UNION_ID, window_hours: 24, signals: -1 },
    { union_id: UNION_ID, window_hours: 24, signals: 0.5 },
    { union_id: UNION_ID, window_hours: 24, signals: '0' },
  ])('rejects an unverifiable sweep receipt without a clean toast', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    render(<UnionOpsPanel unionId={UNION_ID} canRun />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Integrity' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run Integrity Sweep (24h)' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1));
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('reports clean only for an exact matching sweep receipt', async () => {
    mocks.rpc.mockResolvedValue({
      data: { union_id: UNION_ID, window_hours: 24, signals: 0 },
      error: null,
    });
    render(<UnionOpsPanel unionId={UNION_ID} canRun />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Integrity' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run Integrity Sweep (24h)' }));
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith('Selected Union Integrity Sweep Clean')
    );
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith('fn_union_integrity_sweep', {
      p_union_id: UNION_ID,
      p_hours: 24,
    });
  });
});
