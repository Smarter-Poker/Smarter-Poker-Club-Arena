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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const start = '2026-10-30T20:00:00.000Z';
function props(size = 6, overrides: Record<string, unknown> = {}): TournamentTabProps {
  return {
    tournament: {
      id: 'event',
      name: 'SNG Satellite',
      status: 'REGISTERING',
      tournament_type: 'sng',
      variant: 'sng',
      format_contract: 'sng-v1',
      max_players: size,
      min_players: size,
      table_size: size,
      satellite_seats: 2,
      satellite_target_id: 'target',
      start_time: start,
      starting_chips: 10000,
      game_type: 'nlh',
      current_players: 0,
      prize_pool: 0,
      arena: { id: 'club', asset: 'chips', is_platform: false, union_id: null },
      ...overrides,
    } as unknown as TournamentTabProps['tournament'],
    entries: [],
    tables: [],
    blindLevels: [],
    isRegistered: false,
  };
}
function show(p: TournamentTabProps) {
  return render(
    <MemoryRouter>
      <DetailOverviewTab {...p} />
    </MemoryRouter>
  );
}
describe('fixed SNG Details start semantics', () => {
  it.each([6, 9])('shows When Full in the hero, note and Starts field for %i seats', (size) => {
    const { container } = show(props(size));
    expect(container.querySelector('.dov-hero__time')?.textContent).toBe('When Full');
    expect(container.querySelector('.dov-hero__eyebrow')?.textContent).toBe('Starts');
    expect(container.querySelector('.dov-hero__note')?.textContent).toBe('0 Registered');
    const starts = [...container.querySelectorAll('.dov-info__item')].find(
      (n) => n.querySelector('dt')?.textContent === 'Starts'
    );
    expect(starts?.querySelector('dd')?.textContent).toBe('When Full');
    expect(container.querySelector('.dov-hero')?.textContent).not.toContain('Oct 30');
  });
  it('does not start a wall-clock countdown heartbeat while waiting for the field', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-30T19:00:00.000Z'));
    const interval = vi.spyOn(globalThis, 'setInterval');
    show(props());
    expect(interval.mock.calls.filter((call) => call[1] === 1000)).toHaveLength(0);
    interval.mockRestore();
  });
  it.each([
    { format_contract: 'mtt-v2', tournament_type: 'satellite', variant: 'satellite' },
    { satellite_seats: 1 },
  ])(
    'preserves scheduled countdowns unless the exact fixed contract qualifies: %j',
    (overrides) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-30T19:00:00.000Z'));
      const { container } = show(props(6, overrides));
      expect(container.querySelector('.dov-hero__eyebrow')?.textContent).toBe('Starts In');
      expect(container.querySelector('.dov-hero__time')?.textContent).toBe('1:00:00');
      expect(container.querySelector('.dov-hero__note')?.textContent).toContain('Oct 30');
      expect(container.textContent).not.toContain('When Full');
    }
  );
  it('keeps actual Started time and running level behavior after the fixed SNG starts', () => {
    const { container } = show(props(6, { status: 'RUNNING', started_at: start }));
    expect(container.querySelector('.dov-hero__note')?.textContent).toContain('Running Since');
    expect(container.querySelector('.dov-hero__eyebrow')?.textContent).not.toBe('Starts');
    const started = [...container.querySelectorAll('.dov-info__item')].find(
      (n) => n.querySelector('dt')?.textContent === 'Started'
    );
    expect(started?.querySelector('dd')?.textContent).toContain('Oct 30');
  });
});
