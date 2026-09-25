/**
 * THE DETAIL TAB'S PODIUM AND BOUNTY ROW SPEAK THE EVENT'S UNIT (2026-09-21).
 *
 * #4954 moved this tab's place ladder and its top mystery chest onto the
 * event's unit. Two figures were left behind: the Final Results podium printed
 * "Chips" after every prize, and the Bounty row printed a bare head. A chip
 * event reads exactly as it did; a Diamond event reads whole Diamonds, named.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { TournamentTabProps } from '../../src/components/tournament/details/types';

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
import { compactChips } from '../../src/utils/format';

afterEach(cleanup);

/** The three columns `fn_ca_tournament_unit_cents` tests, as the embed carries them. */
const CHIP_CLUB = { id: 'club', asset: 'chips', is_platform: false, union_id: null };
const DIAMOND_ARENA = { id: 'arena', asset: 'diamonds', is_platform: true, union_id: null };

function completedBountyEvent(arena: typeof CHIP_CLUB): TournamentTabProps {
  return {
    tournament: {
      id: 'event',
      name: 'Bounty Event',
      status: 'COMPLETED',
      game_type: 'nlh',
      table_size: 9,
      starting_chips: 10000,
      current_players: 0,
      prize_pool: 2250,
      is_bounty: true,
      bounty_amount: 5,
      started_at: '2026-09-20T18:00:00.000Z',
      ended_at: '2026-09-20T21:00:00.000Z',
      arena,
    } as unknown as TournamentTabProps['tournament'],
    entries: [
      { id: 'e1', user_id: 'u1', username: 'First', status: 'winner', position: 1, prize: 1250 },
      {
        id: 'e2',
        user_id: 'u2',
        username: 'Second',
        status: 'eliminated',
        position: 2,
        prize: 700,
      },
      { id: 'e3', user_id: 'u3', username: 'Third', status: 'eliminated', position: 3, prize: 300 },
    ] as unknown as TournamentTabProps['entries'],
    tables: [],
    blindLevels: [],
    isRegistered: false,
  };
}

function renderTab(props: TournamentTabProps) {
  return render(
    <MemoryRouter>
      <DetailOverviewTab {...props} />
    </MemoryRouter>
  );
}

const podium = (container: HTMLElement) =>
  [...container.querySelectorAll('.dov-podium__prize')].map((el) => el.textContent);
const fact = (label: string) =>
  screen.getByText(label, { selector: 'dt' }).parentElement!.querySelector('dd')!.textContent;

describe('the detail tab speaks the event unit', () => {
  it('a chip event prints its podium and its head exactly as before', () => {
    const { container } = renderTab(completedBountyEvent(CHIP_CLUB));
    expect(podium(container)).toEqual([
      `${compactChips(1250)} Chips`,
      `${compactChips(700)} Chips`,
      `${compactChips(300)} Chips`,
    ]);
    expect(fact('Bounty')).toBe('5 per KO');
  });

  it('a Diamond event prints whole Diamonds on the podium and names the head', () => {
    const { container } = renderTab(completedBountyEvent(DIAMOND_ARENA));
    expect(podium(container)).toEqual(['1,250 Diamonds', '700 Diamonds', '300 Diamonds']);
    expect(fact('Bounty')).toBe('5 Diamonds per KO');
    expect(container.querySelector('.dov-podium')?.textContent).not.toMatch(/Chips/);
  });

  it('a PKO row keeps its split rule after the head at either unit', () => {
    const chip = completedBountyEvent(CHIP_CLUB);
    (chip.tournament as unknown as Record<string, unknown>).is_pko = true;
    renderTab(chip);
    expect(fact('Bounty')).toBe('5 per KO - 50% to knocker, 50% to bounty');
    cleanup();

    const diamond = completedBountyEvent(DIAMOND_ARENA);
    (diamond.tournament as unknown as Record<string, unknown>).is_pko = true;
    renderTab(diamond);
    expect(fact('Bounty')).toBe('5 Diamonds per KO - 50% to knocker, 50% to bounty');
  });
});
