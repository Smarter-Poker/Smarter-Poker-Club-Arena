/**
 * THE ANTE TAG NAMES WHO PAYS IT (2026-09-26).
 *
 * The overview tagged an event "BB Ante" whenever big_blind_ante was on OR any
 * blind level carried an ante, so a per-player ante event (every seat antes;
 * HandController posts a big blind ante only when big_blind_ante is on) was
 * advertised as a big blind ante. The tag now follows the column.
 */
import { cleanup, render } from '@testing-library/react';
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

afterEach(cleanup);

const level = (n: number, ante: number) => ({
  level: n,
  smallBlind: 50 * n,
  bigBlind: 100 * n,
  ante,
  duration: 10,
  isBreak: false,
});

function event(bigBlindAnte: boolean, antes: number[]): TournamentTabProps {
  return {
    tournament: {
      id: 'event',
      name: 'Ante Event',
      status: 'REGISTERING',
      game_type: 'nlh',
      table_size: 9,
      starting_chips: 10000,
      current_players: 0,
      prize_pool: 0,
      big_blind_ante: bigBlindAnte,
      arena: { id: 'club', asset: 'chips', is_platform: false, union_id: null },
    } as unknown as TournamentTabProps['tournament'],
    entries: [] as unknown as TournamentTabProps['entries'],
    tables: [],
    blindLevels: antes.map((ante, i) => level(i + 1, ante)),
    isRegistered: false,
  };
}

const tags = (container: HTMLElement) =>
  [...container.querySelectorAll('.tl-badge')].map((el) => el.textContent);

function renderTags(props: TournamentTabProps) {
  const { container } = render(
    <MemoryRouter>
      <DetailOverviewTab {...props} />
    </MemoryRouter>
  );
  return tags(container);
}

describe('the overview ante tag follows who pays the ante', () => {
  it('a per-player ante ladder is an Ante, not a BB Ante', () => {
    const shown = renderTags(event(false, [0, 15, 30]));
    expect(shown).toContain('Ante');
    expect(shown).not.toContain('BB Ante');
  });

  it('a big blind ante event is a BB Ante whatever its ladder authors', () => {
    const shown = renderTags(event(true, [0, 15, 30]));
    expect(shown).toContain('BB Ante');
    expect(shown).not.toContain('Ante');
  });

  it('an event with no ante carries neither tag', () => {
    const shown = renderTags(event(false, [0, 0]));
    expect(shown).not.toContain('Ante');
    expect(shown).not.toContain('BB Ante');
  });
});
