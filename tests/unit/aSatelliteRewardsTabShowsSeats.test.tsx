/**
 * A SATELLITE'S REWARDS TAB SHOWS SEATS (2026-10-04).
 *
 * The Rewards tab priced `payout_structure` for every event. A satellite does
 * not pay that ladder: `fn_ca_settle_satellite_cohort` awards
 * floor(prize_pool / (target buy-in + target fee)) seats and pays the
 * remainder to the next finisher. FE93D011 (pool 810, target entry 100) read
 * "2 Paid Places, Money Bubble 3rd, 1st 63.52% 515, 2nd 36.48% 295" while the
 * recorded outcome was seven seat winners at 100, 8th at 100 and 9th at 10.
 *
 * The client does not hold the target's price, so nothing is computed here:
 * a finished satellite prints what was recorded, an unfinished one says it
 * awards seats, and every other event keeps its ladder.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TournamentEntry,
  TournamentTabProps,
} from '../../src/components/tournament/details/types';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  error: null as { message: string } | null,
  pending: null as Promise<{
    data: Array<Record<string, unknown>> | null;
    error: { message: string } | null;
  }> | null,
  from: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: h.from } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/tournament/MysteryBountyPanel', () => ({ default: () => null }));

import RewardsTab from '../../src/components/tournament/details/RewardsTab';

afterEach(cleanup);

const TARGET = '57b8642a-a398-4bd7-a878-17c1043b7171';

const entry = (
  i: number,
  username: string,
  status: TournamentEntry['status'],
  chips: number,
  position: number | undefined,
  prize: number
): TournamentEntry =>
  ({
    id: `p${i}`,
    user_id: `u${i}`,
    username,
    avatar_url: null,
    chips,
    position,
    prize,
    status,
  }) as TournamentEntry;

/** FE93D011 as production recorded it. */
const SEAT_WINNERS: Array<[string, number]> = [
  ['TURN', 65937],
  ['CactusDenim', 11077],
  ['OldPriya', 7708],
  ['LoneDrawFox', 31015],
  ['slow_cocoa', 29932],
  ['DCDonkey', 5710],
  ['float', 28621],
];
const BUSTED: Array<[string, number, number]> = [
  ['areyes', 8, 100],
  ['tali', 9, 10],
  ['drew.kelly', 10, 0],
  ['Jen96', 11, 0],
  ['boatViking', 12, 0],
  ['Bink44', 13, 0],
  ['ChipGrinder', 14, 0],
  ['RIVER', 15, 0],
  ['MuckSheriff', 16, 0],
  ['MSPHank', 17, 0],
  ['FISH', 18, 0],
];
const ENTRIES: TournamentEntry[] = [
  ...SEAT_WINNERS.map(([name, chips], i) => entry(i, name, 'winner', chips, undefined, 100)),
  ...BUSTED.map(([name, position, prize], i) =>
    entry(100 + i, name, 'eliminated', 0, position, prize)
  ),
];

function props(
  overrides: Record<string, unknown> = {},
  entries: TournamentEntry[] = ENTRIES
): TournamentTabProps {
  return {
    tournament: {
      id: 'fe93d011-d3f3-4e41-82e4-f7b5ca98547b',
      name: 'Sunday Funday Main Event Satellite',
      status: 'COMPLETED',
      format_contract: 'mtt-v2',
      variant: 'satellite',
      tournament_type: 'SATELLITE',
      satellite_target_id: TARGET,
      satellite_target: null,
      satellite_seats: 1,
      current_players: 0,
      prize_pool: 810,
      prize_pool_finalized: true,
      guaranteed_prize: 0,
      buy_in_amount: 45,
      buy_in_fee: 5,
      payout_structure: JSON.stringify([
        { place: 1, percentage: 63.52 },
        { place: 2, percentage: 36.48 },
      ]),
      arena: { id: 'club', asset: 'chips', is_platform: false, union_id: null },
      ...overrides,
    } as unknown as TournamentTabProps['tournament'],
    entries,
    tables: [],
    blindLevels: [],
    currentUserId: 'nobody',
    isRegistered: false,
  };
}

const receipts = (tournamentId = 'fe93d011-d3f3-4e41-82e4-f7b5ca98547b', amount = 100) =>
  ENTRIES.filter((e) => Number(e.prize) > 0).map((e, i) => ({
    id: `receipt${i}`,
    tournament_id: tournamentId,
    user_id: e.user_id,
    source: i < 7 ? 'satellite_seat' : i === 7 ? 'satellite_ticket' : 'satellite_remainder',
    amount: i < 7 ? amount : e.prize,
    recorded_by: i < 7 ? 'fn_settle_satellite_tournament' : 'credit_and_log',
    metadata: i < 7 ? { satellite_target_id: TARGET } : {},
  }));
beforeEach(() => {
  h.rows = receipts();
  h.error = null;
  h.pending = null;
  h.from.mockReset();
  h.from.mockImplementation(() => {
    const result = h.pending ?? Promise.resolve({ data: h.rows.slice(), error: h.error });
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'gt'])
      builder[method] = () => builder;
    builder.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      result.then(resolve, reject);
    return builder;
  });
});

const tiles = (container: HTMLElement) =>
  Object.fromEntries(
    [...container.querySelectorAll('.tl-stat')].map((tile) => [
      tile.querySelector('.tl-stat__label')?.textContent ?? '',
      tile.querySelector('.tl-stat__value')?.textContent ?? '',
    ])
  );

const rows = (container: HTMLElement) =>
  [...container.querySelectorAll('.rw-row')].map((row) => [
    row.querySelector('.rw-rank')?.textContent ?? '',
    row.querySelector('.tl-name')?.textContent ?? '',
    row.querySelector('.rw-prize')?.textContent ?? '',
  ]);

describe('Rewards on a finished satellite', () => {
  it('does not print the percentage ladder the settlement never paid', async () => {
    const { container } = render(<RewardsTab {...props()} />);
    await waitFor(() => expect(container.textContent).toContain('1 Ticket (100)'));
    const text = container.textContent ?? '';
    expect(text).not.toContain('63.52%');
    expect(text).not.toContain('36.48%');
    expect(text).not.toContain('515');
    expect(text).not.toContain('295');
    expect(text).not.toContain('Paid Places');
    expect(text).not.toContain('Money Bubble');
    expect(text).not.toContain('Of The Field Paid');
  });

  it('prints the recorded ticket winners and recorded cash substitutions', async () => {
    const { container } = render(<RewardsTab {...props()} />);
    await waitFor(() => expect(container.textContent).toContain('1 Ticket (100)'));
    expect(tiles(container)).toMatchObject({ 'Total Prize Pool': '810', 'Qualified Players': '7' });
    expect(container.textContent).toContain('9 Players Awarded');
    expect(container.textContent).toContain('Satellite Awards');
    expect(container.querySelectorAll('.rw-tag')).toHaveLength(7);
    expect(container.textContent).toContain('Ticket Winner');

    const list = rows(container);
    expect(list).toHaveLength(9);
    expect(
      list.slice(0, 7).every(([rank, , prize]) => rank === 'Seat' && prize === '1 Ticket (100)')
    ).toBe(true);
    expect(
      list
        .slice(0, 7)
        .map(([, name]) => name)
        .sort()
    ).toEqual(SEAT_WINNERS.map(([name]) => name).sort());
    expect(list[7]).toEqual(['8th', 'areyes', 'Cash 100']);
    expect(list[8]).toEqual(['9th', 'tali', 'Cash 10']);
  });

  it('says it awards seats, and no more, when no award was recorded per player', () => {
    const { container } = render(
      <RewardsTab
        {...props(
          {},
          ENTRIES.map((e) => ({ ...e, prize: undefined }))
        )}
      />
    );
    const text = container.textContent ?? '';
    expect(text).toContain('This Satellite Awards Tickets Into The Target Event');
    expect(text).not.toContain('63.52%');
    expect(text).not.toContain('515');
    expect(rows(container)).toHaveLength(0);
  });
});

describe('satellite award delivery is proven, not guessed from qualification', () => {
  it('shows cash for an unranked qualifier paid by the cash writer', async () => {
    h.rows[0] = {
      ...h.rows[0],
      source: 'satellite_ticket',
      recorded_by: 'credit_and_log',
      metadata: {},
    };
    const { container } = render(<RewardsTab {...props()} />);
    await waitFor(() => expect(container.textContent).toContain('Cash 100'));
    const turn = [...container.querySelectorAll('.rw-row')].find((row) =>
      row.textContent?.includes('TURN')
    );
    expect(turn?.textContent).toContain('Cash Award');
    expect(turn?.textContent).toContain('Cash 100');
    expect(turn?.textContent).not.toContain('1 Ticket');
  });
  it('does not claim tickets when RLS supplies no receipt rows', async () => {
    h.rows = [];
    const { container } = render(<RewardsTab {...props()} />);
    await waitFor(() =>
      expect(container.textContent).toContain('Ticket Or Cash Details Are Unavailable')
    );
    expect(container.textContent).toContain('Value 100');
    expect(container.textContent).not.toContain('1 Ticket');
  });
  it('reports a failed read and keeps recorded values without a ticket claim', async () => {
    h.error = { message: 'receipt read unavailable' };
    const { container } = render(<RewardsTab {...props()} />);
    await waitFor(() =>
      expect(container.textContent).toContain('Ticket Or Cash Details Are Unavailable')
    );
    expect(container.textContent).not.toContain('1 Ticket');
  });
  it('does not let an old event response erase the new event receipt', async () => {
    let finishOld!: (value: { data: Array<Record<string, unknown>>; error: null }) => void;
    h.pending = new Promise((resolve) => {
      finishOld = resolve;
    });
    const { container, rerender } = render(<RewardsTab {...props()} />);
    await waitFor(() => expect(h.from).toHaveBeenCalledTimes(1));
    const next = 'aaaaaaaa-1111-4111-8111-111111111111';
    h.pending = null;
    h.rows = receipts(next, 45);
    rerender(
      <RewardsTab
        {...props(
          { id: next },
          ENTRIES.map((e) => ({ ...e, prize: e.status === 'winner' ? 45 : e.prize }))
        )}
      />
    );
    await waitFor(() => expect(container.textContent).toContain('1 Ticket (45)'));
    await act(async () => {
      finishOld({ data: receipts(), error: null });
    });
    expect(container.textContent).toContain('1 Ticket (45)');
    expect(container.textContent).not.toContain('1 Ticket (100)');
  });
});

describe('Rewards on a satellite that has not finished', () => {
  it('states that seats are awarded and quotes only the advertised count', () => {
    const running = ENTRIES.map((e) => ({
      ...e,
      status: 'playing' as const,
      position: undefined,
      prize: undefined,
      chips: 10000,
    }));
    const { container } = render(
      <RewardsTab {...props({ status: 'RUNNING', prize_pool_finalized: false }, running)} />
    );
    const text = container.textContent ?? '';
    expect(text).toContain('This Satellite Awards Tickets Into The Target Event');
    expect(tiles(container)).toMatchObject({ 'Seats Advertised': '1' });
    expect(text).not.toContain('63.52%');
    expect(text).not.toContain('515');
    expect(text).not.toContain('Money Bubble');
    expect(text).not.toContain('Qualified Players');
    expect(rows(container)).toHaveLength(0);
  });
});

describe('Rewards on an ordinary finished event', () => {
  it('still prints its ladder, its paid places and its bubble', () => {
    const { container } = render(
      <RewardsTab
        {...props({
          variant: 'standard',
          tournament_type: 'MTT',
          satellite_target_id: null,
          satellite_seats: null,
        })}
      />
    );
    const text = container.textContent ?? '';
    expect(text).toContain('2 Paid Places');
    expect(text).toContain('63.52%');
    expect(text).toContain('36.48%');
    expect(text).toContain('515');
    expect(text).toContain('295');
    expect(tiles(container)).toMatchObject({ 'Money Bubble': '3rd' });
    expect(text).not.toContain('Qualified Players');
    expect(text).not.toContain('Satellite Awards');
  });
});
