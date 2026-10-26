/**
 * LIGHTNING TRANSITION, PHASE 5 OF 5 (2026-10-26): THE LOBBY SAYS WHEN A GAME
 * IS SWITCHING.
 *
 * Measured on production: while a game was in pending_off or draining the card
 * still said LIGHTNING LIVE and its door was Join Game, which seated the player
 * at a halted table until the commit (up to 80 s); in pending_on the card said
 * MUST MOVE and Join Game bought into a halted table (up to 146 s).
 *
 * Now: pending_on says Lightning Starting, pending_off and draining say
 * Lightning Ending, and on every lobby surface (the card, the board row and
 * the game panel) the Join Game door is shown and disabled, with no other new
 * text. Nobody is moved anywhere. A seated player still returns to their seat.
 * Classic games and Short Deck / Omaha Hi-Lo / Pineapple must-move games
 * (which never run Lightning) are unchanged in every mode.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArenaLobbyGameCard,
  arenaGameCardActionsForEntry,
} from '../../src/components/lobby/game-cards/ArenaLobbyGameCard';
import { columnsFor } from '../../src/components/lobby/LobbyTable';
import GameLobbyPanel from '../../src/components/lobby/GameLobbyPanel';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';
import type { LobbyRowContext } from '../../src/components/lobby/lobbyCardContext';
import {
  clusterModeDisplay,
  lightningLobbyBadge,
  lightningSwitchingOf,
  parseLightningLobbyState,
} from '../../src/lightning/lightningLobby';

vi.mock('../../src/services/tableWarmup', () => ({
  warmTable: vi.fn(),
  observeLobbyTableWarmups: () => () => {},
}));
vi.mock('../../src/services/WaitlistService', () => ({
  waitlistService: { getTableWaitlist: vi.fn(async () => []) },
}));
vi.mock('../../src/services/TableService', () => ({
  tableService: { getAveragePot: vi.fn(async () => null) },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const q: any = {};
      for (const m of ['select', 'eq', 'is', 'order', 'limit', 'maybeSingle']) q[m] = () => q;
      q.then = (r: any) => Promise.resolve({ data: [], error: null }).then(r);
      return q;
    },
  },
}));
vi.mock('../../src/hooks/useSpinTierAvailability', () => ({
  useSpinTierAvailability: () => ({ can_draw_100x: false }),
}));
afterEach(cleanup);

const CLUSTER = '11111111-1111-4111-8111-111111111111';
const ANCHOR = '22222222-2222-4222-8222-222222222222';

const row = (mode: string, over: Partial<LobbyTableRow> = {}): LobbyTableRow =>
  ({
    id: ANCHOR,
    name: 'NLH 1/2 Main 1',
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 80,
    max_buy_in: 400,
    current_players: 5,
    max_players: 6,
    status: 'running',
    cluster_id: CLUSTER,
    cluster_handedness: 6,
    role: 'main',
    main_index: 1,
    lifecycle: 'live',
    cluster_must_move: true,
    cluster_template: 'madness',
    cluster_players: 5,
    cluster_tables: 1,
    cluster_mode: mode,
    cluster_lightning: parseLightningLobbyState({
      cluster_mode: mode,
      thresholds: { on: 18, off: 12 },
      verdict: { live_eligible: 20 },
    }),
    ...over,
  }) as LobbyTableRow;

const ctx = (seated = false): LobbyRowContext =>
  ({
    seatedIds: new Set(seated ? [ANCHOR, CLUSTER] : []),
    waitlistedIds: new Set<string>(),
    registeredIds: new Set<string>(),
    favoriteIds: new Set<string>(),
    onJoinTable: vi.fn(),
    onViewTable: vi.fn(),
    onWaitlistToggle: vi.fn(),
  }) as unknown as LobbyRowContext;

const MODE_WORDS = [
  'MUST MOVE',
  'LIGHTNING LIVE',
  'CLASSIC',
  'Lightning Starting',
  'Lightning Ending',
];
const words = (e: ReturnType<typeof cashEntry>) =>
  e.rules.map((r) => r.label).filter((l) => MODE_WORDS.includes(l));

describe('the mode words', () => {
  it('pending_on is starting; pending_off and draining are ending; nothing else is switching', () => {
    expect(lightningSwitchingOf('pending_on')).toBe('starting');
    expect(lightningSwitchingOf('pending_off')).toBe('ending');
    expect(lightningSwitchingOf('draining')).toBe('ending');
    for (const m of ['must_move', 'lightning', 'paused', 'frozen', 'dead', null, undefined])
      expect(lightningSwitchingOf(m), String(m)).toBeNull();
    expect(clusterModeDisplay('pending_on').label).toBe('Lightning Starting');
    expect(clusterModeDisplay('pending_off').label).toBe('Lightning Ending');
    expect(clusterModeDisplay('draining').label).toBe('Lightning Ending');
  });

  it('the words are Title Case with no dash of any kind', () => {
    for (const w of ['Lightning Starting', 'Lightning Ending']) {
      expect(
        w.split(' ').every((p) => /^[A-Z][a-z]+$/.test(p)),
        w
      ).toBe(true);
      expect(w).not.toMatch(/[-\u2012\u2013\u2014\u2015]/);
    }
  });

  it('the badge carries the switch and never offers JOIN LIGHTNING while switching', () => {
    expect(
      lightningLobbyBadge({ clusterMode: 'pending_on', state: null, boardPlayers: 7 })
    ).toEqual({
      mode: 'must_move',
      label: 'Lightning Starting',
      players: 7,
      status: null,
      joinLightning: false,
      closedLabel: null,
      switching: 'starting',
    });
    for (const m of ['pending_off', 'draining'])
      expect(
        lightningLobbyBadge({ clusterMode: m, state: null, boardPlayers: 3 }),
        m
      ).toMatchObject({
        mode: 'lightning',
        label: 'Lightning Ending',
        joinLightning: false,
        switching: 'ending',
      });
    expect(
      lightningLobbyBadge({ clusterMode: 'lightning', state: null, boardPlayers: 3 })
    ).not.toHaveProperty('switching');
    expect(
      lightningLobbyBadge({ clusterMode: 'must_move', state: null, boardPlayers: 3 })
    ).not.toHaveProperty('switching');
  });
});

describe('a Lightning game switching modes', () => {
  for (const [mode, word, switching] of [
    ['pending_on', 'Lightning Starting', 'starting'],
    ['pending_off', 'Lightning Ending', 'ending'],
    ['draining', 'Lightning Ending', 'ending'],
  ] as const) {
    it(`${mode}: says ${word}, and the Join Game door is shown disabled`, () => {
      const e = cashEntry(row(mode));
      expect(words(e)).toEqual([word]);
      const medallion = e.rules.find((r) => r.label === word)!;
      expect(medallion.detail).toBeUndefined();
      expect(medallion.tip).toBe('');
      expect(e.game?.switching).toBe(switching);
      expect(e.game?.lightning).toBeUndefined();
      const a = arenaGameCardActionsForEntry(e, ctx());
      expect(a).toMatchObject({ primaryLabel: 'Join Game', primaryDisabled: true });
      expect(a.onPrimary).toBeUndefined();
      expect(a.secondaryLabel).toBe('View Game');
    });

    it.each(['card', 'row', 'panel'])(
      `${mode}: the %s shows Join Game disabled and adds no other text`,
      (surface) => {
        const e = cashEntry(row(mode));
        const c = ctx();
        const actions = columnsFor('HOLDEM').find((col) => col.key === 'actions')!;
        const { container } = render(
          <MemoryRouter>
            {surface === 'card' ? (
              <ArenaLobbyGameCard entry={e} ctx={c} />
            ) : surface === 'row' ? (
              actions.render(e, c)
            ) : (
              <GameLobbyPanel
                entry={e}
                clubId="club"
                currentUserId="viewer"
                waitlisted={false}
                seated={false}
                registered={false}
                busy={false}
                onClose={vi.fn()}
                onJoinTable={() => c.onJoinTable?.(e)}
                onWaitlistToggle={c.onWaitlistToggle!}
                onRegister={vi.fn()}
                onUnregister={vi.fn()}
                onSpinJoin={vi.fn()}
              />
            )}
          </MemoryRouter>
        );
        const door = screen
          .getAllByRole('button')
          .find((b) => /^\s*Join Game\s*$/.test(b.textContent ?? ''));
        expect(door, surface).toBeDefined();
        expect((door as HTMLButtonElement).disabled, surface).toBe(true);
        door!.click();
        expect(c.onJoinTable).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: /Join Lightning/ })).toBeNull();
        expect(container.textContent).not.toMatch(/LIGHTNING LIVE/);
        /* The game panel used to print a note under its door; a switching
         game's door carries none. */
        expect(container.textContent).not.toMatch(
          /Seats You At The Right Table|One Stream Of Hands/
        );
      }
    );
  }

  it('a seated player still goes back to their own seat; nobody is moved', () => {
    const c = ctx(true);
    for (const m of ['pending_on', 'pending_off', 'draining']) {
      const a = arenaGameCardActionsForEntry(cashEntry(row(m)), c);
      expect(a.primaryLabel, m).toBe('Return To Game');
      expect(a.primaryDisabled, m).toBeFalsy();
    }
    expect(c.onJoinTable).not.toHaveBeenCalled();
    expect(c.onViewTable).not.toHaveBeenCalled();
  });

  it('the lightning and must_move cards are unchanged', () => {
    const live = cashEntry(row('lightning'));
    expect(words(live)).toEqual(['LIGHTNING LIVE']);
    expect(live.game?.switching).toBeUndefined();
    expect(arenaGameCardActionsForEntry(live, ctx())).toMatchObject({
      primaryLabel: 'Join Lightning',
      primaryDisabled: false,
    });
    const mm = cashEntry(row('must_move'));
    expect(words(mm)).toEqual(['MUST MOVE']);
    expect(mm.game?.switching).toBeUndefined();
    expect(arenaGameCardActionsForEntry(mm, ctx())).toMatchObject({
      primaryLabel: 'Join Game',
      primaryDisabled: false,
    });
  });
});

describe('games that never run Lightning are unchanged in every mode', () => {
  const MODES = ['must_move', 'pending_on', 'pending_off', 'draining', 'lightning'];

  it('a Classic game keeps its CLASSIC word and an open Join Game', () => {
    for (const m of MODES) {
      const e = cashEntry(row(m, { cluster_template: 'classic' }));
      expect(words(e), m).toEqual(['CLASSIC']);
      expect(e.game?.switching, m).toBeUndefined();
      expect(arenaGameCardActionsForEntry(e, ctx()), m).toMatchObject({
        primaryLabel: 'Join Game',
        primaryDisabled: false,
      });
    }
  });

  it('Short Deck, Omaha Hi-Lo and Pineapple must-move games keep MUST MOVE and an open Join Game', () => {
    for (const variant of ['short_deck', 'flo8', 'plo8', 'pineapple'])
      for (const m of MODES) {
        const e = cashEntry(row(m, { game_variant: variant }));
        expect(words(e), `${variant} ${m}`).toEqual(['MUST MOVE']);
        expect(e.game?.switching, `${variant} ${m}`).toBeUndefined();
        expect(e.game?.noLightning, `${variant} ${m}`).toBe(true);
        expect(arenaGameCardActionsForEntry(e, ctx()), `${variant} ${m}`).toMatchObject({
          primaryLabel: 'Join Game',
          primaryDisabled: false,
        });
      }
  });
});
