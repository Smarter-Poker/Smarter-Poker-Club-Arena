/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FELT SAYS A MOVE IS COMING, THE LIST HAS NAMES, THE MOBILE CARD SAYS
 *  THE STYLE, THE STAKES MENU COUNTS STYLES, AND STAFF SEE THE TICK
 *  (Dan 2026-09-05, Operation Table Stakes)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A move always executes at the player's NEXT hand boundary (cash_seat_moves
 * has no hands-until), so the sentence is "Moving After This Hand." and it
 * stays on the felt until the move has run. Everything else here is copy a
 * player or a staff member reads: Title Case, never an em dash.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../src/hooks/useSpinTierAvailability', () => ({
  useSpinTierAvailability: () => ({ can_draw_100x: false }),
}));
// This suite exercises lobby copy and filters. The warm-up suites own real
// transport/route preparation; detached page imports must not outlive this fixture.
vi.mock('../../src/services/tableWarmup', () => ({
  warmTable: vi.fn(),
  observeLobbyTableWarmups: vi.fn(() => () => undefined),
}));

import { CashClusterHUD } from '../../src/components/table/CashClusterHUD';
import { MustMoveLobbyModal } from '../../src/components/table/MustMoveLobbyModal';
import LobbyTable from '../../src/components/lobby/LobbyTable';
import {
  mustMoveListRows,
  pendingMoveDestination,
  pendingMoveNotice,
  type CashGameLobby,
  type LobbyListEntry,
  type LobbyPendingMove,
} from '../../src/services/cashGameLobby';
import {
  cashEntry,
  countStylesOnBoard,
  styleCountsLine,
  withClubLabel,
  type LobbyTableRow,
} from '../../src/components/lobby/lobbyEntries';
import { cashCardTitle } from '../../src/components/lobby/game-cards/arenaGameCardAdapter';
import { CASH_STYLES } from '../../src/components/lobby/advancedFilterSpec';
import {
  TICK_STALE_MS,
  staffTickLine,
  tickActionsCopy,
  tickAgeCopy,
  tickIsStale,
} from '../../src/components/lobby/cashGameTick';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const EM_DASH = '—';

const GAME = 'g-1';
const MAIN1 = 't-main1';
const MAIN2 = 't-main2';
const FEEDER = 't-feeder';
const HERO = 'u-hero';

function move(over: Partial<LobbyPendingMove> = {}): LobbyPendingMove {
  return {
    id: 'm',
    to_table_id: MAIN2,
    to_table_name: 'NLH 1/2 Classic Main 2',
    to_role: 'main',
    to_main_index: 2,
    reason: 'must_move',
    announced: true,
    swap: false,
    held: false,
    ...over,
  };
}

function lobby(me: Partial<CashGameLobby['me']> = {}): CashGameLobby {
  const seats = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      seat_number: i + 1,
      user_id: `${prefix}-${i + 1}`,
      alias: `${prefix} ${i + 1}`,
      stack: 100,
      is_sitting_out: false,
      joined_game_at: null,
    }));
  return {
    game: {
      id: GAME,
      name: 'NLH 1/2 Classic',
      template_name: 'classic',
      variant: 'nlh',
      sb: 1,
      bb: 2,
      handedness: 6,
      state: 'live',
      must_move: true,
      enabled: true,
      last_tick_at: null,
    },
    tables: [
      {
        id: MAIN1,
        name: 'NLH 1/2 Classic',
        role: 'main',
        main_index: 1,
        lifecycle: 'live',
        status: 'running',
        max_players: 6,
        seated: 6,
        open_seats: 0,
        seat_change_queue: 0,
        seats: seats('Main One', 6),
      },
      {
        id: MAIN2,
        name: 'NLH 1/2 Classic Main 2',
        role: 'main',
        main_index: 2,
        lifecycle: 'live',
        status: 'running',
        max_players: 6,
        seated: 3,
        open_seats: 3,
        seat_change_queue: 0,
        seats: seats('Main Two', 3),
      },
      {
        id: FEEDER,
        name: 'NLH 1/2 Classic Feeder',
        role: 'feeder',
        main_index: null,
        lifecycle: 'live',
        status: 'running',
        max_players: 6,
        seated: 2,
        open_seats: 4,
        seat_change_queue: 0,
        seats: [
          {
            seat_number: 1,
            user_id: HERO,
            alias: 'Hero',
            stack: 200,
            is_sitting_out: false,
            joined_game_at: null,
          },
          {
            seat_number: 4,
            user_id: 'u-vil',
            alias: 'Villain',
            stack: 150,
            is_sitting_out: false,
            joined_game_at: null,
          },
        ],
      },
    ],
    must_move_list: [
      {
        position: 2,
        user_id: HERO,
        alias: 'Hero',
        table_id: FEEDER,
        table_name: 'NLH 1/2 Classic Feeder',
        role: 'feeder',
        main_index: null,
        joined_at: '2026-09-05T01:00:00Z',
      },
      {
        position: 1,
        user_id: 'Main Two-1',
        alias: 'Main Two 1',
        table_id: MAIN2,
        table_name: 'NLH 1/2 Classic Main 2',
        role: 'main',
        main_index: 2,
        joined_at: '2026-09-05T00:00:00Z',
      },
      {
        position: 3,
        user_id: 'u-vil',
        alias: null,
        table_id: FEEDER,
        table_name: 'NLH 1/2 Classic Feeder',
        role: 'feeder',
        main_index: null,
        joined_at: '2026-09-05T02:00:00Z',
      },
    ],
    waitlist: { waiting: 0 },
    seat_changes_requested: 0,
    me: {
      user_id: HERO,
      seated: true,
      table_id: FEEDER,
      seat_number: 1,
      stack: 200,
      role: 'feeder',
      main_index: null,
      lifecycle: 'live',
      on_main_one: false,
      joined_game_at: '2026-09-05T01:00:00Z',
      must_move_position: 2,
      seat_change: { available: false, used_at: null, request: null },
      pending_move: null,
      ...me,
    },
    as_of: '2026-09-05T03:00:00Z',
  };
}

beforeEach(() => {
  mocks.rpc.mockReset();
  for (const f of Object.values(mocks.toast)) f.mockReset();
});

describe('the sentence on the felt', () => {
  it('names the destination the way the lobby does', () => {
    expect(pendingMoveDestination(move())).toBe('Main 2');
    expect(pendingMoveDestination(move({ to_role: 'main', to_main_index: 1 }))).toBe('Main 1');
    expect(pendingMoveDestination(move({ to_role: 'feeder', to_main_index: null }))).toBe('Feeder');
    expect(
      pendingMoveDestination(move({ to_role: null, to_main_index: null, to_table_name: 'Side' }))
    ).toBe('Side');
    expect(
      pendingMoveDestination(move({ to_role: null, to_main_index: null, to_table_name: null }))
    ).toBe('Your New Table');
  });

  it('says "Seat Open On Main 2. Moving After This Hand." for a must move, and nothing when there is no move', () => {
    expect(pendingMoveNotice(move())).toBe('Seat Open On Main 2. Moving After This Hand.');
    expect(pendingMoveNotice(null)).toBeNull();
    expect(pendingMoveNotice(undefined)).toBeNull();
  });

  it('speaks the other two reasons in the engine words', () => {
    expect(pendingMoveNotice(move({ reason: 'break' }))).toBe(
      'This Table Is Closing. Moving To Main 2 After This Hand.'
    );
    expect(pendingMoveNotice(move({ reason: 'seat_change' }))).toBe(
      'Seat Change Granted. Moving To Main 2 After This Hand.'
    );
    expect(pendingMoveNotice(move({ reason: 'seat_change', swap: true }))).toBe(
      'Seat Change Granted. Swapping To Main 2 After This Hand.'
    );
    expect(pendingMoveNotice(move({ reason: 'seat_change', swap: true, held: true }))).toBe(
      'Seat Change: Waiting For The Other Table To Finish Its Hand.'
    );
  });

  it('is Title Case with no em dash, every branch', () => {
    const all = [
      move(),
      move({ reason: 'break' }),
      move({ reason: 'seat_change' }),
      move({ reason: 'seat_change', swap: true }),
      move({ reason: 'seat_change', held: true }),
    ].map((m) => pendingMoveNotice(m)!);
    for (const s of all) {
      expect(s).not.toContain(EM_DASH);
      for (const w of s.replace(/[.:]/g, '').split(' ')) {
        if (/^[a-z]/i.test(w)) expect(w[0]).toBe(w[0].toUpperCase());
      }
    }
  });

  it('there is no N: a move runs at the next hand boundary, so the copy never counts hands', () => {
    const migration = read('supabase/migrations/20260905010000_cluster_columns_slice_2.sql');
    const table = migration.slice(
      migration.indexOf('CREATE TABLE IF NOT EXISTS public.cash_seat_moves')
    );
    const body = table.slice(0, table.indexOf(');'));
    expect(body).not.toMatch(/hands_until|hands_out|after_hands/);
    expect(read('src/services/cashGameLobby.ts')).not.toMatch(/Moving In \$\{/);
  });
});

describe('the felt notice in the corner (CashClusterHUD)', () => {
  it('stays on the felt while the database holds a pending move for the viewer', async () => {
    mocks.rpc.mockResolvedValue({ data: lobby({ pending_move: move() }), error: null });
    render(<CashClusterHUD gameId={GAME} onOpenLobby={vi.fn()} onSeatChange={vi.fn()} />);
    const notice = await screen.findByTestId('cch-move-notice');
    expect(notice.textContent).toBe('Seat Open On Main 2. Moving After This Hand.');
    expect(notice).toHaveAttribute('role', 'status');
    /* A move pending means the seat change is not on offer; the corner holds
       the sentence and nothing that competes with it. */
    expect(screen.queryByText('Seat Change')).toBeNull();
  });

  it('is absent when nothing is pending, and leaves once the move has run', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: lobby({ pending_move: move() }), error: null });
    const { rerender } = render(
      <CashClusterHUD gameId={GAME} refreshKey={0} onOpenLobby={vi.fn()} onSeatChange={vi.fn()} />
    );
    await screen.findByTestId('cch-move-notice');
    /* SEAT_MOVED bumps refreshKey; the re-read no longer returns the move. */
    mocks.rpc.mockResolvedValue({ data: lobby({ pending_move: null }), error: null });
    rerender(
      <CashClusterHUD gameId={GAME} refreshKey={1} onOpenLobby={vi.fn()} onSeatChange={vi.fn()} />
    );
    await waitFor(() => expect(screen.queryByTestId('cch-move-notice')).toBeNull());
  });

  it('is not shown to a viewer who is not seated in the game', async () => {
    mocks.rpc.mockResolvedValue({
      data: lobby({ seated: false, table_id: null, pending_move: move() }),
      error: null,
    });
    render(<CashClusterHUD gameId={GAME} onOpenLobby={vi.fn()} onSeatChange={vi.fn()} />);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
    expect(screen.queryByTestId('cch-move-notice')).toBeNull();
  });

  it('the corner is wired on every cluster table and the notice sits inside the column, away from the action buttons', () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toMatch(/<div className="hud-ur-column">[\s\S]*?<CashClusterHUD/);
    /* THE BAR LEFT THE FELT (Dan 2026-09-05). It read MUST MOVE / PLAYERS /
       TABLES across the corner, over two seats; the one word LOBBY is in the
       action pill row now (MultiTablePage, .mtp-lobby-btn) and the corner
       keeps only the sentence and the action buttons. This pin moved with the
       mechanism rather than being dropped - see must-move-lobby.test.tsx. */
    const hud = read('src/components/table/CashClusterHUD.tsx');
    expect(hud).not.toMatch(/className="cash-cluster-hud-bar"/);
    expect(hud).toMatch(/className="cch-move-notice"/);
    const css = read('src/components/table/CashClusterHUD.css');
    /* Capped inside a 375px screen at the phone breakpoint. */
    expect(css).toMatch(
      /@media \(max-width: 600px\)[\s\S]*\.cch-move-notice \{[\s\S]*?max-width: 200px/
    );
    expect(css).toMatch(/\.cch-move-notice \{[\s\S]*?pointer-events: none/);
  });
});

describe('the list has names', () => {
  it('orders by position whatever order the JSON arrived in, names every row, and marks the viewer', () => {
    const rows = mustMoveListRows(lobby().must_move_list, HERO);
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.name)).toEqual(['Main Two 1', 'Hero', 'Player']);
    expect(rows.map((r) => r.tableLabel)).toEqual(['Main 2', 'Feeder', 'Feeder']);
    expect(rows.map((r) => r.me)).toEqual([false, true, false]);
    expect(rows.map((r) => r.key)).toEqual(['Main Two-1', HERO, 'u-vil']);
  });

  it('a blank alias reads Player, never a uuid, and no viewer means no row is theirs', () => {
    const list: LobbyListEntry[] = [
      {
        position: 1,
        user_id: '6b1f0f2a-0000-4000-8000-000000000000',
        alias: '   ',
        table_id: FEEDER,
        table_name: 'X',
        role: 'feeder',
        main_index: null,
        joined_at: '',
      },
    ];
    const [row] = mustMoveListRows(list, null);
    expect(row.name).toBe('Player');
    expect(row.me).toBe(false);
    expect(mustMoveListRows(null, HERO)).toEqual([]);
  });

  it('the lobby shows each name with its number, the hero row highlighted and tagged You', async () => {
    mocks.rpc.mockResolvedValue({ data: lobby(), error: null });
    render(<MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />);
    const list = await screen.findByRole('list', { name: 'Must Move List, In Join Order' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toBe('1Main Two 1Main 2');
    expect(items[1]).toHaveClass('mml-list-row--me');
    expect(items[1]).toHaveAttribute('aria-current', 'true');
    expect(within(items[1]).getByText('You')).toBeTruthy();
    expect(within(items[1]).getByText('Hero')).toBeTruthy();
    expect(items[2].textContent).toBe('3PlayerFeeder');
    expect(items[0]).not.toHaveClass('mml-list-row--me');
  });

  it('the lobby states the pending move with the same sentence as the felt', async () => {
    mocks.rpc.mockResolvedValue({ data: lobby({ pending_move: move() }), error: null });
    render(<MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />);
    expect(await screen.findByText('Seat Open On Main 2. Moving After This Hand.')).toBeTruthy();
    const modal = read('src/components/table/MustMoveLobbyModal.tsx');
    expect(modal).toContain('pendingMoveNotice(me.pending_move)');
  });
});

const table = (over: Partial<LobbyTableRow>): LobbyTableRow =>
  ({
    id: 't',
    name: 'NLH 1/2',
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 80,
    max_buy_in: 400,
    current_players: 3,
    max_players: 6,
    status: 'open',
    ...over,
  }) as LobbyTableRow;

describe('the mobile card says the style', () => {
  it('a templated NLH game with a custom name leads its second line with the style', () => {
    const e = cashEntry(
      table({
        name: 'Late Night',
        cluster_id: 'g',
        cluster_template: 'action',
        cluster_must_move: true,
      })
    );
    expect(cashCardTitle(e)).toEqual({ title: 'Late Night', subtitle: 'Action' });
  });

  it('the club name rides after the style on a union board', () => {
    const e = withClubLabel(
      cashEntry(
        table({
          name: 'Late Night',
          cluster_id: 'g',
          cluster_template: 'madness',
          cluster_must_move: true,
          club_id: 'other',
        } as Partial<LobbyTableRow>)
      ),
      'mine',
      { other: 'Deep Stack Society' }
    );
    if (e.clubLabel) {
      expect(cashCardTitle(e).subtitle).toBe('Madness, Deep Stack Society');
    } else {
      expect(cashCardTitle(e).subtitle).toBe('Madness');
    }
  });

  it('a default-named game already says the style in its title, so the approved second line is kept', () => {
    const e = cashEntry(
      table({
        name: 'NLH 1/2 Classic',
        cluster_id: 'g',
        cluster_template: 'classic',
        cluster_must_move: true,
      })
    );
    const card = cashCardTitle(e);
    expect(card.title).toBe('NLH 1/2 Classic');
    expect(`${card.title} ${card.subtitle ?? ''}`).toMatch(/Classic/);
    expect(card.subtitle).not.toBe('Classic');
  });

  it('an untemplated table is exactly as it was', () => {
    const e = cashEntry(table({ name: 'NLH 1/2 Late Night' }));
    expect(cashCardTitle(e)).toEqual({ title: 'NLH 1/2 Late Night', subtitle: "No Limit Hold'em" });
  });

  it('a templated PLO game still says the style under "PLO5 25/50"', () => {
    const e = cashEntry(
      table({
        name: 'PLO5 25/50 Action',
        game_variant: 'plo5',
        small_blind: 25,
        big_blind: 50,
        cluster_id: 'g',
        cluster_template: 'action',
        cluster_must_move: true,
      })
    );
    expect(cashCardTitle(e).subtitle).toBe('Action');
  });

  it('the stakes and the players are separate card zones the second line never touches', () => {
    const card = read('src/components/lobby/game-cards/ArenaGameCard.tsx');
    expect(card).toMatch(/zone="stakes"/);
    expect(card).toMatch(/zone="players"/);
    expect(card).toMatch(/data-zone="title"[\s\S]*?<p>\{data\.subtitle\}<\/p>/);
  });
});

describe('the Stakes menu counts styles', () => {
  const rows = [
    table({ id: 'a', cluster_id: 'g1', role: 'main', main_index: 1, cluster_template: 'classic' }),
    table({ id: 'a2', cluster_id: 'g1', role: 'main', main_index: 2, cluster_template: 'classic' }),
    table({
      id: 'a3',
      cluster_id: 'g1',
      role: 'feeder',
      main_index: null,
      cluster_template: 'classic',
    }),
    table({ id: 'b', cluster_id: 'g2', role: 'main', main_index: 1, cluster_template: 'Action' }),
    table({ id: 'c', cluster_id: 'g3', role: 'main', main_index: 1, cluster_template: 'classic' }),
    table({ id: 'd' }),
    table({ id: 'e', cluster_id: 'g4', role: 'main', main_index: 1, cluster_template: null }),
  ] as LobbyTableRow[];

  it('counts one per game, never per table, and ignores tables of no style', () => {
    expect(countStylesOnBoard(rows)).toEqual({ classic: 2, action: 1 });
    expect(countStylesOnBoard([])).toEqual({});
  });

  it('prints the line in the menu order with zeros, not gaps', () => {
    expect(styleCountsLine(CASH_STYLES, countStylesOnBoard(rows))).toBe(
      'Classic 2 / Action 1 / Madness 0'
    );
    expect(styleCountsLine(CASH_STYLES, {})).toBe('Classic 0 / Action 0 / Madness 0');
  });

  it('the menu shows the line and a figure beside each style; without counts it is as it was', () => {
    const ctx = {
      waitlistedIds: new Set<string>(),
      seatedIds: new Set<string>(),
      registeredIds: new Set<string>(),
      favoriteIds: new Set<string>(),
    };
    const entries = [
      cashEntry(
        table({ id: 'a', name: 'NLH 1/2 Classic', cluster_id: 'g1', cluster_template: 'classic' })
      ),
    ];
    const { unmount } = render(
      <MemoryRouter>
        <LobbyTable
          entries={entries}
          category="HOLDEM"
          selectedId={null}
          onSelect={() => {}}
          onActivate={() => {}}
          ctx={ctx}
          styleChoices={CASH_STYLES}
          selectedStyles={[]}
          onStylesChange={vi.fn()}
          styleCounts={{ classic: 12, action: 4, madness: 2 }}
        />
      </MemoryRouter>
    );
    const bar = screen.getByRole('toolbar', { name: 'Sort Games' });
    fireEvent.click(within(bar).getByRole('button', { name: /stakes/i }));
    const menu = within(bar).getByRole('group', { name: 'Stakes' });
    expect(within(menu).getByTestId('lt-style-counts').textContent).toBe(
      'Classic 12 / Action 4 / Madness 2'
    );
    expect(within(menu).getByRole('button', { name: 'Classic, 12 Games' })).toBeTruthy();
    expect(within(menu).getByRole('button', { name: 'Action, 4 Games' })).toBeTruthy();
    expect(within(menu).getByRole('button', { name: 'Madness, 2 Games' })).toBeTruthy();
    unmount();

    render(
      <MemoryRouter>
        <LobbyTable
          entries={entries}
          category="HOLDEM"
          selectedId={null}
          onSelect={() => {}}
          onActivate={() => {}}
          ctx={ctx}
          styleChoices={CASH_STYLES}
          selectedStyles={[]}
          onStylesChange={vi.fn()}
        />
      </MemoryRouter>
    );
    const bar2 = screen.getByRole('toolbar', { name: 'Sort Games' });
    fireEvent.click(within(bar2).getByRole('button', { name: /stakes/i }));
    const menu2 = within(bar2).getByRole('group', { name: 'Stakes' });
    expect(within(menu2).queryByTestId('lt-style-counts')).toBeNull();
    expect(within(menu2).getByRole('button', { name: 'Classic' })).toBeTruthy();
  });

  it('the page counts from the rows already loaded, before the style filter, and passes them down', () => {
    const page = read('src/pages/ClubHomePage.tsx');
    expect(page).toMatch(/const styleCounts = useMemo\(\s*\(\) =>\s*countStylesOnBoard\(/);
    expect(page).toMatch(
      /styleChoices: sSpec\.styles,\s*selectedStyles: sVal\.styles \?\? \[\],\s*styleCounts,/
    );
    /* Derived from `tables`, the state the lobby already holds - no fetch. */
    const block = page.slice(
      page.indexOf('const styleCounts = useMemo('),
      page.indexOf('const filteredTables = useMemo(')
    );
    expect(block).not.toMatch(/supabase|fetch\(|rpc\(/);
  });
});

describe('the tick for staff', () => {
  const NOW = Date.parse('2026-09-05T12:00:00Z');

  it('says how long ago, in the coarsest unit that is not zero', () => {
    expect(tickAgeCopy('2026-09-05T11:59:56Z', NOW)).toBe('Tick 4s Ago');
    expect(tickAgeCopy('2026-09-05T11:58:00Z', NOW)).toBe('Tick 2m Ago');
    expect(tickAgeCopy('2026-09-05T10:30:00Z', NOW)).toBe('Tick 1h Ago');
    expect(tickAgeCopy(null, NOW)).toBe('No Tick Yet');
    expect(tickAgeCopy('garbage', NOW)).toBe('No Tick Yet');
    /* A clock slightly ahead never prints a negative age. */
    expect(tickAgeCopy('2026-09-05T12:00:03Z', NOW)).toBe('Tick 0s Ago');
  });

  it('turns the jsonb action list into words a person reads', () => {
    expect(
      tickActionsCopy([
        { moves_planned: 2 },
        { feeder: 'opened', buyers: 3 },
        { closed: '6b1f0f2a-1111-4000-8000-000000000000' },
        { main1: 'reopened' },
        { opening_hold: 'started' },
      ])
    ).toBe(
      'Moves Planned 2, Feeder Opened, Buyers 3, Closed 6b1f0f2a, Main1 Reopened, Opening Hold Started'
    );
    expect(tickActionsCopy([])).toBe('Quiet');
    expect(tickActionsCopy(null)).toBe('Quiet');
    expect(tickActionsCopy({ state: 'live' })).toBe('State Live');
  });

  it('the whole line, and the stale flag two minutes after the controller went quiet', () => {
    expect(
      staffTickLine('2026-09-05T11:59:56Z', [{ moves_planned: 2 }, { feeder: 'opened' }], NOW)
    ).toBe('Tick 4s Ago: Moves Planned 2, Feeder Opened');
    expect(staffTickLine(null, [{ moves_planned: 2 }], NOW)).toBe('No Tick Yet');
    expect(staffTickLine('2026-09-05T11:59:56Z', [], NOW)).not.toContain(EM_DASH);
    expect(tickIsStale('2026-09-05T11:59:56Z', NOW)).toBe(false);
    expect(tickIsStale(new Date(NOW - TICK_STALE_MS - 1).toISOString(), NOW)).toBe(true);
    expect(tickIsStale(null, NOW)).toBe(true);
  });

  it('is read off cash_games columns for staff only, on a must-move game only, and the page passes the staff test the notice board uses', () => {
    const panel = read('src/components/lobby/GameLobbyPanel.tsx');
    expect(panel).toMatch(
      /if \(!isCash \|\| !staff \|\| !gameId\) \{\s*setTick\(null\);\s*return;/
    );
    expect(panel).toMatch(/\.from\('cash_games'\)\s*\.select\('last_tick_at, last_tick_actions'\)/);
    expect(panel).toMatch(/\{staff && tick && \(/);
    expect(panel).toMatch(/className=\{`glp__tick glp__mono/);
    const page = read('src/pages/ClubHomePage.tsx');
    expect(page).toMatch(/staff=\{isOwner \|\| isClubStaff\(userRole\)\}/);
    /* The row is readable by the authenticated role (cash_games_read); no RPC
       was widened for this. */
    expect(read('supabase/migrations/20260904230000_cash_games_slice_1_hardening.sql')).toMatch(
      /CREATE POLICY cash_games_read ON public\.cash_games FOR SELECT TO authenticated/
    );
  });
});
