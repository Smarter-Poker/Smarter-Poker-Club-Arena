import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TournamentTabProps } from '../../src/components/tournament/details/types';
const db = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const args = { table, event: '', cursor: '', from: 0, limit: 1000 };
      const q = {
        select: () => q,
        eq: (_: string, value: string) => {
          args.event = value;
          return q;
        },
        gt: (column: string, value: string) => {
          if (column === 'id') args.cursor = value;
          return q;
        },
        order: () => q,
        limit: (n: number) => {
          args.limit = n;
          return q;
        },
        range: (from: number) => {
          args.from = from;
          return q;
        },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve()
            .then(() => db.read(args))
            .then(resolve, reject),
      };
      return q;
    },
  },
}));
import RewardsTab from '../../src/components/tournament/details/RewardsTab';
const props = (id: string) =>
  ({
    tournament: {
      id,
      status: 'RUNNING',
      is_bounty: true,
      bounty_pool: 0,
      bounty_pool_paid: 0,
      prize_pool: 0,
    },
    entries: [],
  }) as unknown as TournamentTabProps;
const heads = [{ id: 'a', current_bounty: 125, status: 'playing' }];
beforeEach(() => {
  db.read.mockImplementation(({ table }) => ({
    data: table === 'tournament_players' ? heads : [],
    error: null,
  }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const pool = (container: HTMLElement) => container.querySelector('.rw-bounty')!;
describe('Rewards reads only the complete ledger for the selected event', () => {
  it('clears the previous event while the new event is pending and reports its failed read', async () => {
    const view = render(<RewardsTab {...props('first')} />);
    await waitFor(() => expect(pool(view.container).textContent).toContain('125'));
    let finish!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    db.read.mockImplementation(() => pending);
    view.rerender(<RewardsTab {...props('second')} />);
    expect(pool(view.container).textContent).toContain('Loading The Bounty Pool');
    expect(pool(view.container).textContent).not.toContain('125');
    await act(async () => finish({ data: null, error: { message: 'offline' } }));
    expect(pool(view.container).textContent).toContain('The Bounty Pool Could Not Be Read');
  });
  it('does not call a null response an unfunded bounty pool', async () => {
    db.read.mockResolvedValue({ data: null, error: null });
    const view = render(<RewardsTab {...props('first')} />);
    await waitFor(() =>
      expect(pool(view.container).textContent).toContain('The Bounty Pool Could Not Be Read')
    );
  });
  it('does not skip a surviving head when an earlier filtered head disappears between pages', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      id: String(i).padStart(5, '0'),
      current_bounty: 1,
      status: 'playing',
    }));
    let pages = 0;
    db.read.mockImplementation(({ table, cursor, from, limit }) => {
      if (table !== 'tournament_players') return { data: [], error: null };
      const visible = pages++ === 0 ? rows : rows.slice(1);
      const result = cursor
        ? visible.filter((r) => r.id > cursor).slice(0, limit)
        : visible.slice(from, from + limit);
      return { data: result, error: null };
    });
    const view = render(<RewardsTab {...props('first')} />);
    await waitFor(() => expect(pool(view.container).textContent).toContain('1,001'));
  });
  it('refuses a repeated cursor rather than counting duplicate heads', async () => {
    db.read.mockImplementation(({ table }) => ({
      data: table === 'tournament_players' ? Array.from({ length: 1000 }, () => heads[0]) : [],
      error: null,
    }));
    const view = render(<RewardsTab {...props('first')} />);
    await waitFor(() =>
      expect(pool(view.container).textContent).toContain('The Bounty Pool Could Not Be Read')
    );
  });
  it('keeps the last verified same-event ledger if an elimination refresh fails', async () => {
    const view = render(<RewardsTab {...props('first')} />);
    await waitFor(() => expect(pool(view.container).textContent).toContain('125'));
    db.read.mockResolvedValue({ data: null, error: { message: 'offline' } });
    const next = props('first');
    next.entries = [
      { id: 'out', user_id: 'out', status: 'eliminated' },
    ] as TournamentTabProps['entries'];
    view.rerender(<RewardsTab {...next} />);
    await act(async () => {});
    expect(pool(view.container).textContent).toContain('125');
    expect(pool(view.container).textContent).not.toContain('Could Not Be Read');
  });
  it('does not accept a complete page budget without evidence of the end', async () => {
    db.read.mockImplementation(({ table, cursor, from }) => {
      if (table !== 'tournament_players') return { data: [], error: null };
      const start = cursor ? Number(cursor) + 1 : from;
      return {
        data: Array.from({ length: 1000 }, (_, i) => ({
          id: String(start + i).padStart(8, '0'),
          current_bounty: 1,
          status: 'playing',
        })),
        error: null,
      };
    });
    const view = render(<RewardsTab {...props('first')} />);
    await waitFor(() =>
      expect(pool(view.container).textContent).toContain('The Bounty Pool Could Not Be Read')
    );
    expect(db.read.mock.calls.filter(([a]) => a.table === 'tournament_players')).toHaveLength(100);
  });
  it('accepts a verified empty ledger', async () => {
    db.read.mockResolvedValue({ data: [], error: null });
    const view = render(<RewardsTab {...props('first')} />);
    await waitFor(() =>
      expect(pool(view.container).textContent).toContain('The Bounty Pool Is Not Funded Yet')
    );
  });
});
