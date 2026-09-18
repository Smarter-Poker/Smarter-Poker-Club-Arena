import React from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type {
  NormalisedBlindLevel,
  TournamentTabProps,
} from '../../src/components/tournament/details/types';

const maintenance = vi.hoisted(() => ({
  health: vi.fn(),
  lobby: new Set<(value: unknown) => void>(),
  status: new Set<(value: string) => void>(),
}));
vi.mock('../../src/services/GameServerAPI', () => ({ getServerStatus: maintenance.health }));
vi.mock('../../src/services/EngineStateClient', () => ({
  engineChannelClient: {
    onStatusChange: (callback: (value: string) => void) => {
      maintenance.status.add(callback);
      return () => maintenance.status.delete(callback);
    },
  },
}));
vi.mock('../../src/services/RealtimeChannelService', () => ({
  realtimeChannelService: {
    subscribeToTournament: () => () => {},
    subscribeToLobby: ({ onMaintenance }: { onMaintenance: (value: unknown) => void }) => {
      maintenance.lobby.add(onMaintenance);
      return () => maintenance.lobby.delete(onMaintenance);
    },
  },
}));
vi.mock('../../src/utils/serverClock', () => ({ serverNow: () => Date.now() }));
beforeEach(() => {
  maintenance.health.mockReset().mockResolvedValue(null);
  maintenance.lobby.clear();
  maintenance.status.clear();
});

vi.mock('../../src/components/tournament/details/useSatellites', () => ({
  useSatellites: () => ({
    cards: [],
    registration: {},
    loading: false,
    error: null,
    retry: vi.fn(),
  }),
}));
// Keep the real level reader: a mocked answer cannot expose projection/alias
// disagreement between the overview, the current-blinds card and stack BBs.
const { busHandlers } = vi.hoisted(() => ({
  busHandlers: new Map<string, (payload: any) => void>(),
}));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: (name: string, handler: (payload: any) => void) => {
    busHandlers.set(name, handler);
  },
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
import BlindsTab from '../../src/components/tournament/details/BlindsTab';
import RankingTab from '../../src/components/tournament/details/RankingTab';

afterEach(cleanup);
const level = (duration: number, bigBlind = 50, isBreak = false): NormalisedBlindLevel => ({
  level: 1,
  smallBlind: bigBlind / 2,
  bigBlind,
  ante: 0,
  duration,
  isBreak,
});

describe('live tournament tabs share the committed blind amounts', () => {
  const epoch = Date.parse('2026-09-17T18:11:00Z');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
    busHandlers.clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function running(snapshot: unknown, index = 369): TournamentTabProps {
    const levels = Array.from({ length: 40 }, (_, i) => ({
      ...level(8, i === 39 ? 4_000_000 : 200),
      level: i + 1,
      ante: i === 39 ? 500_000 : 20,
    }));
    const input = props(10_000, levels);
    return {
      ...input,
      currentUserId: 'hero',
      tournament: Object.freeze({
        ...input.tournament,
        status: 'RUNNING',
        started_at: new Date(epoch - 86_400_000).toISOString(),
        level_started_at: new Date(epoch - 60_000).toISOString(),
        current_level: index,
        blind_level_state: snapshot,
        // Include both spellings with the old schedule values. Current amount
        // normalization must not leave the overview's snake aliases stale.
        blind_structure: levels.map((row) => ({
          ...row,
          duration: row.duration * 60,
          small_blind: row.smallBlind,
          big_blind: row.bigBlind,
        })),
      }) as TournamentTabProps['tournament'],
      entries: [
        {
          id: 'entry',
          user_id: 'hero',
          username: 'Player',
          avatar_url: null,
          status: 'playing',
          chips: 1_050_000,
        },
      ],
    };
  }

  const views = [
    { name: 'Overview', Component: DetailOverviewTab },
    { name: 'Blinds', Component: BlindsTab },
    { name: 'Ranking', Component: RankingTab },
  ];
  const snapshot = { index: 369, small_blind: 52_500, big_blind: 105_000, ante: 105_000 };

  function expectAmounts(name: string, container: HTMLElement, known: boolean) {
    if (name === 'Overview') {
      const hero = container.querySelector('.dov-hero')!;
      expect(within(hero as HTMLElement).getByText('Level 370 Ends In')).toBeInTheDocument();
      expect(hero.querySelector('.dov-blind__value')?.textContent).toBe(known ? '53K / 105K' : '-');
      if (known) expect(within(hero as HTMLElement).getByText('Ante 105K')).toBeInTheDocument();
      else
        expect(
          within(hero as HTMLElement).getByText('Current Blinds Unavailable')
        ).toBeInTheDocument();
    } else if (name === 'Blinds') {
      const card = screen.getByRole('heading', { name: 'Current Level' }).closest('section')!;
      expect(within(card).getByText('Level 370')).toBeInTheDocument();
      if (known) {
        expect(card.querySelectorAll('.blinds-tab__blind-value')[0]?.textContent).toBe('52,500');
        expect(card.querySelectorAll('.blinds-tab__blind-value')[1]?.textContent).toBe('105,000');
        expect(card.querySelectorAll('.blinds-tab__blind-value')[2]?.textContent).toBe('105,000');
      } else expect(within(card).getByText('Current Blinds Unavailable')).toBeInTheDocument();
      expect(card.textContent).not.toContain('4,000,000');
      expect(within(card).getByText('7:00')).toBeInTheDocument();
    } else {
      expect(
        screen.getByText('Big Blinds').parentElement?.querySelector('.tl-num')?.textContent
      ).toBe(known ? '10' : '-');
      expect(screen.queryByText('0 BB')).toBeNull();
      if (known) expect(screen.getAllByText('10 BB').length).toBeGreaterThan(0);
    }
  }

  for (const { name, Component } of views) {
    it(`${name} displays the matching committed overflow instead of the final schedule row`, () => {
      const input = running(snapshot);
      const original = JSON.stringify(input);
      const rendered = render(
        <MemoryRouter>
          <Component {...input} />
        </MemoryRouter>
      );
      expectAmounts(name, rendered.container, true);
      expect(JSON.stringify(input)).toBe(original);
    });

    it.each([undefined, { ...snapshot, index: 368 }])(
      `${name} does not label a missing or stale overflow snapshot as current`,
      (state) => {
        const rendered = render(
          <MemoryRouter>
            <Component {...running(state)} />
          </MemoryRouter>
        );
        expectAmounts(name, rendered.container, false);
      }
    );
  }

  const flush = async () =>
    act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
  const emitMaintenance = (phase: string, extra = {}) =>
    act(() => {
      for (const listener of maintenance.lobby)
        listener({
          active: phase !== 'idle',
          phase,
          break_id: epoch - 60_000,
          timestamp: Date.now(),
          ...extra,
        });
    });
  const blindClock = () => screen.getByText('Blinds Up').closest('.tl-stat')!;

  it('keeps a recorded pause held across expiry and flag clear until its credited anchor arrives', async () => {
    const initial = running(snapshot);
    const paused: TournamentTabProps = {
      ...initial,
      tournament: {
        ...initial.tournament,
        on_break: true,
        break_started_at: new Date(epoch).toISOString(),
        break_ends_at: new Date(epoch + 60_000).toISOString(),
      },
    };
    const rendered = render(<DetailOverviewTab {...paused} />);
    await flush();
    expect(screen.getByText('Expected Resume In')).toBeInTheDocument();
    expect(rendered.container.querySelector('.dov-hero__time')?.textContent).toBe('1:00');
    expect(blindClock().textContent).toContain('Paused');
    expect(rendered.container.querySelector('.dov-hero__meter')).toBeNull();
    expect(rendered.container.querySelector('.dov-blind__value')?.textContent).toBe('53K / 105K');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(screen.getByText('Waiting For Resume')).toBeInTheDocument();
    expect(screen.queryByText('Level 370 Ends In')).toBeNull();
    const clearOnly = {
      ...paused,
      tournament: { ...paused.tournament, on_break: false, break_ends_at: null },
    };
    rendered.rerender(<DetailOverviewTab {...clearOnly} />);
    expect(screen.getByText('Waiting For Resume')).toBeInTheDocument();
    expect(blindClock().textContent).toContain('Paused');
    rendered.rerender(
      <DetailOverviewTab
        {...clearOnly}
        tournament={{
          ...clearOnly.tournament,
          level_started_at: new Date(epoch + 30_000).toISOString(),
        }}
      />
    );
    expect(screen.getByText('Level 370 Ends In')).toBeInTheDocument();
    expect(rendered.container.querySelector('.dov-hero__time')?.textContent).toBe('7:00');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(rendered.container.querySelector('.dov-hero__time')?.textContent).toBe('6:59');
  });

  it.each([null, 'not-a-time', new Date(epoch - 1000).toISOString()])(
    'does not release an event pause with an unknown or expired deadline: %s',
    async (deadline) => {
      const initial = running(snapshot);
      render(
        <DetailOverviewTab
          {...initial}
          tournament={{
            ...initial.tournament,
            on_break: true,
            break_started_at: new Date(epoch).toISOString(),
            break_ends_at: deadline,
          }}
        />
      );
      await flush();
      expect(screen.getByText('Waiting For Resume')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(blindClock().textContent).toContain('Paused');
      expect(screen.queryByText('Level 370 Ends In')).toBeNull();
    }
  );

  it('renders real maintenance hook phases without letting global release reopen an event pause', async () => {
    const initial = running(snapshot);
    const paused = {
      ...initial,
      tournament: {
        ...initial.tournament,
        on_break: true,
        break_started_at: new Date(epoch).toISOString(),
        break_ends_at: null,
      },
    };
    const rendered = render(<DetailOverviewTab {...paused} />);
    await flush();
    emitMaintenance('last_hand');
    expect(screen.getByText('Last Hand In Play')).toBeInTheDocument();
    emitMaintenance('counting_down', { break_ends_at: epoch + 1000 });
    expect(screen.getByText('Expected Resume In')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(screen.getByText('Finalizing Maintenance')).toBeInTheDocument();
    expect(maintenance.health).toHaveBeenCalledTimes(2);
    emitMaintenance('resuming');
    expect(screen.getByText('Resuming Tables')).toBeInTheDocument();
    maintenance.health.mockResolvedValue({
      maintenance: {
        presentation: {
          active: false,
          phase: 'idle',
          break_id: epoch - 60_000,
          timestamp: Date.now(),
        },
      },
    });
    act(() => {
      for (const listener of maintenance.status) listener('connected');
    });
    await flush();
    expect(screen.getByText('Waiting For Resume')).toBeInTheDocument();
    expect(blindClock().textContent).toContain('Paused');
    expect(rendered.container.querySelector('.dov-blind__value')?.textContent).toBe('53K / 105K');
  });

  it.each([null, 'invalid-anchor'])(
    'accepts the first committed resumed clock after an unknown paused anchor: %s',
    async (anchor) => {
      const input = running(snapshot);
      const paused = {
        ...input,
        tournament: { ...input.tournament, on_break: true, level_started_at: anchor },
      };
      const rendered = render(<DetailOverviewTab {...paused} />);
      await flush();
      expect(blindClock().textContent).toContain('Paused');
      const clearOnly = { ...paused, tournament: { ...paused.tournament, on_break: false } };
      rendered.rerender(<DetailOverviewTab {...clearOnly} />);
      expect(blindClock().textContent).toContain('Paused');
      rendered.rerender(
        <DetailOverviewTab
          {...clearOnly}
          tournament={{
            ...clearOnly.tournament,
            level_started_at: new Date(epoch - 60_000).toISOString(),
          }}
        />
      );
      expect(screen.getByText('Level 370 Ends In')).toBeInTheDocument();
      expect(rendered.container.querySelector('.dov-hero__time')?.textContent).toBe('7:00');
      expect(rendered.container.querySelector('.dov-blind__value')?.textContent).toBe('53K / 105K');
    }
  );

  it('does not carry a held clock into another tournament or completed results', async () => {
    const input = running(snapshot);
    const paused = { ...input, tournament: { ...input.tournament, on_break: true } };
    const rendered = render(<DetailOverviewTab {...paused} />);
    await flush();
    expect(blindClock().textContent).toContain('Paused');
    rendered.rerender(
      <DetailOverviewTab
        {...input}
        tournament={{ ...input.tournament, id: 'another-event', on_break: false }}
      />
    );
    expect(screen.getByText('Level 370 Ends In')).toBeInTheDocument();
    expect(rendered.container.querySelector('.dov-hero__time')?.textContent).toBe('7:00');
    rendered.rerender(<DetailOverviewTab {...paused} />);
    expect(blindClock().textContent).toContain('Paused');
    rendered.rerender(
      <DetailOverviewTab {...paused} tournament={{ ...paused.tournament, status: 'COMPLETED' }} />
    );
    expect(screen.queryByText('Waiting For Resume')).toBeNull();
    expect(screen.queryByText('Level 370 Clock Paused')).toBeNull();
    expect(blindClock().textContent).toContain('-');
  });

  it('announces the global last hand without freezing a tournament that has not paused', async () => {
    const rendered = render(<DetailOverviewTab {...running(snapshot)} />);
    await flush();
    emitMaintenance('last_hand');
    expect(
      screen.getByText('Maintenance Break Starting. Tables Are Finishing Their Current Hand.')
    ).toBeInTheDocument();
    expect(screen.getByText('Level 370 Ends In')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(rendered.container.querySelector('.dov-hero__time')?.textContent).toBe('6:59');
  });

  it('refreshes ranking BBs when a receipt changes without a level-index change', () => {
    const input = running(snapshot);
    const rendered = render(
      <MemoryRouter>
        <RankingTab {...input} />
      </MemoryRouter>
    );
    expectAmounts('Ranking', rendered.container, true);
    rendered.rerender(
      <MemoryRouter>
        <RankingTab {...running({ ...snapshot, big_blind: 210_000 })} />
      </MemoryRouter>
    );
    expect(
      screen.getByText('Big Blinds').parentElement?.querySelector('.tl-num')?.textContent
    ).toBe('5');
  });

  it.each([
    { state: undefined, sb: '100', bb: '200', ante: '20', stackBb: '5,250' },
    {
      state: { index: 0, small_blind: 50, big_blind: 100, ante: 0 },
      sb: '50',
      bb: '100',
      ante: '0',
      stackBb: '10,500',
    },
  ])(
    'preserves legacy in-ladder amounts and honors a matching receipt with zero ante',
    ({ state, sb, bb, ante, stackBb }) => {
      const input = running(state, 0);
      const overview = render(<DetailOverviewTab {...input} />);
      expect(overview.container.querySelector('.dov-blind__value')?.textContent).toBe(
        `${sb} / ${bb}`
      );
      expect(overview.container.querySelector('.dov-blind__ante')?.textContent).toBe(
        ante === '0' ? 'No Ante' : `Ante ${ante}`
      );
      overview.unmount();

      const blinds = render(<BlindsTab {...input} />);
      const card = screen.getByRole('heading', { name: 'Current Level' }).closest('section')!;
      expect(
        [...card.querySelectorAll('.blinds-tab__blind-value')].map((node) => node.textContent)
      ).toEqual([sb, bb, ante]);
      expect(within(card).getByText('Level 1')).toBeInTheDocument();
      blinds.unmount();

      render(
        <MemoryRouter>
          <RankingTab {...input} />
        </MemoryRouter>
      );
      expect(
        screen.getByText('Big Blinds').parentElement?.querySelector('.tl-num')?.textContent
      ).toBe(stackBb);
    }
  );

  it.each(
    ['PAUSED', 'LATE_REG', 'COMPLETED'].flatMap((status) =>
      ['receipt', 'legacy'].map((amountSource) => ({ status, amountSource }))
    )
  )(
    'preserves $status current amounts from $amountSource independently of the running clock',
    ({ status, amountSource }) => {
      const input = running(
        amountSource === 'receipt'
          ? { index: 5, small_blind: 250, big_blind: 500, ante: 0 }
          : undefined,
        5
      );
      const levels = input.blindLevels.map((row, index) =>
        index === 5 ? { ...row, smallBlind: 500, bigBlind: 1_000, ante: 100 } : row
      );
      const atCurrentLevel: TournamentTabProps = {
        ...input,
        blindLevels: levels,
        tournament: {
          ...input.tournament,
          status,
          blind_structure: levels.map((row) => ({ ...row, duration: row.duration * 60 })),
        } as TournamentTabProps['tournament'],
      };
      const blinds = render(<BlindsTab {...atCurrentLevel} />);
      const card = screen.getByRole('heading', { name: 'Current Level' }).closest('section')!;
      expect(within(card).getByText('Level 6')).toBeInTheDocument();
      expect(
        [...card.querySelectorAll('.blinds-tab__blind-value')].map((node) => node.textContent)
      ).toEqual(amountSource === 'receipt' ? ['250', '500', '0'] : ['500', '1,000', '100']);
      if (status === 'PAUSED') expect(card.querySelector('.tl-clock--paused')).not.toBeNull();
      if (status === 'COMPLETED') expect(within(card).getByText('Complete')).toBeInTheDocument();
      blinds.unmount();
      render(
        <MemoryRouter>
          <RankingTab {...atCurrentLevel} />
        </MemoryRouter>
      );
      expect(
        screen.getByText('Big Blinds').parentElement?.querySelector('.tl-num')?.textContent
      ).toBe(amountSource === 'receipt' ? '2,100' : '1,050');
    }
  );

  it('does not relabel a prior receipt when a level-only bus event precedes the row', () => {
    const rendered = render(<BlindsTab {...running(snapshot)} />);
    act(() =>
      busHandlers.get('BLIND_LEVEL_CHANGE')?.({ tournamentId: 'structure-event', level: 371 })
    );
    const card = screen.getByRole('heading', { name: 'Current Level' }).closest('section')!;
    expect(within(card).getByText('Level 371')).toBeInTheDocument();
    expect(within(card).getByText('Current Blinds Unavailable')).toBeInTheDocument();
    rendered.rerender(<BlindsTab {...running({ ...snapshot, index: 370 }, 370)} />);
    expect(within(card).getByText('52,500')).toBeInTheDocument();
    expect(within(card).queryByText('Current Blinds Unavailable')).toBeNull();
  });

  it('preserves table-backed ranking BBs when no ladder or receipt exists', () => {
    const input = running(undefined, 0);
    const withoutLadder: TournamentTabProps = {
      ...input,
      tournament: { ...input.tournament, blind_structure: [] },
      blindLevels: [],
      tables: [
        {
          id: 'table',
          name: 'Table 1',
          status: 'running',
          max_players: 9,
          current_players: 1,
          small_blind: 250,
          big_blind: 500,
        },
      ],
    };
    const rendered = render(
      <MemoryRouter>
        <RankingTab {...withoutLadder} />
      </MemoryRouter>
    );
    expect(
      screen.getByText('Big Blinds').parentElement?.querySelector('.tl-num')?.textContent
    ).toBe('2,100');
    rendered.rerender(
      <MemoryRouter>
        <RankingTab {...withoutLadder} tables={[]} />
      </MemoryRouter>
    );
    expect(
      screen.getByText('Big Blinds').parentElement?.querySelector('.tl-num')?.textContent
    ).toBe('-');
  });
});
function props(startingChips: number, blindLevels: NormalisedBlindLevel[]): TournamentTabProps {
  return {
    tournament: Object.freeze({
      id: 'structure-event',
      name: 'Structure Event',
      status: 'ANNOUNCED',
      game_type: 'nlh',
      table_size: 9,
      starting_chips: startingChips,
      current_players: 0,
      blind_structure: blindLevels.map((b) => ({ ...b, duration: b.duration * 60 })),
    }) as unknown as TournamentTabProps['tournament'],
    entries: [],
    tables: [],
    blindLevels,
    isRegistered: false,
  };
}
const value = (label: string) =>
  screen.getByText(label, { selector: 'dt' }).parentElement!.querySelector('dd')!.textContent;

describe('Overview displays engine structure facts without changing tournament rules', () => {
  it.each([
    { minutes: 2, bb: 100, stack: 5000, speed: 'Hyper Turbo', depth: '50 BB' },
    { minutes: 15, bb: 50, stack: 1000, speed: 'Slow', depth: '20 BB' },
    { minutes: 10, bb: 50, stack: 30000, speed: 'Regular', depth: '600 BB' },
    { minutes: 3, bb: 20, stack: 1000, speed: 'Turbo', depth: '50 BB' },
  ])('shows $speed and $depth independently', ({ minutes, bb, stack, speed, depth }) => {
    const input = props(stack, [level(minutes, bb)]);
    const original = JSON.stringify(input);
    render(<DetailOverviewTab {...input} />);
    expect(value('Structure')).toBe(speed);
    expect(value('Starting Stack')).toContain(depth);
    expect(value('Levels')).toBe(`${minutes} Min`);
    expect(screen.queryByText('Deep Stack')).toBeNull();
    expect(JSON.stringify(input)).toBe(original);
  });

  it('skips leading breaks and displays the full taper with its opening clock', () => {
    render(<DetailOverviewTab {...props(10000, [level(5, 0, true), level(10), level(5, 100)])} />);
    expect(value('Structure')).toBe('Regular');
    expect(value('Starting Stack')).toBe('10,000 · 200 BB');
    expect(value('Levels')).toBe('10 Min Opening · 5-10 Min Range');
  });

  it('keeps unknown opening clock and depth unconfirmed', () => {
    render(<DetailOverviewTab {...props(1000, [level(0, 0), level(10, 100)])} />);
    expect(value('Structure')).toBe('Unconfirmed');
    expect(value('Levels')).toBe('Unconfirmed');
    expect(value('Starting Stack')).toBe('1,000');
  });

  it('does not advertise a fixed clock when a later level lacks duration', () => {
    render(<DetailOverviewTab {...props(10000, [level(10), level(0, 100)])} />);
    expect(value('Levels')).toBe('10 Min Opening');
  });

  it('updates facts directly with new server-provided configuration', () => {
    const first = props(1000, [level(15)]);
    const next = props(30000, [level(2, 100)]);
    const originals = [JSON.stringify(first), JSON.stringify(next)];
    const rendered = render(<DetailOverviewTab {...first} />);
    expect(value('Structure')).toBe('Slow');
    rendered.rerender(<DetailOverviewTab {...next} />);
    expect(value('Structure')).toBe('Hyper Turbo');
    expect(value('Starting Stack')).toBe('30,000 · 300 BB');
    expect([JSON.stringify(first), JSON.stringify(next)]).toEqual(originals);
  });
});
