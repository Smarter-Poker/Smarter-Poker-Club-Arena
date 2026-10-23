import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fx = vi.hoisted(() => ({ read: vi.fn(), report: vi.fn() }));
vi.mock('../../src/services/TournamentService', () => ({
  tournamentService: { getTournament: fx.read },
}));
vi.mock('../../src/utils/serverClock', () => ({ serverNow: () => Date.now() }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: fx.report }));
vi.mock('../../src/components/lobby/game-cards/useFitText', () => ({
  useFitText: () => ({ current: null }),
}));
import { TournamentLateRegCallToAction } from '../../src/components/table/TournamentLateRegCallToAction';
const now = Date.parse('2026-10-23T01:00:00Z');
const row = {
  status: 'RUNNING',
  current_level: 0,
  late_reg_levels: 0,
  late_reg_mins: 1,
  started_at: new Date(now - 55_000).toISOString(),
};
const props = { tournamentId: 'first', onRegister: vi.fn(), fallback: <span>Closed</span> };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.clearAllMocks();
  fx.read.mockResolvedValue(row);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
async function mount() {
  const view = render(<TournamentLateRegCallToAction {...props} />);
  await act(async () => {});
  return view;
}
describe('live tournament spectating holder', () => {
  it('ticks from the deadline and removes entry at expiry', async () => {
    await mount();
    expect(screen.getByText('0:05')).toBeTruthy();
    expect(screen.getByText('Tap Here To Enter')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('0:04')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByTestId('tournament-late-reg-cta')).toBeNull();
    expect(screen.getByText('Closed')).toBeTruthy();
  });
  it('keeps the existing entry callback and refuses a clock that expired while suspended', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('tournament-late-reg-cta'));
    expect(props.onRegister).toHaveBeenCalledTimes(1);
    vi.setSystemTime(now + 6000);
    fireEvent.click(screen.getByTestId('tournament-late-reg-cta'));
    expect(props.onRegister).toHaveBeenCalledTimes(1);
  });
  it('does not paint the previous tournament while the next read is pending', async () => {
    const view = await mount();
    fx.read.mockReturnValue(new Promise(() => {}));
    view.rerender(<TournamentLateRegCallToAction {...props} tournamentId="second" />);
    expect(screen.queryByTestId('tournament-late-reg-cta')).toBeNull();
  });
  it('reports a failed read and shows the fallback', async () => {
    fx.read.mockRejectedValue(new Error('Read Failed'));
    await mount();
    expect(screen.getByText('Closed')).toBeTruthy();
    expect(fx.report).toHaveBeenCalledTimes(1);
  });
});
