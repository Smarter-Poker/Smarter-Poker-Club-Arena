/**
 * THE MUST MOVE LOBBY (Dan 2026-09-05) - the client half.
 *
 *   - the box in the corner reads players, tables and the hero's place, and
 *     the SEAT CHANGE button is there exactly when the database says so;
 *   - the lobby lists every table with every chair and stack, the must-move
 *     list in join order, and offers REQUEST only on tables a seat change may
 *     go to (never Main 1, never the hero's own table);
 *   - the doors are called with the game id and the table (or null for any),
 *     and the refusals are read back in the player's words;
 *   - the tab follows the chair: an embedded TablePage reports the move and
 *     MultiTablePage re-points the tab instead of navigating.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));

import { MustMoveLobbyModal } from '../src/components/table/MustMoveLobbyModal';
import { CashClusterHUD } from '../src/components/table/CashClusterHUD';
import {
  lobbyTableLabel,
  seatChangeRefusalText,
  seatChangeOutcomeText,
  type CashGameLobby,
} from '../src/services/cashGameLobby';

const GAME = 'g-1';
const MAIN1 = 't-main1';
const MAIN2 = 't-main2';
const FEEDER = 't-feeder';
const HERO = 'u-hero';

function lobby(overrides: Partial<CashGameLobby['me']> = {}): CashGameLobby {
  return {
    game: {
      id: GAME,
      name: 'NLH 0.10/0.25 Action',
      template_name: 'action',
      variant: 'nlh',
      sb: 0.1,
      bb: 0.25,
      handedness: 6,
      state: 'live',
      must_move: true,
      enabled: true,
      last_tick_at: null,
    },
    tables: [
      {
        id: MAIN1,
        name: 'NLH Main',
        role: 'main',
        main_index: 1,
        lifecycle: 'live',
        status: 'running',
        max_players: 6,
        seated: 6,
        open_seats: 0,
        seat_change_queue: 0,
        seats: [1, 2, 3, 4, 5, 6].map((n) => ({
          seat_number: n,
          user_id: `m1-${n}`,
          alias: `Main One ${n}`,
          stack: 20 + n,
          is_sitting_out: false,
          joined_game_at: null,
        })),
      },
      {
        id: MAIN2,
        name: 'NLH Main 2',
        role: 'main',
        main_index: 2,
        lifecycle: 'live',
        status: 'running',
        max_players: 6,
        seated: 2,
        open_seats: 4,
        seat_change_queue: 1,
        seats: [
          {
            seat_number: 1,
            user_id: 'p-a',
            alias: 'Alpha',
            stack: 30,
            is_sitting_out: false,
            joined_game_at: null,
          },
          {
            seat_number: 4,
            user_id: 'p-b',
            alias: 'Bravo',
            stack: 12.5,
            is_sitting_out: false,
            joined_game_at: null,
          },
        ],
      },
      {
        id: FEEDER,
        name: 'NLH Feeder',
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
            seat_number: 2,
            user_id: HERO,
            alias: 'You',
            stack: 25,
            is_sitting_out: false,
            joined_game_at: null,
          },
          {
            seat_number: 5,
            user_id: 'p-c',
            alias: 'Charlie',
            stack: 40,
            is_sitting_out: false,
            joined_game_at: null,
          },
        ],
      },
    ],
    must_move_list: [
      {
        position: 1,
        user_id: 'p-a',
        alias: 'Alpha',
        table_id: MAIN2,
        table_name: 'NLH Main 2',
        role: 'main',
        main_index: 2,
        joined_at: '',
      },
      {
        position: 2,
        user_id: HERO,
        alias: 'You',
        table_id: FEEDER,
        table_name: 'NLH Feeder',
        role: 'feeder',
        main_index: null,
        joined_at: '',
      },
      {
        position: 3,
        user_id: 'p-c',
        alias: 'Charlie',
        table_id: FEEDER,
        table_name: 'NLH Feeder',
        role: 'feeder',
        main_index: null,
        joined_at: '',
      },
    ],
    waitlist: { waiting: 1 },
    seat_changes_requested: 1,
    me: {
      user_id: HERO,
      seated: true,
      table_id: FEEDER,
      seat_number: 2,
      stack: 25,
      role: 'feeder',
      main_index: null,
      lifecycle: 'live',
      on_main_one: false,
      joined_game_at: null,
      must_move_position: 2,
      seat_change: { available: true, used_at: null, request: null },
      pending_move: null,
      ...overrides,
    },
    as_of: '',
  };
}

beforeEach(() => {
  mocks.rpc.mockReset();
  for (const k of Object.keys(mocks.toast) as (keyof typeof mocks.toast)[])
    mocks.toast[k].mockReset();
});

describe('the words', () => {
  it('names tables Main 1 / Main 2 / Feeder', () => {
    expect(lobbyTableLabel({ role: 'main', main_index: 1, name: 'x' })).toBe('Main 1');
    expect(lobbyTableLabel({ role: 'main', main_index: 3, name: 'x' })).toBe('Main 3');
    expect(lobbyTableLabel({ role: 'feeder', main_index: null, name: 'x' })).toBe('Feeder');
  });

  it('reads a refusal back in the player words, and never an em dash', () => {
    expect(seatChangeRefusalText({ message: 'SEAT_CHANGE_USED: you have used ...' })).toBe(
      'You Have Used Your Seat Change For This Game.'
    );
    expect(seatChangeRefusalText({ message: 'SEAT_CHANGE_NEVER_TO_MAIN: x' })).toBe(
      'The Main Game Fills In Must Move Order Only.'
    );
    expect(seatChangeRefusalText(new Error('something else'))).toBe(
      'Seat Change Not Available Right Now.'
    );
    const src = readFileSync(resolve(__dirname, '../src/services/cashGameLobby.ts'), 'utf8');
    expect(src).not.toMatch(/—/);
  });

  it('says moved / swapping / listed with the number', () => {
    const base = {
      ok: true,
      request_id: 'r',
      to_table_id: MAIN2,
      to_table_name: null,
      to_role: 'main',
      to_main_index: 2,
      position: null,
      used_at: null,
    };
    expect(seatChangeOutcomeText({ ...base, action: 'moving' }, 'Main 2')).toBe(
      'Seat Change Granted. Moving To Main 2 After This Hand.'
    );
    expect(seatChangeOutcomeText({ ...base, action: 'swapping' }, 'Main 2')).toBe(
      'Seat Change Granted. Swapping To Main 2 After This Hand.'
    );
    expect(seatChangeOutcomeText({ ...base, action: 'listed', position: 1 }, 'Main 2')).toBe(
      'Added To The List. You Are Number 1 For Main 2.'
    );
  });
});

describe('the box in the corner', () => {
  it('reads players, tables and the hero place, and offers SEAT CHANGE when available', async () => {
    mocks.rpc.mockResolvedValue({ data: lobby(), error: null });
    const onOpen = vi.fn();
    const onChange = vi.fn();
    render(<CashClusterHUD gameId={GAME} onOpenLobby={onOpen} onSeatChange={onChange} />);
    await waitFor(() => expect(screen.getByText('10')).toBeTruthy());
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('#2')).toBeTruthy();
    fireEvent.click(screen.getByText('Seat Change'));
    expect(onChange).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Open Must Move Lobby/ }));
    expect(onOpen).toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith('fn_cash_game_lobby', { p_game_id: GAME });
  });

  it('shows no button on Main 1, and the list place instead once listed', async () => {
    mocks.rpc.mockResolvedValue({
      data: lobby({
        table_id: MAIN1,
        role: 'main',
        main_index: 1,
        on_main_one: true,
        must_move_position: null,
        seat_change: { available: false, used_at: null, request: null },
      }),
      error: null,
    });
    const { unmount } = render(
      <CashClusterHUD gameId={GAME} onOpenLobby={vi.fn()} onSeatChange={vi.fn()} />
    );
    await waitFor(() => expect(screen.getByText('10')).toBeTruthy());
    expect(screen.queryByText('Seat Change')).toBeNull();
    expect(screen.queryByText(/#\d/)).toBeNull();
    unmount();

    mocks.rpc.mockResolvedValue({
      data: lobby({
        seat_change: {
          available: false,
          used_at: '2026-09-05T00:00:00Z',
          request: { id: 'r', to_table_id: MAIN2, created_at: '', position: 1 },
        },
      }),
      error: null,
    });
    render(<CashClusterHUD gameId={GAME} onOpenLobby={vi.fn()} onSeatChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Seat Change: #1 On The List')).toBeTruthy());
  });
});

describe('the lobby', () => {
  it('lists every table with every chair and stack, the list in join order, and REQUEST on the right tables only', async () => {
    mocks.rpc.mockResolvedValue({ data: lobby(), error: null });
    render(<MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('NLH 0.10/0.25 Action')).toBeTruthy());
    expect(screen.getByText('ACTION')).toBeTruthy();
    expect(screen.getByText('Main 1')).toBeTruthy();
    expect(screen.getAllByText('Main 2').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Feeder').length).toBeGreaterThan(0);
    // every chair: an open one reads Open, a taken one its name and stack
    expect(screen.getByText('Bravo')).toBeTruthy();
    expect(screen.getByText('12.50')).toBeTruthy();
    expect(screen.getAllByText('Open').length).toBe(8);
    // the queue on Main 2
    expect(screen.getByText('1 Waiting To Change Here')).toBeTruthy();
    // the hero's place
    expect(screen.getByText('You Are Number 2 On The Must Move List.')).toBeTruthy();
    // REQUEST: on Main 2 only (not Main 1, not the hero's own feeder)
    expect(screen.getAllByRole('button', { name: 'Request' }).length).toBe(1);
    expect(screen.getByRole('button', { name: 'Request Any Table' })).toBeTruthy();
  });

  it('asks the door with the table, or null for any, and repeats the answer', async () => {
    mocks.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'fn_cash_game_lobby') return { data: lobby(), error: null };
      if (fn === 'fn_cash_seat_change_request') {
        return {
          data: {
            ok: true,
            action: args.p_to_table_id ? 'moving' : 'listed',
            request_id: 'r',
            to_table_id: args.p_to_table_id ?? null,
            to_table_name: null,
            to_role: 'main',
            to_main_index: 2,
            position: args.p_to_table_id ? null : 1,
            used_at: null,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });
    render(<MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Request' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Request' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('fn_cash_seat_change_request', {
        p_game_id: GAME,
        p_to_table_id: MAIN2,
      })
    );
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith(
        'Seat Change Granted. Moving To Main 2 After This Hand.'
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Request Any Table' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('fn_cash_seat_change_request', {
        p_game_id: GAME,
        p_to_table_id: null,
      })
    );
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith(
        'Added To The List. You Are Number 1 For Any Table.'
      )
    );
  });

  it('a refusal is shown in the player words and nothing else changes', async () => {
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'fn_cash_game_lobby') return { data: lobby(), error: null };
      return { data: null, error: { message: 'SEAT_CHANGE_USED: you have used your seat change' } };
    });
    render(<MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Request Any Table' })).toBeTruthy()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Request Any Table' }));
    await waitFor(() =>
      expect(mocks.toast.warning).toHaveBeenCalledWith(
        'You Have Used Your Seat Change For This Game.'
      )
    );
  });

  it('a listed request shows the number and can be cancelled; a pending move is stated', async () => {
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'fn_cash_game_lobby')
        return {
          data: lobby({
            seat_change: {
              available: false,
              used_at: '2026-09-05T00:00:00Z',
              request: { id: 'r', to_table_id: MAIN2, created_at: '', position: 1 },
            },
          }),
          error: null,
        };
      if (fn === 'fn_cash_seat_change_cancel')
        return { data: { ok: true, cancelled: 1 }, error: null };
      return { data: null, error: null };
    });
    render(<MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/You Are Number 1 On The List For Main 2\./)).toBeTruthy()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Request' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('fn_cash_seat_change_cancel', { p_game_id: GAME })
    );
    expect(mocks.toast.info).toHaveBeenCalledWith('Seat Change Request Cancelled.');
  });

  it('states a pending move in the engine words', async () => {
    mocks.rpc.mockResolvedValue({
      data: lobby({
        seat_change: { available: false, used_at: null, request: null },
        pending_move: {
          id: 'm',
          to_table_id: MAIN1,
          to_table_name: 'NLH Main',
          to_role: 'main',
          to_main_index: 1,
          reason: 'must_move',
          announced: true,
          swap: false,
          held: false,
        },
      }),
      error: null,
    });
    render(<MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText('Seat Open On Main 1. Moving After This Hand.')).toBeTruthy()
    );
  });
});

describe('the tab follows the chair', () => {
  const TABLE_PAGE = readFileSync(resolve(__dirname, '../src/pages/TablePage.tsx'), 'utf8');
  const MULTI = readFileSync(resolve(__dirname, '../src/pages/MultiTablePage.tsx'), 'utf8');

  it('an embedded TablePage reports the move instead of navigating', () => {
    expect(TABLE_PAGE).toMatch(
      /case 'SEAT_MOVED': \{[\s\S]*?if \(embeddedTableId\) \{[\s\S]*?onTableInfoUpdate\?\.\(\{ movedToTableId: d\.to_table_id \}\);\s*break;\s*\}\s*navigate\(`\/table\/\$\{d\.to_table_id\}`, \{ replace: true \}\);/
    );
  });

  it('MultiTablePage re-points the tab in place and never touches activeIndex', () => {
    const block = MULTI.slice(
      MULTI.indexOf('if (updates.movedToTableId && updates.movedToTableId !== tableId)')
    );
    expect(block.length).toBeGreaterThan(0);
    const body = block.slice(0, block.indexOf('return next;'));
    expect(body).toMatch(/next\[idx\] = \{\s*id: dest,/);
    expect(body).not.toMatch(/activeIndex/);
    expect(body).toMatch(/return prev\.filter\(\(t\) => t\.id !== tableId\)/);
  });

  it('the corner box and the lobby are wired on every cluster table, and only there', () => {
    expect(TABLE_PAGE).toMatch(
      /\{!tableState\.isTournament && tableState\.clusterId && \(\s*<CashClusterHUD/
    );
    expect(TABLE_PAGE).toMatch(
      /<MustMoveLobbyModal\s+isOpen=\{showMustMoveLobby\}\s+gameId=\{tableState\.clusterId\}/
    );
    expect(TABLE_PAGE).toMatch(/case 'SEAT_MOVE_HELD': \{/);
  });
});
