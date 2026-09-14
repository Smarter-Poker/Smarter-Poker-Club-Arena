/**
 * The floor (fn_diamond_game_floor) prints other people winning, and since
 * 2026-09-10 the week's five biggest wins beside them. The browser owes it:
 * the service reads top_week as it reads wins (numerics as strings, never an
 * id), the board prints biggest first with its position, and the copy for a
 * quiet week invites the first win rather than apologising.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

import DiamondGamesService, { type FloorWin } from '../../src/services/DiamondGamesService';
import { BiggestWins, prizeLabel, timeAgo } from '../../src/components/games/FloorFeed';

const win = (over: Partial<FloorWin>): FloorWin => ({
  game: 'plinko',
  at: new Date(Date.now() - 3600_000).toISOString(),
  kind: 'chips',
  amount: 5,
  value_chips: 5,
  multiplier_cents: 500,
  name: 'the_hunter',
  avatar: null,
  mine: false,
  ...over,
});

describe('the service reads the week the way it reads the floor', () => {
  beforeEach(() => rpc.mockReset());

  it('normalises top_week beside wins and crash points', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        wins: [
          {
            game: 'wheel',
            at: '2026-09-10T18:20:00Z',
            kind: 'diamonds',
            amount: '50',
            value_chips: '0.5000',
            multiplier_cents: null,
            name: 'A',
            avatar: '',
            mine: true,
          },
        ],
        top_week: [
          {
            game: 'crash',
            at: '2026-09-09T23:04:00Z',
            kind: 'chips',
            amount: '1.50',
            value_chips: '1.50',
            multiplier_cents: '150',
            name: 'B',
            avatar: '/avatars/table/x.webp',
            mine: false,
          },
        ],
        crash_points: [{ crash_cents: '100', cashed: false, at: '2026-09-09T23:04:38Z' }],
      },
      error: null,
    });
    const floor = await DiamondGamesService.floor('club-1', 20);
    expect(rpc).toHaveBeenCalledWith('fn_diamond_game_floor', { p_club_id: 'club-1', p_limit: 20 });
    expect(floor.top_week).toEqual([
      {
        game: 'crash',
        at: '2026-09-09T23:04:00Z',
        kind: 'chips',
        amount: 1.5,
        value_chips: 1.5,
        multiplier_cents: 150,
        name: 'B',
        avatar: '/avatars/table/x.webp',
        mine: false,
      },
    ]);
    expect(floor.wins[0]).toMatchObject({
      kind: 'diamonds',
      amount: 50,
      value_chips: 0.5,
      avatar: null,
      mine: true,
    });
    expect(floor.crash_points).toEqual([
      { crash_cents: 100, cashed: false, at: '2026-09-09T23:04:38Z' },
    ]);
  });

  it('an older floor without top_week reads as an empty week, not a crash', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, wins: [], crash_points: [] }, error: null });
    expect((await DiamondGamesService.floor('club-1')).top_week).toEqual([]);
  });
});

describe('the board prints the week biggest first, with its position', () => {
  it('numbers the rows and names the winner, the game and the prize', () => {
    render(
      <BiggestWins
        wins={[
          win({
            name: 'big_fish',
            value_chips: 20,
            amount: 20,
            multiplier_cents: 2000,
            game: 'plinko',
          }),
          win({
            name: 'the_hunter',
            value_chips: 1.5,
            amount: 1.5,
            multiplier_cents: 150,
            game: 'crash',
          }),
          win({
            kind: 'diamonds',
            amount: 250,
            value_chips: 2.5,
            multiplier_cents: null,
            game: 'wheel',
            mine: true,
          }),
        ]}
      />
    );
    expect(screen.getByText('Biggest Wins')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('big_fish')).toBeInTheDocument();
    expect(screen.getByText('20x For 20 Chips')).toBeInTheDocument();
    expect(screen.getByText('1.5x For 1.50 Chips')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('250 Diamonds')).toBeInTheDocument();
    expect(screen.getByText(/Diamond Crash, /)).toBeInTheDocument();
  });

  it('prints at most five and invites the first win of a quiet week', () => {
    const { unmount } = render(<BiggestWins wins={[]} />);
    expect(
      screen.getByText('No Wins This Week Yet. Yours Could Be The First.')
    ).toBeInTheDocument();
    unmount();
    render(<BiggestWins wins={Array.from({ length: 7 }, (_, i) => win({ name: `p${i}` }))} />);
    expect(screen.getAllByText(/^p\d$/)).toHaveLength(5);
  });
});

describe('the small words', () => {
  it('says when, in the floor’s own words', () => {
    const now = Date.parse('2026-09-10T12:00:00Z');
    expect(timeAgo('2026-09-10T11:59:40Z', now)).toBe('Just Now');
    expect(timeAgo('2026-09-10T11:45:00Z', now)).toBe('15m Ago');
    expect(timeAgo('2026-09-10T09:00:00Z', now)).toBe('3h Ago');
    expect(timeAgo('2026-09-09T12:00:00Z', now)).toBe('Yesterday');
    expect(timeAgo('2026-09-06T12:00:00Z', now)).toBe('4d Ago');
  });

  it('prints a prize as the player reads it', () => {
    expect(prizeLabel(win({ value_chips: 1, amount: 1, multiplier_cents: null }))).toBe('1 Chip');
    expect(prizeLabel(win({ value_chips: 0.2, amount: 0.2, multiplier_cents: 20 }))).toBe(
      '0.2x For 0.20 Chips'
    );
    expect(
      prizeLabel(win({ kind: 'diamonds', amount: 1250, value_chips: 12.5, multiplier_cents: null }))
    ).toBe('1.2K Diamonds');
  });
});
