/**
 * THE LOBBY NAMES WHO FINISHED WHERE, AND WHO WON WHAT (Dan 2026-10-24).
 *
 *   "ON THE REWARDS PAGE, IT SHOULD SHOW THE PLAYERS AND WHAT POSITION THE
 *    BUSTED IN UNDER RANKING, AND WHAT PLAYERS WON WHAT PRIZES UNDER REWARDS"
 *
 * Friday Fight Night PKO (827A1B52) finished with all 276 finishing positions
 * and 35 prizes recorded on tournament_players. Rewards printed "1st 17.32%
 * 1,741" with no name on any row; Ranking printed every busted player as a
 * faint "Finished 61st" beside a stack of "0 / 0 BB", and the champion - whose
 * status is `winner`, which isPlayerOut does not count - as "Not Seated Yet".
 */
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  TournamentEntry,
  TournamentTabProps,
} from '../../src/components/tournament/details/types';

vi.mock('../../src/lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/tournament/MysteryBountyPanel', () => ({ default: () => null }));
vi.mock('../../src/services/RealtimeChannelService', () => ({
  realtimeChannelService: {
    subscribeToTournament: () => () => {},
    subscribeToLobby: () => () => {},
  },
}));
vi.mock('../../src/utils/serverClock', () => ({ serverNow: () => Date.now() }));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: () => {},
}));
vi.mock('../../src/components/tournament/details/useDownlineIds', () => ({
  useDownlineIds: () => ({ downlineIds: new Set(), carriesDownline: false }),
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => ({ info: vi.fn() }) }));

import RewardsTab from '../../src/components/tournament/details/RewardsTab';
import RankingTab from '../../src/components/tournament/details/RankingTab';

afterEach(cleanup);

const entry = (
  i: number,
  status: TournamentEntry['status'],
  position?: number,
  prize = 0,
  chips = 0
): TournamentEntry =>
  ({
    id: `p${i}`,
    user_id: `u${i}`,
    username: `player${i}`,
    avatar_url: null,
    status,
    position,
    prize,
    chips,
  }) as TournamentEntry;

function props(
  entries: TournamentEntry[],
  structure: number[],
  overrides: Record<string, unknown> = {}
): TournamentTabProps {
  return {
    tournament: {
      id: 't-1',
      name: 'Friday Fight Night',
      status: 'COMPLETED',
      format_contract: 'mtt-v2',
      tournament_type: 'MTT',
      current_players: 0,
      prize_pool: 1000,
      prize_pool_finalized: true,
      guaranteed_prize: 0,
      buy_in_amount: 100,
      buy_in_fee: 0,
      payout_structure: JSON.stringify(
        structure.map((percentage, k) => ({ place: k + 1, percentage }))
      ),
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

const ladder = (c: HTMLElement) =>
  [...c.querySelectorAll('.rw-list .rw-row')].map((row) => [
    row.querySelector('.rw-rank')?.textContent ?? '',
    row.querySelector('.rw-who__name')?.textContent ?? '',
    row.querySelector('.rw-prize')?.textContent ?? '',
  ]);

/* A finished ten-player event paying three places. The recorded 2nd is 299.98
   (a residual), which is what the wallet holds and what Rewards must print. */
const FINISHED = [
  entry(1, 'winner', 1, 500, 10000),
  entry(2, 'eliminated', 2, 299.98),
  entry(3, 'eliminated', 3, 200),
  ...Array.from({ length: 7 }, (_, k) => entry(4 + k, 'eliminated', 4 + k)),
];

describe('Rewards says which player won which prize', () => {
  it('names every paid place and prints what was actually paid', () => {
    const { container } = render(<RewardsTab {...props(FINISHED, [50, 30, 20])} />);
    expect(ladder(container)).toEqual([
      ['1st', 'player1', '500'],
      ['2nd', 'player2', '300'],
      ['3rd', 'player3', '200'],
    ]);
  });

  it('opens a shared band once anyone in it has finished, so each name has its row', () => {
    /* Places 2-4 share 20%. Mid-event, 4th and 3rd have busted; 2nd is open. */
    const running = [
      entry(1, 'playing', undefined, 0, 6000),
      entry(2, 'playing', undefined, 0, 4000),
      entry(3, 'eliminated', 3, 200),
      entry(4, 'eliminated', 4, 200),
    ];
    const { container } = render(
      <RewardsTab
        {...props(running, [40, 20, 20, 20], { status: 'RUNNING', prize_pool_finalized: false })}
      />
    );
    const rows = ladder(container);
    expect(rows.map((r) => r[0])).toEqual(['1st', '2nd', '3rd', '4th']);
    expect(rows[0][1]).toBe('');
    expect(rows[1][1]).toBe('');
    expect(rows[2][1]).toBe('player3');
    expect(rows[3][1]).toBe('player4');
  });

  it('keeps a band whole while nobody in it has finished', () => {
    const live = [entry(1, 'playing', undefined, 0, 6000), entry(2, 'playing', undefined, 0, 4000)];
    const { container } = render(
      <RewardsTab
        {...props(live, [40, 20, 20, 20], { status: 'RUNNING', prize_pool_finalized: false })}
      />
    );
    expect(ladder(container).map((r) => r[0])).toEqual(['1st', '2-4']);
    expect(container.querySelector('.rw-who__name')).toBeNull();
  });
});

describe('Ranking says what position each player busted in', () => {
  const rows = (c: HTMLElement) =>
    [...c.querySelectorAll('.rk-item')].map((row) => ({
      name: row.querySelector('.tl-name')?.textContent ?? '',
      sub: row.querySelector('.rk-sub')?.textContent ?? '',
      nums: row.querySelector('.rk-nums')?.textContent ?? '',
    }));

  it('the champion reads Winner with the prize, never Not Seated Yet', () => {
    const { container } = render(
      <MemoryRouter>
        <RankingTab {...props(FINISHED, [50, 30, 20])} />
      </MemoryRouter>
    );
    const [first] = rows(container);
    expect(first).toEqual({ name: 'player1', sub: 'Winner', nums: '500Won' });
  });

  it('a busted player reads Busted Nth, with what they won or nothing at all', () => {
    const { container } = render(
      <MemoryRouter>
        <RankingTab {...props(FINISHED, [50, 30, 20])} />
      </MemoryRouter>
    );
    const all = rows(container);
    expect(all[1]).toEqual({ name: 'player2', sub: 'Busted 2nd', nums: '300Won' });
    expect(all[3]).toEqual({ name: 'player4', sub: 'Busted 4th', nums: '' });
    expect(container.textContent).not.toContain('0 BB');
    expect(container.textContent).not.toContain('Not Seated Yet');
  });
});
