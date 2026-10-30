import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TournamentTabProps } from '../../src/components/tournament/details/types';
const handlers = vi.hoisted(() => new Map<string, (payload: any) => void>());
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: (name: string, handler: (payload: any) => void) =>
    handlers.set(name, handler),
}));
import BlindsTab from '../../src/components/tournament/details/BlindsTab';
const now = Date.parse('2026-10-22T21:48:00Z');
function input(extra: Record<string, unknown> = {}): TournamentTabProps {
  return {
    tournament: {
      id: 'hourly-test',
      status: 'RUNNING',
      format_contract: 'mtt-v2',
      synchronized_breaks: true,
      current_level: 0,
      started_at: '2026-10-22T21:00:00Z',
      level_started_at: '2026-10-22T21:44:00Z',
      ...extra,
    },
    blindLevels: [{ level: 1, smallBlind: 25, bigBlind: 50, ante: 0, duration: 8, isBreak: false }],
  } as TournamentTabProps;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  handlers.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function panel() {
  return screen.getByRole('heading', { name: 'Next Break' }).closest('section')!;
}
describe('hourly tournament lobby breaks', () => {
  it.each(['mtt-v1', 'mtt-v2'])('shows :55 without a structure break for %s', (format_contract) => {
    render(<BlindsTab {...input({ format_contract })} />);
    expect(panel()).toHaveTextContent('7:00');
    expect(panel()).toHaveTextContent('Hourly At :55');
    expect(panel()).toHaveTextContent('5 Minutes After All Hands Finish');
    expect(screen.queryByText('No Further Breaks Scheduled')).toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    expect(panel()).toHaveTextContent('6:59');
  });
  it('uses the first :55 after a future start', () => {
    render(
      <BlindsTab
        {...input({ status: 'REGISTERING', started_at: null, start_time: '2026-10-22T22:00:00Z' })}
      />
    );
    expect(panel()).toHaveTextContent('1:07:00');
  });
  it('ignores structure breaks when calculating the hourly boundary', () => {
    const props = input();
    props.blindLevels.push({
      level: 2,
      smallBlind: 0,
      bigBlind: 0,
      ante: 0,
      duration: 5,
      isBreak: true,
    });
    render(<BlindsTab {...props} />);
    expect(panel()).toHaveTextContent('7:00');
  });
  it('shows last-hand state from a fresh row without inventing an end time', () => {
    render(<BlindsTab {...input({ on_break: true, break_ends_at: null })} />);
    expect(screen.getByText('Finishing Current Hands')).toBeInTheDocument();
    expect(screen.getByText('5 Minutes After All Hands Finish')).toBeInTheDocument();
    expect(screen.queryByText('Until Play Resumes')).toBeNull();
  });
  it('replaces last-hand state with the real five minutes and ignores duplicate seeds', () => {
    render(<BlindsTab {...input()} />);
    act(() =>
      handlers.get('TOURNAMENT_BREAK')!({ tournamentId: 'hourly-test', durationMinutes: 5 })
    );
    expect(screen.getByText('Finishing Current Hands')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(90_000));
    const breakEndsAt = new Date(Date.now() + 300_000).toISOString();
    act(() =>
      handlers.get('BREAK_START')!({ tournamentId: 'hourly-test', durationMinutes: 5, breakEndsAt })
    );
    expect(screen.getByText('5:00')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    act(() =>
      handlers.get('TOURNAMENT_BREAK')!({ tournamentId: 'hourly-test', durationMinutes: 5 })
    );
    expect(screen.getByText('4:59')).toBeInTheDocument();
  });
  it('does not carry the previous tournament break into a different event', () => {
    const { rerender } = render(<BlindsTab {...input()} />);
    act(() =>
      handlers.get('BREAK_START')!({
        tournamentId: 'hourly-test',
        breakEndsAt: new Date(now + 300_000).toISOString(),
      })
    );
    expect(screen.getByRole('heading', { name: 'On Break' })).toBeInTheDocument();
    rerender(<BlindsTab {...input({ id: 'other-event' })} />);
    expect(screen.queryByRole('heading', { name: 'On Break' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Current Level' })).toBeInTheDocument();
  });
  it('does not carry the previous tournament level into a different event', () => {
    const { rerender } = render(<BlindsTab {...input()} />);
    act(() => handlers.get('BLIND_LEVEL_CHANGE')!({ tournamentId: 'hourly-test', level: 3 }));
    expect(screen.getByText('Level 3')).toBeInTheDocument();
    rerender(<BlindsTab {...input({ id: 'other-event' })} />);
    expect(screen.queryByText('Level 3')).toBeNull();
    expect(screen.getByText('Level 1')).toBeInTheDocument();
  });
  it('uses the persisted countdown after reload', () => {
    render(
      <BlindsTab
        {...input({ on_break: true, break_ends_at: new Date(now + 275_000).toISOString() })}
      />
    );
    expect(screen.getByText('4:35')).toBeInTheDocument();
  });
  it.each(['COMPLETED', 'CANCELLED', 'BAGGED'])('has no future breaks for %s', (status) => {
    render(<BlindsTab {...input({ status })} />);
    expect(screen.queryByRole('heading', { name: 'Next Break' })).toBeNull();
  });
  it.each(['spin-v1', 'sng-v1', 'seat-first-satellite-v1'])(
    'preserves %s exclusion',
    (format_contract) => {
      render(<BlindsTab {...input({ format_contract })} />);
      expect(panel()).toHaveTextContent('No Hourly Breaks');
    }
  );
  it('preserves explicit break opt out', () => {
    render(<BlindsTab {...input({ synchronized_breaks: false })} />);
    expect(panel()).toHaveTextContent('No Hourly Breaks');
  });
  it('shows missing format as unknown', () => {
    render(<BlindsTab {...input({ format_contract: undefined })} />);
    expect(panel()).toHaveTextContent('Break Schedule Unavailable');
  });
  it('rolls over UTC midnight independently of local DST', () => {
    vi.setSystemTime(new Date('2026-11-01T23:58:00Z'));
    render(<BlindsTab {...input()} />);
    expect(panel()).toHaveTextContent('57:00');
  });
});
