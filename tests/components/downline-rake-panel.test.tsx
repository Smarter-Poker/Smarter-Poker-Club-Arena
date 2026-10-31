import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  getDownlineRake: vi.fn(),
  getDownlineRakeSummary: vi.fn(),
}));

vi.mock('../../src/services/AgentRakeService', () => ({
  AgentRakeService: {
    getDownlineRake: state.getDownlineRake,
    getDownlineRakeSummary: state.getDownlineRakeSummary,
    // Baseline compatibility: the repaired component must not depend on it.
    subscribeToRake: vi.fn(() => vi.fn()),
  },
  RAKE_WINDOWS: [
    { key: 'today', label: 'Today' },
    { key: '24h', label: '24h' },
    { key: 'week', label: 'This Week' },
    { key: '30d', label: '30 Days' },
  ],
  windowToRange: () => ({ since: null, until: null }),
  describeRakeError: () => 'rake reporting is temporarily unavailable.',
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import DownlineRakePanel from '../../src/components/agent/DownlineRakePanel';

const roles = [
  {
    club_id: 'club-1',
    club_name: 'river sharks',
    role: 'super_agent' as const,
    agent_id: 'agent-role-1',
    is_overseer: false,
  },
  {
    club_id: 'club-2',
    club_name: 'ALL CAPS CLUB',
    role: 'agent' as const,
    agent_id: 'agent-role-2',
    is_overseer: false,
  },
];

const summary = {
  period_start: '2026-10-01T00:00:00Z',
  period_end: '2026-10-03T00:00:00Z',
  members: 1,
  active: 1,
  direct: 1,
  sub_agents: 1,
  hands: 20,
  rake_generated: 14,
  commission_rate: 0.2,
  estimated_commission: 2.8,
  last_hand_at: '2026-10-03T00:00:00Z',
  top_earner: { username: 'river shark', rake: 14 },
};

const row = (index: number, role = 'player') => ({
  player_id: `player-${index}`,
  username: index === 0 ? 'river shark' : `Player ${index}`,
  club_id: 'club-1',
  club_name: 'river sharks',
  role,
  depth: 1,
  upline_user_id: 'agent-root',
  upline_name: 'table boss',
  rake_generated: index + 1,
  hands: index + 2,
  last_hand_at: '2026-10-03T00:00:00Z',
  downline_players: role === 'agent' ? 3 : 0,
  downline_rake: role === 'agent' ? 12 : 0,
});

beforeEach(() => {
  state.getDownlineRake.mockReset();
  state.getDownlineRakeSummary.mockReset();
  state.getDownlineRake.mockResolvedValue([row(0, 'sub_agent'), row(1)]);
  state.getDownlineRakeSummary.mockResolvedValue(summary);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('DownlineRakePanel', () => {
  it('refreshes from the parent record revision without a polling clock', async () => {
    vi.useFakeTimers();
    let view: ReturnType<typeof render>;
    await act(async () => {
      view = render(<DownlineRakePanel roles={[roles[0]]} liveRevision={0} />);
    });
    expect(state.getDownlineRake).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(state.getDownlineRake).toHaveBeenCalledTimes(1);
    state.getDownlineRake.mockResolvedValue([{ ...row(0), rake_generated: 72 }]);
    state.getDownlineRakeSummary.mockResolvedValue({ ...summary, rake_generated: 72 });
    await act(async () => {
      view!.rerender(<DownlineRakePanel roles={[roles[0]]} liveRevision={1} />);
    });
    expect(state.getDownlineRake).toHaveBeenCalledTimes(2);
    expect(state.getDownlineRakeSummary).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText('72').length).toBeGreaterThan(0);
  });

  it('keeps a failed read explicit while the next record-event read is pending', async () => {
    state.getDownlineRake.mockRejectedValueOnce(new Error('statement timeout'));
    const view = render(<DownlineRakePanel roles={[roles[0]]} liveRevision={0} />);
    expect(await screen.findByRole('alert')).toBeVisible();
    let finish!: (rows: ReturnType<typeof row>[]) => void;
    state.getDownlineRake.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    );
    view.rerender(<DownlineRakePanel roles={[roles[0]]} liveRevision={1} />);
    await waitFor(() => expect(state.getDownlineRake).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.queryByText('No Downline Activity In This Window.')).not.toBeInTheDocument();
    await act(async () => finish([]));
    expect(await screen.findByText('No Downline Activity In This Window.')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('cancels the previous scope and refuses its late data after changing clubs', async () => {
    let finishRows!: (rows: ReturnType<typeof row>[]) => void;
    let finishSummary!: (value: typeof summary) => void;
    state.getDownlineRake.mockImplementation(({ clubId }: { clubId: string }) =>
      clubId === 'club-1'
        ? new Promise((resolve) => (finishRows = resolve))
        : Promise.resolve([{ ...row(0), club_id: 'club-2', username: 'New Club Player' }])
    );
    state.getDownlineRakeSummary.mockImplementation(({ clubId }: { clubId: string }) =>
      clubId === 'club-1'
        ? new Promise((resolve) => (finishSummary = resolve))
        : Promise.resolve(summary)
    );
    render(<DownlineRakePanel roles={roles} />);
    await waitFor(() => expect(state.getDownlineRake).toHaveBeenCalledTimes(1));
    const originalSignal = state.getDownlineRake.mock.calls[0][0].signal as AbortSignal;
    expect(originalSignal).toBeDefined();
    fireEvent.change(screen.getByRole('combobox', { name: 'Club' }), {
      target: { value: 'club-2' },
    });
    expect(await screen.findByText('New Club Player')).toBeVisible();
    expect(originalSignal.aborted).toBe(true);
    await act(async () => {
      finishRows([{ ...row(0), username: 'Old Club Player' }]);
      finishSummary({ ...summary, rake_generated: 999 });
    });
    expect(screen.getByText('New Club Player')).toBeVisible();
    expect(screen.queryByText('Old Club Player')).not.toBeInTheDocument();
    expect(screen.queryByText('999')).not.toBeInTheDocument();
  });

  it('coalesces record events behind one in-flight read and aborts on unmount', async () => {
    let finish!: (rows: ReturnType<typeof row>[]) => void;
    state.getDownlineRake.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    );
    const view = render(<DownlineRakePanel roles={[roles[0]]} liveRevision={0} />);
    await waitFor(() => expect(state.getDownlineRake).toHaveBeenCalledTimes(1));
    view.rerender(<DownlineRakePanel roles={[roles[0]]} liveRevision={1} />);
    view.rerender(<DownlineRakePanel roles={[roles[0]]} liveRevision={2} />);
    expect(state.getDownlineRake).toHaveBeenCalledTimes(1);
    let finishNext!: (rows: ReturnType<typeof row>[]) => void;
    state.getDownlineRake.mockImplementationOnce(
      () => new Promise((resolve) => (finishNext = resolve))
    );
    await act(async () => finish([row(0)]));
    await waitFor(() => expect(state.getDownlineRake).toHaveBeenCalledTimes(2));
    const signal = state.getDownlineRake.mock.calls[1][0].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finishNext([row(1)]));
    expect(screen.queryByRole('region', { name: 'Downline Rake Ledger' })).not.toBeInTheDocument();
    expect(state.getDownlineRake).toHaveBeenCalledTimes(2);
  });

  it('withdraws the previous viewer snapshot and aborts their pending read on an identity switch', async () => {
    const view = render(
      <DownlineRakePanel roles={[roles[0]]} viewerId="viewer-a" liveRevision={0} />
    );
    expect((await screen.findAllByText('river shark')).length).toBeGreaterThan(0);
    let finishOld!: (rows: ReturnType<typeof row>[]) => void;
    state.getDownlineRake.mockImplementationOnce(
      () => new Promise((resolve) => (finishOld = resolve))
    );
    view.rerender(<DownlineRakePanel roles={[roles[0]]} viewerId="viewer-a" liveRevision={1} />);
    await waitFor(() => expect(state.getDownlineRake).toHaveBeenCalledTimes(2));
    const oldSignal = state.getDownlineRake.mock.calls[1][0].signal as AbortSignal;
    let finishNew!: (rows: ReturnType<typeof row>[]) => void;
    state.getDownlineRake.mockImplementationOnce(
      () => new Promise((resolve) => (finishNew = resolve))
    );
    view.rerender(<DownlineRakePanel roles={[roles[0]]} viewerId="viewer-b" liveRevision={1} />);
    expect(screen.queryByText('river shark')).not.toBeInTheDocument();
    await waitFor(() => expect(state.getDownlineRake).toHaveBeenCalledTimes(3));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => finishOld([{ ...row(0), username: 'Previous Viewer Player' }]));
    expect(screen.queryByText('Previous Viewer Player')).not.toBeInTheDocument();
    expect(screen.getByText('Loading Downline Rake...')).toBeVisible();
    await act(async () => finishNew([{ ...row(0), username: 'Current Viewer Player' }]));
    expect(await screen.findByText('Current Viewer Player')).toBeVisible();
  });

  it('uses semantic controls, record-event copy, and preserves identity casing', async () => {
    render(<DownlineRakePanel roles={roles} />);

    const agent = await screen.findByRole('button', { name: 'Open river shark Downline' });
    expect(agent).toHaveAttribute('type', 'button');
    expect(screen.getByText('Sub Agent')).toBeVisible();
    expect(screen.getAllByText('table boss')).toHaveLength(2);
    expect(screen.getAllByText('river shark').length).toBeGreaterThan(0);
    expect(screen.getByText(/Live Record Updates \/ Last Checked/)).toBeVisible();

    fireEvent.click(agent);
    await waitFor(() =>
      expect(state.getDownlineRake).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentUserId: 'player-0', limit: 501 })
      )
    );
    expect(screen.getByRole('button', { name: 'river shark' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('retains expanded pagination after the initial debounce and resets only for changed search', async () => {
    vi.useFakeTimers();
    state.getDownlineRake.mockImplementation(async ({ limit }: { limit: number }) =>
      Array.from({ length: limit === 501 ? 501 : 620 }, (_, i) => row(i))
    );
    await act(async () => {
      render(<DownlineRakePanel roles={[roles[0]]} />);
    });
    expect(screen.getByText(/Showing 500 Members/)).toBeVisible();
    expect(screen.getAllByRole('row')).toHaveLength(501);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show 500 More Members' }));
    });
    expect(state.getDownlineRake).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 1001, search: '' })
    );
    expect(screen.getAllByRole('row')).toHaveLength(621);
    const readsAfterExpansion = state.getDownlineRake.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(state.getDownlineRake).toHaveBeenCalledTimes(readsAfterExpansion);
    expect(screen.getAllByRole('row')).toHaveLength(621);
    expect(screen.queryByRole('button', { name: 'Show 500 More Members' })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByRole('textbox', { name: 'Search Downline Players' }), {
        target: { value: 'river' },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(state.getDownlineRake).toHaveBeenCalledTimes(readsAfterExpansion);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(state.getDownlineRake).toHaveBeenCalledTimes(readsAfterExpansion + 1);
    expect(state.getDownlineRake).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 501, search: 'river' })
    );
    expect(screen.getAllByRole('row')).toHaveLength(501);
    expect(screen.getByRole('button', { name: 'Show 500 More Members' })).toBeVisible();
  });

  it('title-cases a dynamic error without adding generic inline chrome', async () => {
    state.getDownlineRake.mockRejectedValueOnce(new Error('offline'));
    render(<DownlineRakePanel roles={[roles[0]]} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Rake Reporting Is Temporarily Unavailable.'
    );

    const source = readFileSync(
      resolve(__dirname, '../../src/components/agent/DownlineRakePanel.tsx'),
      'utf8'
    );
    expect(source).toContain("import './DownlineRakePanel.css'");
    expect(source).not.toContain('style={{');
    expect(source).not.toContain('Live · Updated');
    expect(source).not.toMatch(/[♠♥♦♣▲▼▪✓✗○★☆⚠→←↑↓]/u);
  });
});
