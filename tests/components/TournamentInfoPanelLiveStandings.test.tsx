import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
const fx = vi.hoisted(() => ({
  notify: () => {},
  rows: [{ user_id: 'hero', username: 'Hero', chips: 1000, status: 'playing' }],
}));
vi.mock('../../src/services/tournamentStandingsUpdates', () => ({
  subscribeTournamentStandings: (_id: string, notify: () => void) => {
    fx.notify = notify;
    return () => {
      fx.notify = () => {};
    };
  },
}));
vi.mock('../../src/services/readTournamentStandings', () => ({
  readTournamentStandings: async () => ({ data: [...fx.rows], count: fx.rows.length, error: null }),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: { id: 'mtt', name: 'MTT', status: 'RUNNING', current_level: 0 },
          error: null,
        }),
      };
      return q;
    },
  },
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children }: any) => <div>{children}</div>,
}));
import TournamentInfoPanel from '../../src/components/tournament/TournamentInfoPanel';
afterEach(cleanup);
it('updates the open table panel from the committed field and uses shared ties', async () => {
  await act(async () => {
    render(<TournamentInfoPanel tournamentId="mtt" heroUserId="hero" onClose={() => {}} />);
  });
  expect(screen.getByText('My Position').parentElement?.textContent).toContain('1 / 1');
  fx.rows = [
    { user_id: 'hero', username: 'Hero', chips: 1000, status: 'playing' },
    { user_id: 'away', username: 'Other Table', chips: 2000, status: 'playing' },
    { user_id: 'tied', username: 'Equal', chips: 1000, status: 'playing' },
  ];
  await act(async () => {
    fx.notify();
  });
  expect(screen.getByText('My Position').parentElement?.textContent).toContain('2 / 3');
  const hero = screen.getByText('Hero').closest('tr');
  const tied = screen.getByText('Equal').closest('tr');
  expect(hero?.querySelector('td')?.textContent).toBe('2');
  expect(tied?.querySelector('td')?.textContent).toBe('2');
});
