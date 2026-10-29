import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const reads = vi.hoisted(() => ({ tournament: vi.fn(), seats: vi.fn() }));
const bus = vi.hoisted(() => new Map<string, Set<(event: unknown) => void>>());
vi.mock('@/core/MasterBus', () => ({
  masterBus: {
    subscribe: (name: string, handler: (event: unknown) => void) => {
      const listeners = bus.get(name) ?? new Set();
      bus.set(name, listeners);
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    emit: (name: string, payload: unknown) => {
      for (const handler of bus.get(name) ?? []) handler({ type: name, payload });
    },
    getOrCreateChannel: () => {
      const channel = { on: () => channel, subscribe: () => channel };
      return channel;
    },
    removeRegisteredChannel: () => {},
  },
}));
vi.mock('@/services/TournamentService', () => ({
  tournamentService: {
    getTournament: reads.tournament,
    getCurrentLevelState: (row: any) => ({
      levelIndex: row.current_level ?? 0,
      currentLevel: { smallBlind: 25, bigBlind: 50, ante: 0 },
      nextLevel: null,
      timeRemainingSeconds: 900,
    }),
  },
}));
vi.mock('@/services/TournamentTimerService', () => ({
  tournamentTimerService: { getTimerState: () => null },
}));
vi.mock('@/lib/supabase', () => ({
  supabase: { from: () => ({ select: () => ({ eq: reads.seats }) }) },
}));
vi.mock('@/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { TournamentClock } from '@/components/tournament/TournamentClock';
import { relayTournamentEvent } from '@/services/tournamentEventBridge';

beforeEach(() => {
  reads.tournament.mockReset().mockResolvedValue(null);
  reads.seats.mockReset().mockResolvedValue({ data: [], error: null });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T16:55:00Z'));
});
afterEach(() => {
  cleanup();
  bus.clear();
  vi.useRealTimers();
});

it('renders no invented last-hand timer, then uses the authoritative countdown and clears on release', async () => {
  const id = 'clock-relay-last-hand';
  const { container } = render(<TournamentClock tournamentId={id} />);
  await act(async () => {});
  act(() =>
    relayTournamentEvent(id, {
      type: 'tournament_break',
      payload: { level: 4, phase: 'last_hand', breakEndsAt: null, breakDurationMinutes: 5 },
    })
  );
  expect(container.querySelector('.tc-break-text')?.textContent).toBe('BREAK');
  expect(container.querySelector('.tc-break-timer')).toBeNull();
  act(() => vi.advanceTimersByTime(10_000));
  expect(container.querySelector('.tc-break-timer')).toBeNull();
  act(() =>
    relayTournamentEvent(id, {
      type: 'tournament_break_started',
      payload: {
        level: 4,
        phase: 'counting_down',
        breakEndsAt: '2026-10-29T17:00:00Z',
        breakDurationMinutes: 5,
      },
    })
  );
  expect(container.querySelector('.tc-break-timer')?.textContent).toBe('4:50');
  act(() => vi.advanceTimersByTime(2000));
  expect(container.querySelector('.tc-break-timer')?.textContent).toBe('4:48');
  await act(async () => relayTournamentEvent(id, { type: 'break_ended', payload: { level: 4 } }));
  expect(container.querySelector('.tc-break-overlay')).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('does not let a pre-break read erase the newer break event', async () => {
  const read = deferred<any>();
  reads.tournament.mockReturnValueOnce(read.promise);
  const { container } = render(<TournamentClock tournamentId="race" />);
  act(() =>
    relayTournamentEvent('race', { type: 'tournament_break', payload: { phase: 'last_hand' } })
  );
  expect(container.querySelector('.tc-break-overlay')).not.toBeNull();
  await act(async () => read.resolve({ name: 'Old', on_break: false }));
  expect(container.querySelector('.tc-break-overlay')).not.toBeNull();
});

it('does not restore a released break when its older seat read finishes last', async () => {
  const seats = deferred<any>();
  reads.tournament.mockResolvedValueOnce({ name: 'Old', on_break: true });
  reads.seats.mockReturnValueOnce(seats.promise);
  const { container } = render(<TournamentClock tournamentId="release" />);
  await act(async () => {});
  await act(async () => relayTournamentEvent('release', { type: 'break_ended', payload: {} }));
  await act(async () => seats.resolve({ data: [], error: null }));
  expect(container.querySelector('.tc-break-overlay')).toBeNull();
});

it('does not paint an old tournament after the component changes tournament', async () => {
  const old = deferred<any>();
  reads.tournament
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ name: 'New Tournament' });
  const { container, rerender } = render(<TournamentClock tournamentId="old" />);
  rerender(<TournamentClock tournamentId="new" />);
  await act(async () => {});
  expect(container.querySelector('.tc-name')?.textContent).toBe('New Tournament');
  await act(async () => old.resolve({ name: 'Old Tournament', on_break: true }));
  expect(container.querySelector('.tc-name')?.textContent).toBe('New Tournament');
  expect(container.querySelector('.tc-break-overlay')).toBeNull();
});

it('accepts a fresh persisted countdown after invalidating the old read', async () => {
  const old = deferred<any>();
  reads.tournament.mockReturnValueOnce(old.promise).mockResolvedValueOnce({
    name: 'Fresh',
    on_break: true,
    break_ends_at: '2026-10-29T17:00:00Z',
  });
  const { container } = render(<TournamentClock tournamentId="fresh" />);
  act(() =>
    relayTournamentEvent('fresh', { type: 'tournament_break', payload: { phase: 'last_hand' } })
  );
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  expect(container.querySelector('.tc-name')?.textContent).toBe('Fresh');
  expect(container.querySelector('.tc-break-timer')?.textContent).toBe('4:30');
  await act(async () => old.resolve({ name: 'Stale', on_break: false }));
  expect(container.querySelector('.tc-name')?.textContent).toBe('Fresh');
  expect(container.querySelector('.tc-break-timer')?.textContent).toBe('4:30');
});

it('keeps the latest requested refresh when its predecessor completes last', async () => {
  const old = deferred<any>();
  reads.tournament.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ name: 'Latest' });
  const { container } = render(<TournamentClock tournamentId="overlap" />);
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  await act(async () => old.resolve({ name: 'Earlier' }));
  expect(container.querySelector('.tc-name')?.textContent).toBe('Latest');
});
