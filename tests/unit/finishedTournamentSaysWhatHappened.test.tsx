/**
 * A FINISHED TOURNAMENT SAYS WHAT HAPPENED (2026-10-04).
 *
 * Dan opened the lobby of a satellite that had ended eight hours earlier and
 * sent what three of its tabs said at once:
 *
 *   Tables   "Players Left 7, Average Stack 25.7K"
 *   Ranking  "Remaining 0, Average Stack 0, Total Chips 0"
 *   Detail   "Results Are Being Finalised. Check Back In A Moment."
 *
 * with "make all the tournament lobby buttons and stats fully functional".
 * The event was FE93D011: 18 entries, a pool of 810, seven players recorded as
 * `winner` with no finishing position (a satellite's seat winners tie), 8th and
 * 9th paid, the rest out. The fixture below is that event.
 *
 * Three separate causes, all pinned here:
 *   1. Detail built its results from positions 1 to 3, and a satellite's
 *      winners have none, so it reported finished results as pending for ever.
 *   2. Detail counted the seat winners as "remaining" while Ranking counted
 *      nobody, and each printed live-event tiles about an event that was over.
 *   3. The shell kept the last table rows it had read while the event was
 *      dealing and went on showing them after it finished (pinned on the
 *      shell's source, at the foot of this file).
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  TournamentEntry,
  TournamentTabProps,
} from '../../src/components/tournament/details/types';

vi.mock('../../src/services/GameServerAPI', () => ({ getServerStatus: vi.fn(async () => null) }));
vi.mock('../../src/services/EngineStateClient', () => ({
  engineChannelClient: { onStatusChange: () => () => {} },
}));
vi.mock('../../src/services/RealtimeChannelService', () => ({
  realtimeChannelService: {
    subscribeToTournament: () => () => {},
    subscribeToLobby: () => () => {},
  },
}));
vi.mock('../../src/utils/serverClock', () => ({ serverNow: () => Date.now() }));
vi.mock('../../src/components/tournament/details/useSatellites', () => ({
  useSatellites: () => ({
    cards: [],
    registration: {},
    loading: false,
    error: null,
    retry: vi.fn(),
  }),
}));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: () => {},
}));
vi.mock('../../src/components/tournament/details/useDownlineIds', () => ({
  useDownlineIds: () => ({ downlineIds: new Set(), carriesDownline: false }),
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => ({ info: vi.fn() }) }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/MysteryBountyService', () => ({
  activationStatusLine: () => '',
  formatCents: String,
  topBountyCents: () => 0,
}));
vi.mock('../../src/components/tournament/RegistrationApprovalsPanel', () => ({
  default: () => null,
}));
vi.mock('../../src/components/tournament/TournamentDealReview', () => ({ default: () => null }));
vi.mock('../../src/components/tournament/TournamentLobbyCard', () => ({ default: () => null }));
vi.mock('../../src/components/tournament/HandForHandBanner', () => ({
  HandForHandBanner: () => null,
}));

import DetailOverviewTab from '../../src/components/tournament/details/DetailOverviewTab';
import RankingTab from '../../src/components/tournament/details/RankingTab';
import { finishedFieldSummary } from '../../src/components/tournament/details/types';

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
    player_code: null,
    chips,
    position,
    prize,
    status,
    table_id: null,
    created_at: null,
    rebuys: 0,
    add_ons: 0,
    is_satellite_qualifier: false,
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

function finishedSatellite(entries: TournamentEntry[] = ENTRIES): TournamentTabProps {
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
      game_type: 'NLH',
      table_size: 9,
      starting_chips: 10000,
      current_players: 0,
      current_level: 14,
      prize_pool: 810,
      guaranteed_prize: 0,
      buy_in_amount: 45,
      buy_in_fee: 5,
      payout_structure: JSON.stringify([
        { place: 1, percentage: 63.52 },
        { place: 2, percentage: 36.48 },
      ]),
      started_at: '2026-10-03T18:19:10.409+00:00',
      ended_at: '2026-10-04T01:43:06.256+00:00',
      arena: { id: 'club', asset: 'chips', is_platform: false, union_id: null },
    } as unknown as TournamentTabProps['tournament'],
    entries,
    tables: [],
    blindLevels: [
      { level: 1, smallBlind: 25, bigBlind: 50, ante: 6, duration: 4, isBreak: false },
      { level: 2, smallBlind: 30, bigBlind: 60, ante: 8, duration: 4, isBreak: false },
    ],
    currentUserId: 'nobody',
    isRegistered: false,
  };
}

const tiles = (container: HTMLElement) =>
  Object.fromEntries(
    [...container.querySelectorAll('.tl-stat')].map((tile) => [
      tile.querySelector('.tl-stat__label')?.textContent ?? '',
      tile.querySelector('.tl-stat__value')?.textContent ?? '',
    ])
  );

describe('the summary of a finished field', () => {
  it('counts entries, recorded seat winners and recorded prizes', () => {
    const props = finishedSatellite();
    expect(finishedFieldSummary(props.tournament, props.entries)).toEqual({
      entries: 18,
      qualified: 7,
      paid: 9,
    });
  });

  it('does not call a running event winner a seat winner', () => {
    const props = finishedSatellite();
    const running = { ...props.tournament, status: 'RUNNING' } as typeof props.tournament;
    expect(finishedFieldSummary(running, props.entries).qualified).toBe(0);
  });

  it('reports no paid places rather than inventing them when none are recorded', () => {
    const props = finishedSatellite(ENTRIES.map((e) => ({ ...e, prize: undefined })));
    expect(finishedFieldSummary(props.tournament, props.entries).paid).toBe(0);
  });
});

describe('Detail on a finished satellite', () => {
  const view = () =>
    render(
      <MemoryRouter>
        <DetailOverviewTab {...finishedSatellite()} />
      </MemoryRouter>
    ).container;

  it('lists the seat winners instead of saying results are pending', () => {
    const container = view();
    expect(container.textContent).not.toMatch(/Being Finalised/i);
    const winners = [...container.querySelectorAll('.dov-finisher--qualified')].map(
      (row) => row.querySelector('.dov-finisher__name')?.textContent
    );
    // In name order: they tied, so there is no rank among them to print.
    expect(winners).toEqual([
      'CactusDenim',
      'DCDonkey',
      'float',
      'LoneDrawFox',
      'OldPriya',
      'slow_cocoa',
      'TURN',
    ]);
  });

  it('lists under "In The Money" only the players who were paid', () => {
    const container = view();
    const paid = [...container.querySelectorAll('.dov-finisher:not(.dov-finisher--qualified)')].map(
      (row) => row.querySelector('.dov-finisher__name')?.textContent
    );
    expect(paid).toEqual(['areyes', 'tali']);
  });

  it('prints what happened, and no live-event tile', () => {
    const shown = tiles(view());
    expect(shown).toMatchObject({ Entries: '18', 'Prize Pool': '810', Qualified: '7' });
    for (const live of ['Remaining', 'Avg Stack', 'Total Chips', 'Tables', 'Blinds Up']) {
      expect(shown, `a finished event still prints the live tile "${live}"`).not.toHaveProperty(
        live
      );
    }
  });
});

describe('Ranking on a finished satellite', () => {
  it('agrees with Detail, figure for figure', () => {
    const { container } = render(
      <MemoryRouter>
        <RankingTab {...finishedSatellite()} />
      </MemoryRouter>
    );
    const shown = tiles(container);
    expect(shown).toMatchObject({ Entries: '18', 'Prize Pool': '810', Qualified: '7' });
    expect(shown).not.toHaveProperty('Remaining');
    expect(shown).not.toHaveProperty('Average Stack');
  });

  it('keeps the live tiles while the event is still running', () => {
    const props = finishedSatellite(
      ENTRIES.map((e) => (e.status === 'winner' ? { ...e, status: 'playing' as const } : e))
    );
    const { container } = render(
      <MemoryRouter>
        <RankingTab
          {...props}
          tournament={{ ...props.tournament, status: 'RUNNING' } as typeof props.tournament}
        />
      </MemoryRouter>
    );
    expect(tiles(container)).toMatchObject({ Remaining: '7' });
  });
});

describe('the shell does not show a finished event its old tables', () => {
  const PAGE = readFileSync(
    join(process.cwd(), 'src/pages/tournament/TournamentDetails.tsx'),
    'utf8'
  );

  it('hands the tabs a table list only while the event is dealing', () => {
    expect(PAGE).toContain('tables: isWatchable ? tables : NO_TABLES,');
    expect(PAGE).toContain('const NO_TABLES: TournamentTable[] = [];');
  });
});
