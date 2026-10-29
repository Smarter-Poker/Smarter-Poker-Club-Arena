import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

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
  tournamentService: { getTournament: async () => null },
}));
vi.mock('@/services/TournamentTimerService', () => ({ tournamentTimerService: {} }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { TournamentClock } from '@/components/tournament/TournamentClock';
import { relayTournamentEvent } from '@/services/tournamentEventBridge';

beforeEach(() => {
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
