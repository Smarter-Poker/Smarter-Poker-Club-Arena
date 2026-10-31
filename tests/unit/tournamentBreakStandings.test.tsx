import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TournamentBreakScreen from '../../src/components/table/TournamentBreakScreen';

const state = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    user_id: string;
    username: string;
    chips: number;
    status: string;
  }>,
  total: 73,
  error: false,
  queries: 0,
  hold: null as Promise<void> | null,
  listeners: new Map<string, () => void>(),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/tournamentStandingsUpdates', () => ({
  subscribeTournamentStandings: (id: string, listener: () => void) => {
    state.listeners.set(id, listener);
    return () => state.listeners.delete(id);
  },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      let cursor = '';
      let limit = 1000;
      let statuses: string[] | null = null;
      const query: any = {
        select: () => query,
        eq: () => query,
        order: () => query,
        gt: (_: string, id: string) => {
          cursor = id;
          return query;
        },
        in: (_: string, values: string[]) => {
          statuses = values;
          return query;
        },
        limit: (value: number) => {
          limit = value;
          return query;
        },
        maybeSingle: async () => ({
          data: { current_level: 2, prize_pool: 1700, current_players: state.total },
          error: null,
        }),
        then: (resolve: any, reject: any) => {
          state.queries++;
          const rows = state.rows.filter(
            (r) => (!statuses || statuses.includes(r.status)) && r.id > cursor
          );
          const result = state.error
            ? { data: null, error: new Error('Unavailable') }
            : { data: rows.slice(0, limit), count: rows.length, error: null };
          const hold = state.hold;
          return Promise.resolve(hold)
            .then(() => result)
            .then(resolve, reject);
        },
      };
      return query;
    },
  },
}));
const props = {
  isVisible: true,
  tournamentId: 'event',
  heroUserId: '72',
  tournamentName: 'Afternoon Deep Stack',
  breakTimeRemaining: 300,
  nextLevel: { level: 3, smallBlind: 50, bigBlind: 100 },
};
const players = () => document.querySelector('.break-screen__stat-value')?.textContent;
const hero = () => document.querySelector('.break-screen__my-rank')?.textContent;
const flush = async () => {
  await act(async () => {});
};
beforeEach(() => {
  state.total = 73;
  state.error = false;
  state.hold = null;
  state.queries = 0;
  state.listeners.clear();
  state.rows = Array.from({ length: 73 }, (_, i) => ({
    id: String(i).padStart(4, '0'),
    user_id: String(i),
    username: `Player ${i}`,
    chips: i === 72 ? 9500 : 25000,
    status: 'playing',
  }));
});

describe('live break standings', () => {
  it('updates 73 to 72 during the open break, including rank, average and leaders', async () => {
    render(<TournamentBreakScreen {...props} />);
    await flush();
    expect(players()).toBe('73');
    expect(hero()).toContain('#73');
    state.total = 72; // This legacy counter drains; it is not the entrant total.
    state.rows = state.rows.map((r, i) =>
      i === 0 ? { ...r, status: 'eliminated', chips: 0 } : i === 1 ? { ...r, chips: 50000 } : r
    );
    await act(async () => state.listeners.get('event')!());
    expect(players()).toBe('72');
    expect(hero()).toContain('#72');
    expect(screen.getByText('Of 73')).toBeVisible();
    expect(document.querySelector('.break-screen__stat-value[title]')).toHaveAttribute(
      'title',
      '25,131'
    );
    expect(document.querySelector('.break-screen__leader-name')).toHaveTextContent('Player 1');
  });

  it('reads the complete field beyond both 500 and the API page size', async () => {
    state.total = 1201;
    state.rows = Array.from({ length: 1201 }, (_, i) => ({
      id: String(i).padStart(4, '0'),
      user_id: String(i),
      username: `Player ${i}`,
      chips: i === 1200 ? 90000 : 1000,
      status: 'playing',
    }));
    render(<TournamentBreakScreen {...props} heroUserId="1200" />);
    await flush();
    expect(players()).toBe('1201');
    expect(hero()).toContain('#1');
    expect(document.querySelector('.break-screen__leader-name')).toHaveTextContent('Player 1200');
    expect(state.queries).toBe(2);
  });

  it('coalesces events during a read and never paints the superseded answer', async () => {
    let release!: () => void;
    state.hold = new Promise<void>((r) => {
      release = r;
    });
    render(<TournamentBreakScreen {...props} />);
    await flush();
    state.rows = state.rows.slice(1);
    state.hold = null;
    await act(async () => {
      state.listeners.get('event')!();
      state.listeners.get('event')!();
      release();
    });
    expect(players()).toBe('72');
    expect(state.queries).toBe(2);
  });

  it('refreshes at the last-hand/countdown transition and drops old-owner responses', async () => {
    const view = render(<TournamentBreakScreen {...props} phase="last_hand" />);
    await flush();
    state.rows = state.rows.slice(1);
    view.rerender(<TournamentBreakScreen {...props} phase="counting_down" />);
    await flush();
    expect(players()).toBe('72');
    let release!: () => void;
    state.hold = new Promise<void>((r) => {
      release = r;
    });
    await act(async () => state.listeners.get('event')!());
    state.hold = null;
    state.rows = [];
    view.rerender(<TournamentBreakScreen {...props} tournamentId="other" />);
    await flush();
    await act(async () => release());
    expect(players()).toBe('0');
    expect(screen.queryByText('Your Status')).toBeNull();
    expect(state.listeners.has('event')).toBe(false);
    view.unmount();
    expect(state.listeners.size).toBe(0);
  });

  it('shows unavailable after a failed refresh, then recovers on the next event', async () => {
    render(<TournamentBreakScreen {...props} />);
    await flush();
    state.error = true;
    await act(async () => state.listeners.get('event')!());
    expect(players()).toBe('N/A');
    expect(screen.queryByText('Your Status')).toBeNull();
    expect(screen.getByText('Standings Unavailable')).toBeVisible();
    state.error = false;
    state.rows = state.rows.slice(1);
    await act(async () => state.listeners.get('event')!());
    expect(players()).toBe('72');
    expect(screen.queryByText('Standings Unavailable')).toBeNull();
  });
});
