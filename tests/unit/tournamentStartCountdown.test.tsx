import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ row: vi.fn(), clock: vi.fn(), report: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.row }) }) }),
    rpc: mocks.clock,
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.report }));
import Countdown, {
  scheduledTournamentStart,
  startCountdownText,
} from '../../src/components/table/TournamentStartCountdown';
const now = Date.parse('2026-10-20T15:00:00Z');
const row = {
  status: 'REGISTERING',
  start_time: new Date(now + 65_000).toISOString(),
  format_contract: 'mtt-v2',
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.row.mockReset().mockResolvedValue({ data: row, error: null });
  mocks.clock.mockReset().mockResolvedValue({ data: new Date(now).toISOString(), error: null });
  mocks.report.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
describe('Tournament Starts In', () => {
  it('ticks on the waiting table and disappears on the running row', async () => {
    render(<Countdown tournamentId="a" />);
    await settle();
    expect(screen.getByRole('timer').textContent).toContain('01:05');
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('timer').textContent).toContain('01:04');
    mocks.row.mockResolvedValue({
      data: { ...row, status: 'RUNNING', start_time: new Date(now - 1000).toISOString() },
      error: null,
    });
    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    expect(screen.queryByRole('timer')).toBeNull();
  });
  it('shows the clock for a pre-seated RUNNING tournament before the first deal', async () => {
    mocks.row.mockResolvedValue({ data: { ...row, status: 'RUNNING' }, error: null });
    render(<Countdown tournamentId="a" />);
    await settle();
    expect(screen.getByRole('timer').textContent).toContain('01:05');
    expect(
      scheduledTournamentStart({
        ...row,
        status: 'RUNNING',
        start_time: new Date(now - 1000).toISOString(),
      })
    ).toBeNull();
  });
  it('clears immediately when a hand arrives, and leaves no timers on unmount', async () => {
    const view = render(<Countdown tournamentId="a" />);
    await settle();
    view.rerender(<Countdown tournamentId="a" hasLiveHand />);
    expect(screen.queryByRole('timer')).toBeNull();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never carries a previous tournament clock onto a different table', async () => {
    const view = render(<Countdown tournamentId="a" />);
    await settle();
    mocks.row.mockImplementation(() => new Promise(() => {}));
    view.rerender(<Countdown tournamentId="b" />);
    expect(screen.queryByRole('timer')).toBeNull();
  });
  it('uses the database clock when the device clock differs', async () => {
    mocks.clock.mockResolvedValue({ data: new Date(now + 60_000).toISOString(), error: null });
    render(<Countdown tournamentId="a" />);
    await settle();
    expect(screen.getByRole('timer').textContent).toContain('00:05');
  });
  it('does not invent a time on an unreadable row', async () => {
    mocks.row.mockResolvedValue({ data: null, error: new Error('offline') });
    render(<Countdown tournamentId="a" />);
    await settle();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(mocks.report).toHaveBeenCalled();
  });
  it('handles close, invalid, cancelled and seat-first states', () => {
    expect(startCountdownText(-100)).toBe('Starting Soon');
    expect(startCountdownText(3_661_000)).toBe('1:01:01');
    for (const status of ['CANCELLED', 'COMPLETED'])
      expect(scheduledTournamentStart({ ...row, status })).toBeNull();
    expect(scheduledTournamentStart({ ...row, start_time: 'invalid' })).toBeNull();
    for (const format_contract of ['spin-v1', 'sng-v1', null])
      expect(scheduledTournamentStart({ ...row, format_contract })).toBeNull();
  });
});
