/**
 * THE MUST MOVE CLIENT, AUDITED (2026-09-09, lane H of the must-move audit).
 *
 * Every pin here is a defect that was live on 2026-09-09 or a rule the audit
 * was asked to prove:
 *
 *   - the lobby printed the database's own code ("GAME_NOT_FOUND: <uuid>") and
 *     the corner kept a lit SEAT CHANGE button for a game that was gone;
 *   - the 5 s poll has to stop the moment the lobby closes, and on unmount;
 *   - a refusal from the seat-change door reads as house copy, never SQL;
 *   - every caller state fn_cash_game_lobby can return renders as its own
 *     thing: Main 1 (no seat change, off the list), a feeder (the button, the
 *     list place, used), not seated (the waitlist place);
 *   - JOIN GAME wore .tlm-close, and metallic-popups.css paints every
 *     `[class*='-close']` in a dialog as steel close hardware with !important;
 *   - a must-move re-pointed the tab and left the address bar naming the old
 *     table, so a reload re-opened a table the hero had already left;
 *   - the corner and the lobby are on the #SmarterCasinoRealism chassis: the
 *     shared tokens with fallbacks, no :hover, illuminated pills, no em dash.
 */
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));

import {
  CashClusterHUD,
  CASH_CLUSTER_HUD_POLL_MS,
} from '../../src/components/table/CashClusterHUD';
import {
  MustMoveLobbyModal,
  MUST_MOVE_LOBBY_POLL_MS,
} from '../../src/components/table/MustMoveLobbyModal';
import {
  LOBBY_READ_FALLBACK,
  LOBBY_READ_REFUSALS,
  isGameGone,
  lobbyReadErrorText,
} from '../../src/components/table/mustMoveLobbyCopy';
import {
  SEAT_CHANGE_REFUSALS,
  seatChangeRefusalText,
  type CashGameLobby,
} from '../../src/services/cashGameLobby';
import { formatPopupText } from '../../src/utils/popupStyle';

const ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const GAME = 'g-1';
const MAIN1 = 't-main1';
const MAIN2 = 't-main2';
const FEEDER = 't-feeder';
const HERO = 'u-hero';

const seat = (n: number, user: string | null, alias: string | null, stack = 20) => ({
  seat_number: n,
  user_id: user,
  alias,
  stack,
  is_sitting_out: false,
  joined_game_at: null,
});

function lobby(overrides: Partial<NonNullable<CashGameLobby['me']>> = {}): CashGameLobby {
  return {
    game: {
      id: GAME,
      name: 'NLH 1/2 Madness',
      template_name: 'madness',
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
        name: 'NLH 1/2 Madness',
        role: 'main',
        main_index: 1,
        lifecycle: 'live',
        status: 'running',
        max_players: 6,
        seated: 6,
        open_seats: 0,
        seat_change_queue: 0,
        seats: [1, 2, 3, 4, 5, 6].map((n) => seat(n, `m1-${n}`, `Main One ${n}`)),
      },
      {
        id: MAIN2,
        name: 'NLH 1/2 Madness Main 2',
        role: 'main',
        main_index: 2,
        lifecycle: 'live',
        status: 'running',
        max_players: 6,
        seated: 2,
        open_seats: 4,
        seat_change_queue: 0,
        seats: [seat(1, 'p-a', 'Alpha'), seat(4, 'p-b', 'Bravo')],
      },
      {
        id: FEEDER,
        name: 'NLH 1/2 Madness Feeder',
        role: 'feeder',
        main_index: null,
        lifecycle: 'live',
        status: 'running',
        max_players: 6,
        seated: 2,
        open_seats: 4,
        seat_change_queue: 0,
        seats: [seat(2, HERO, 'Hero', 25), seat(5, 'p-c', 'Charlie', 40)],
      },
    ],
    must_move_list: [
      {
        position: 1,
        user_id: 'p-a',
        alias: 'Alpha',
        table_id: MAIN2,
        table_name: 'NLH 1/2 Madness Main 2',
        role: 'main',
        main_index: 2,
        joined_at: '',
      },
      {
        position: 2,
        user_id: HERO,
        alias: 'Hero',
        table_id: FEEDER,
        table_name: 'NLH 1/2 Madness Feeder',
        role: 'feeder',
        main_index: null,
        joined_at: '',
      },
    ],
    waitlist: { waiting: 1 },
    seat_changes_requested: 0,
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

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

function deferredRpc() {
  let resolve!: (reply: { data: unknown; error: unknown }) => void;
  const promise = new Promise<{ data: unknown; error: unknown }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('a player can leave the game waiting list', () => {
  const queued = () =>
    lobby({ seated: false, table_id: null, waitlist: { on_list: true, position: 2, waiting: 3 } });
  const show = () =>
    render(<MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />);

  it('shows the caller place and cancels through the game door, then refreshes it', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: queued(), error: null })
      .mockResolvedValueOnce({ data: { ok: true, cancelled: 1, released_offers: 1 }, error: null })
      .mockResolvedValue({
        data: lobby({ seated: false, waitlist: { on_list: false, position: null, waiting: 2 } }),
        error: null,
      });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Leave Waiting List' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('fn_cash_game_leave_waitlist', { p_game_id: GAME })
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Leave Waiting List' })).toBeNull()
    );
    expect(mocks.toast.info).toHaveBeenCalledWith('You Have Left The Waiting List.');
  });

  it.each([
    { seated: true, waitlist: { on_list: true, position: 2, waiting: 3 } },
    { seated: false, waitlist: { on_list: false, position: null, waiting: 3 } },
    { seated: false, waitlist: null },
  ])('does not offer cancellation to a seated or unlisted viewer (%j)', async (me) => {
    mocks.rpc.mockResolvedValue({ data: lobby(me), error: null });
    show();
    await screen.findByText('NLH 1/2 Madness');
    expect(screen.queryByRole('button', { name: 'Leave Waiting List' })).toBeNull();
  });

  it.each([
    { data: null, error: { message: 'database secret 42501' } },
    { data: { ok: false, cancelled: 0 }, error: null },
    { data: { ok: true, cancelled: -1 }, error: null },
    { data: { ok: true, cancelled: '1' }, error: null },
  ])(
    'keeps the caller queued and uses house copy for a failed or malformed reply (%j)',
    async (reply) => {
      mocks.rpc.mockResolvedValueOnce({ data: queued(), error: null }).mockResolvedValue(reply);
      show();
      fireEvent.click(await screen.findByRole('button', { name: 'Leave Waiting List' }));
      await waitFor(() =>
        expect(mocks.toast.warning).toHaveBeenCalledWith(
          'Could Not Leave The Waiting List. Please Try Again.'
        )
      );
      expect(mocks.toast.info).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Leave Waiting List' })).toBeEnabled();
      expect(screen.getByText('You Are Number 2 On The Waiting List.')).toBeTruthy();
    }
  );

  it('ignores a late cancellation after close and allows only one same-render request', async () => {
    const reply = deferredRpc();
    mocks.rpc.mockResolvedValueOnce({ data: queued(), error: null }).mockReturnValue(reply.promise);
    const props = { gameId: GAME, currentTableId: FEEDER, onClose: vi.fn() };
    const { rerender } = render(<MustMoveLobbyModal isOpen {...props} />);
    const button = await screen.findByRole('button', { name: 'Leave Waiting List' });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(
      mocks.rpc.mock.calls.filter(([name]) => name === 'fn_cash_game_leave_waitlist')
    ).toHaveLength(1);
    rerender(<MustMoveLobbyModal isOpen={false} {...props} />);
    await act(async () =>
      reply.resolve({ data: { ok: true, cancelled: 1, released_offers: 1 }, error: null })
    );
    expect(mocks.toast.info).not.toHaveBeenCalled();
    expect(mocks.toast.warning).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
});

describe('lobby replies belong to the current game and opening', () => {
  it('does not restore the previous game when its read finishes last', async () => {
    const oldRead = deferredRpc();
    const current = lobby();
    current.game = { ...current.game, id: 'g-2', name: 'The Current Game' };
    mocks.rpc
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValue({ data: current, error: null });
    const { rerender } = render(
      <MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />
    );
    rerender(
      <MustMoveLobbyModal isOpen gameId="g-2" currentTableId="other-table" onClose={vi.fn()} />
    );
    await screen.findByText('The Current Game');
    await act(async () => oldRead.resolve({ data: lobby(), error: null }));
    expect(screen.queryByText('NLH 1/2 Madness')).toBeNull();
    expect(screen.getByText('The Current Game')).toBeTruthy();
  });

  it('hides old game actions immediately while the replacement game is loading', async () => {
    const nextRead = deferredRpc();
    mocks.rpc
      .mockResolvedValueOnce({ data: lobby(), error: null })
      .mockReturnValue(nextRead.promise);
    const { rerender } = render(
      <MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />
    );
    await screen.findByRole('button', { name: 'Request Any Table' });
    rerender(
      <MustMoveLobbyModal isOpen gameId="g-2" currentTableId="other-table" onClose={vi.fn()} />
    );
    expect(screen.queryByRole('button', { name: 'Request Any Table' })).toBeNull();
    expect(screen.queryByText('NLH 1/2 Madness')).toBeNull();
  });

  it('ignores a late join after the lobby is closed and reopened', async () => {
    const joinReply = deferredRpc();
    mocks.rpc.mockImplementation((name: string) =>
      name === 'fn_cash_game_join'
        ? joinReply.promise
        : Promise.resolve({ data: lobby({ seated: false }), error: null })
    );
    const onClose = vi.fn();
    const onGoToTable = vi.fn();
    const props = { gameId: GAME, currentTableId: FEEDER, onClose, onGoToTable };
    const { rerender } = render(<MustMoveLobbyModal isOpen {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Join Game' }));
    rerender(<MustMoveLobbyModal isOpen={false} {...props} />);
    rerender(<MustMoveLobbyModal isOpen {...props} />);
    await act(async () =>
      joinReply.resolve({ data: { ok: true, action: 'seat', table_id: MAIN2 }, error: null })
    );
    expect(onGoToTable).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Join Game' }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it('does not resurrect the old corner after a game switch', async () => {
    const oldRead = deferredRpc();
    const current = lobby({ seat_change: { available: false, used_at: null, request: null } });
    current.game.id = 'g-2';
    mocks.rpc
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValue({ data: current, error: null });
    const { rerender } = render(
      <CashClusterHUD gameId={GAME} onOpenLobby={vi.fn()} onSeatChange={vi.fn()} />
    );
    rerender(<CashClusterHUD gameId="g-2" onOpenLobby={vi.fn()} onSeatChange={vi.fn()} />);
    await flush();
    await act(async () => oldRead.resolve({ data: lobby(), error: null }));
    expect(screen.queryByText('Seat Change')).toBeNull();
  });

  it('does not replace a fresh corner update with an older poll', async () => {
    const oldRead = deferredRpc();
    const current = lobby({ seat_change: { available: false, used_at: null, request: null } });
    mocks.rpc
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValue({ data: current, error: null });
    const props = { gameId: GAME, onOpenLobby: vi.fn(), onSeatChange: vi.fn() };
    const { rerender } = render(<CashClusterHUD refreshKey={0} {...props} />);
    rerender(<CashClusterHUD refreshKey={1} {...props} />);
    await flush();
    await act(async () => oldRead.resolve({ data: lobby(), error: null }));
    expect(screen.queryByText('Seat Change')).toBeNull();
  });

  it('does not navigate from a corner join after a game switch', async () => {
    const joinReply = deferredRpc();
    const waiting = lobby({ seated: false, waitlist: { on_list: true, waiting: 1, position: 1 } });
    mocks.rpc.mockImplementation((name: string) =>
      name === 'fn_cash_game_join'
        ? joinReply.promise
        : Promise.resolve({ data: waiting, error: null })
    );
    const props = { onGoToTable: vi.fn(), onOpenLobby: vi.fn(), onSeatChange: vi.fn() };
    const { rerender } = render(<CashClusterHUD gameId={GAME} {...props} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'A Chair Is Open In This Game - Take It' })
    );
    rerender(<CashClusterHUD gameId="g-2" {...props} />);
    await act(async () =>
      joinReply.resolve({ data: { ok: true, action: 'seat', table_id: MAIN2 }, error: null })
    );
    expect(props.onGoToTable).not.toHaveBeenCalled();
  });

  it('does not let an old failure erase a newer successful read', async () => {
    const oldRead = deferredRpc();
    mocks.rpc
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValue({ data: lobby(), error: null });
    const props = { gameId: GAME, onOpenLobby: vi.fn(), onSeatChange: vi.fn() };
    const { rerender } = render(<CashClusterHUD refreshKey={0} {...props} />);
    rerender(<CashClusterHUD refreshKey={1} {...props} />);
    await screen.findByText('Seat Change');
    await act(async () => oldRead.resolve({ data: null, error: { message: 'GAME_NOT_FOUND' } }));
    expect(screen.getByText('Seat Change')).toBeTruthy();
  });

  it('suppresses a seat-change response after unmount', async () => {
    const reply = deferredRpc();
    mocks.rpc.mockImplementation((name: string) =>
      name === 'fn_cash_seat_change_request'
        ? reply.promise
        : Promise.resolve({ data: lobby(), error: null })
    );
    const { unmount } = render(
      <MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Request Any Table' }));
    unmount();
    await act(async () =>
      reply.resolve({ data: { ok: true, action: 'listed', position: 1 }, error: null })
    );
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.warning).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('submits one join for two taps before React renders and still honors its reply', async () => {
    const reply = deferredRpc();
    mocks.rpc.mockImplementation((name: string) =>
      name === 'fn_cash_game_join'
        ? reply.promise
        : Promise.resolve({ data: lobby({ seated: false }), error: null })
    );
    const onGoToTable = vi.fn();
    const onClose = vi.fn();
    render(
      <MustMoveLobbyModal
        isOpen
        gameId={GAME}
        currentTableId={FEEDER}
        onClose={onClose}
        onGoToTable={onGoToTable}
      />
    );
    const button = await screen.findByRole('button', { name: 'Join Game' });
    act(() => {
      button.click();
      button.click();
    });
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'fn_cash_game_join')).toHaveLength(1);
    await act(async () =>
      reply.resolve({ data: { ok: true, action: 'seat', table_id: MAIN2 }, error: null })
    );
    expect(onGoToTable).toHaveBeenCalledExactlyOnceWith(MAIN2);
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.toast.success).toHaveBeenCalledOnce();
  });
});

beforeEach(() => {
  mocks.rpc.mockReset();
  for (const k of Object.keys(mocks.toast) as (keyof typeof mocks.toast)[])
    mocks.toast[k].mockReset();
});

/* ─── The words ─────────────────────────────────────────────────────────── */

describe('a failed lobby read is house copy, never the database code', () => {
  it('names the game-gone case and falls back to one sentence for everything else', () => {
    expect(
      lobbyReadErrorText({ message: 'GAME_NOT_FOUND: 2f3a1b2c-0000-4000-8000-000000000000' })
    ).toBe('This Game Is No Longer Here.');
    expect(lobbyReadErrorText({ message: 'NOT_AUTHENTICATED: sign in first' })).toBe(
      'Sign In To See The Lobby.'
    );
    expect(lobbyReadErrorText({ message: 'PGRST002: could not query the database' })).toBe(
      LOBBY_READ_FALLBACK
    );
    expect(lobbyReadErrorText(undefined)).toBe(LOBBY_READ_FALLBACK);
    expect(isGameGone({ message: 'GAME_NOT_FOUND: x' })).toBe(true);
    expect(isGameGone({ message: 'NOT_AUTHENTICATED: x' })).toBe(false);
    /* Never a uuid, never the code itself. */
    for (const s of Object.values(LOBBY_READ_REFUSALS)) {
      expect(s).not.toMatch(/[0-9a-f]{8}-/);
      expect(s).not.toMatch(/_/);
    }
  });

  it('every sentence the corner and the lobby can say is Title Case with no em dash', () => {
    const sentences = [
      ...Object.values(LOBBY_READ_REFUSALS),
      LOBBY_READ_FALLBACK,
      ...Object.values(SEAT_CHANGE_REFUSALS),
    ];
    for (const s of sentences) {
      expect(s, s).not.toMatch(/—/);
      expect(formatPopupText(s), s).toBe(s);
    }
    for (const rel of [
      'src/components/table/mustMoveLobbyCopy.ts',
      'src/components/table/MustMoveLobbyModal.tsx',
      'src/components/table/MustMoveLobbyModal.css',
      'src/components/table/CashClusterHUD.tsx',
      'src/components/table/CashClusterHUD.css',
    ]) {
      expect(read(rel), rel).not.toMatch(/—/);
    }
  });

  it('every code the live seat-change door raises has a sentence', () => {
    /* Read off pg_get_functiondef(fn_cash_seat_change_request) on production,
       2026-09-09. NOT_AUTHENTICATED and GAME_NOT_FOUND fall to the generic
       line by design - the door only raises them to a caller who has no seat
       to change in the first place. */
    const raised = [
      'PLATFORM_FROZEN',
      'SEAT_CHANGE_MANUAL_GAME',
      'NOT_IN_GAME',
      'SEAT_CHANGE_NOT_FROM_MAIN',
      'SEAT_CHANGE_TABLE_CLOSING',
      'MOVE_PENDING',
      'SEAT_CHANGE_USED',
      'SEAT_CHANGE_TABLE_UNAVAILABLE',
      'SEAT_CHANGE_NEVER_TO_MAIN',
      'SEAT_CHANGE_SAME_TABLE',
      'SEAT_CHANGE_NO_OTHER_TABLE',
    ];
    for (const code of raised) {
      expect(SEAT_CHANGE_REFUSALS[code], code).toBeTruthy();
      const text = seatChangeRefusalText({ message: `${code}: some sql words here` });
      expect(text).toBe(SEAT_CHANGE_REFUSALS[code]);
      expect(text).not.toContain('sql');
      expect(text).not.toContain(code);
    }
  });
});

/* ─── The lobby ─────────────────────────────────────────────────────────── */

describe('the lobby on a read that fails', () => {
  it('shows the sentence, not the code, and drops the figures when the game is gone', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: lobby(), error: null });
    const { rerender } = render(
      <MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />
    );
    await screen.findByText('NLH 1/2 Madness');

    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: 'GAME_NOT_FOUND: 2f3a1b2c-0000-4000-8000-000000000000' },
    });
    /* A closed lobby does not read; re-open it so the next read runs. */
    rerender(
      <MustMoveLobbyModal isOpen={false} gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />
    );
    rerender(<MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />);
    await screen.findByText('This Game Is No Longer Here.');
    expect(screen.queryByText(/GAME_NOT_FOUND/)).toBeNull();
    expect(screen.queryByText(/2f3a1b2c/)).toBeNull();
    /* The figures for the ghost are gone with it - and so is JOIN GAME. */
    expect(screen.queryByText('NLH 1/2 Madness')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Join Game' })).toBeNull();
  });

  it('keeps the last read on screen under the notice for a passing failure', async () => {
    vi.useFakeTimers();
    try {
      mocks.rpc.mockResolvedValueOnce({ data: lobby(), error: null });
      const { unmount } = render(
        <MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />
      );
      await flush();
      expect(screen.getByText('NLH 1/2 Madness')).toBeTruthy();
      mocks.rpc.mockResolvedValue({ data: null, error: { message: 'PGRST002: schema cache' } });
      // A failed poll retains this opening; close/reopen deliberately starts a new one.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MUST_MOVE_LOBBY_POLL_MS);
      });
      expect(mocks.rpc).toHaveBeenCalledTimes(2);
      expect(screen.getByText(LOBBY_READ_FALLBACK)).toBeTruthy();
      expect(screen.getByText('NLH 1/2 Madness')).toBeTruthy();
      expect(screen.queryByText(/PGRST002/)).toBeNull();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the 5 s poll', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads on open, every tick while open, and stops the moment the lobby closes', async () => {
    mocks.rpc.mockResolvedValue({ data: lobby(), error: null });
    const { rerender } = render(
      <MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />
    );
    await flush();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(MUST_MOVE_LOBBY_POLL_MS);
    });
    await flush();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);

    rerender(
      <MustMoveLobbyModal isOpen={false} gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />
    );
    await act(async () => {
      vi.advanceTimersByTime(MUST_MOVE_LOBBY_POLL_MS * 5);
    });
    await flush();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('stops on unmount', async () => {
    mocks.rpc.mockResolvedValue({ data: lobby(), error: null });
    const { unmount } = render(
      <MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />
    );
    await flush();
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(MUST_MOVE_LOBBY_POLL_MS * 5);
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('the corner polls every ten seconds and stops on unmount too', async () => {
    mocks.rpc.mockResolvedValue({ data: lobby(), error: null });
    const { unmount } = render(
      <CashClusterHUD gameId={GAME} onOpenLobby={vi.fn()} onSeatChange={vi.fn()} />
    );
    await flush();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(CASH_CLUSTER_HUD_POLL_MS);
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(CASH_CLUSTER_HUD_POLL_MS * 5);
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
});

describe('every caller state the read can return', () => {
  it('on Main 1: no seat change offered, off the list, in the main game', async () => {
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
    render(<MustMoveLobbyModal isOpen gameId={GAME} currentTableId={MAIN1} onClose={vi.fn()} />);
    await screen.findByText('You Are In The Main Game.');
    expect(screen.queryByText(/On The Must Move List/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request Any Table' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request' })).toBeNull();
    expect(screen.queryByText('Seat Change')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Join Game' })).toBeNull();
  });

  it('on a feeder with the change used: the used note, no button, still on the list', async () => {
    mocks.rpc.mockResolvedValue({
      data: lobby({
        seat_change: { available: false, used_at: '2026-09-09T00:00:00Z', request: null },
      }),
      error: null,
    });
    render(<MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />);
    await screen.findByText('Seat Change Used For This Game.');
    expect(screen.getByText('You Are Number 2 On The Must Move List.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request Any Table' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request' })).toBeNull();
  });

  it('a pending move of ANY reason replaces the seat-change note - the sentence above says where', async () => {
    for (const reason of ['must_move', 'break', 'balance', 'seat_change']) {
      mocks.rpc.mockResolvedValue({
        data: lobby({
          seat_change: { available: false, used_at: null, request: null },
          pending_move: {
            id: 'm',
            to_table_id: MAIN2,
            to_table_name: 'NLH 1/2 Madness Main 2',
            to_role: 'main',
            to_main_index: 2,
            reason,
            announced: true,
            swap: false,
            held: false,
          },
        }),
        error: null,
      });
      const { unmount } = render(
        <MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />
      );
      /* must_move reads "Seat Open On Main 2. Moving After This Hand."; the
         other three "... Moving To Main 2 After This Hand." - one helper,
         pendingMoveNotice, already pinned sentence by sentence elsewhere. */
      const sentence = await screen.findByText(/After This Hand\./);
      expect(sentence.textContent).toContain('Main 2');
      expect(screen.queryByText('Seat Change Not Available Right Now.')).toBeNull();
      unmount();
    }
  });

  it('not seated, on the waitlist: the place, JOIN GAME, and the corner offers the list place', async () => {
    mocks.rpc.mockResolvedValue({
      data: lobby({
        seated: false,
        table_id: null,
        seat_number: null,
        stack: null,
        role: null,
        main_index: null,
        lifecycle: null,
        on_main_one: null,
        must_move_position: null,
        seat_change: { available: false, used_at: null, request: null },
        waitlist: { waiting: 3, position: 2, on_list: true },
      }),
      error: null,
    });
    const { unmount } = render(
      <MustMoveLobbyModal isOpen gameId={GAME} currentTableId={FEEDER} onClose={vi.fn()} />
    );
    await screen.findByRole('button', { name: 'Join Game' });
    expect(screen.queryByText('Your Seat')).toBeNull();
    unmount();

    /* The corner: chairs are open in the cluster (Main 2 and the feeder), so
       the offer is the chair, in the game and not "here". */
    render(<CashClusterHUD gameId={GAME} onOpenLobby={vi.fn()} onSeatChange={vi.fn()} />);
    await screen.findByText('Chair Open In This Game: Take A Seat');
  });

  it('not seated, on the waitlist, nothing open: the corner reads the place on the list', async () => {
    const full = lobby({
      seated: false,
      table_id: null,
      on_main_one: null,
      must_move_position: null,
      seat_change: { available: false, used_at: null, request: null },
      waitlist: { waiting: 3, position: 2, on_list: true },
    });
    for (const t of full.tables) {
      t.open_seats = 0;
    }
    mocks.rpc.mockResolvedValue({ data: full, error: null });
    const onOpen = vi.fn();
    render(<CashClusterHUD gameId={GAME} onOpenLobby={onOpen} onSeatChange={vi.fn()} />);
    const btn = await screen.findByText('Waitlist: #2 Of 3');
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalled();
  });
});

describe('the corner on a game that is gone', () => {
  it('drops a lit SEAT CHANGE the moment the read says GAME_NOT_FOUND, and keeps it through a passing failure', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: lobby(), error: null });
    const { rerender } = render(
      <CashClusterHUD gameId={GAME} refreshKey={0} onOpenLobby={vi.fn()} onSeatChange={vi.fn()} />
    );
    await screen.findByText('Seat Change');

    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'PGRST002: schema cache' } });
    rerender(
      <CashClusterHUD gameId={GAME} refreshKey={1} onOpenLobby={vi.fn()} onSeatChange={vi.fn()} />
    );
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Seat Change')).toBeTruthy();

    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'GAME_NOT_FOUND: g-1' } });
    rerender(
      <CashClusterHUD gameId={GAME} refreshKey={2} onOpenLobby={vi.fn()} onSeatChange={vi.fn()} />
    );
    await waitFor(() => expect(screen.queryByText('Seat Change')).toBeNull());
  });
});

/* ─── The wiring ────────────────────────────────────────────────────────── */

describe('the tab and the address bar follow the chair', () => {
  const MULTI = read('src/pages/MultiTablePage.tsx');

  it('re-pointing the route table replaces the URL with the destination, outside the updater', () => {
    const block = MULTI.slice(
      MULTI.indexOf('const updateTableInfo = useCallback('),
      MULTI.indexOf('const tableInfoCbRef')
    );
    expect(block).toMatch(/routeTableIdRef\.current === tableId/);
    expect(block).toMatch(
      /navigateRef\.current\(`\/table\/\$\{updates\.movedToTableId\}`, \{ replace: true \}\);/
    );
    /* Before setTables, never inside it: an updater must stay pure. */
    expect(block.indexOf('navigateRef.current(')).toBeLessThan(
      block.indexOf('setTables((prev) =>')
    );
    /* The live navigate: BrowserRouter hands out a new one per location, and
       this callback is cached per table id. */
    expect(MULTI).toMatch(
      /const navigateRef = useRef\(navigate\);\s*navigateRef\.current = navigate;/
    );
    expect(MULTI).toMatch(
      /const routeTableIdRef = useRef\(routeTableId\);\s*routeTableIdRef\.current = routeTableId;/
    );
  });

  it('JOIN GAME does not borrow the close control class', () => {
    const modal = read('src/components/table/MustMoveLobbyModal.tsx');
    expect(modal).toMatch(/className="mml-join"/);
    expect(modal).not.toMatch(/className="tlm-close mml-join"/);
    /* metallic-popups.css: every [class*='-close'] in a dialog is steel close
       hardware, with !important. The action must not match it. */
    const popups = read('src/styles/metallic-popups.css');
    expect(popups).toContain("[class*='-close']");
  });
});

/* ─── The chassis ───────────────────────────────────────────────────────── */

describe('the corner and the lobby are on the realism chassis', () => {
  const HUD = read('src/components/table/CashClusterHUD.css');
  const MODAL = read('src/components/table/MustMoveLobbyModal.css');

  it('draw from the shared vocabulary, every token with its fallback', () => {
    for (const css of [HUD, MODAL]) {
      expect(css).toContain('#SMARTERCASINOREALISM');
      const vars = css.match(/var\(--realism-[a-z-]+[^)]*\)/g) ?? [];
      expect(vars.length).toBeGreaterThan(6);
      for (const v of vars) expect(v, `${v} has no fallback`).toContain(',');
      expect(css).toContain('var(--realism-bevel');
      expect(css).toContain('var(--realism-cavity');
      expect(css).toContain('var(--realism-chrome-hot');
    }
  });

  it('adds no hover rule and keeps the press in :active', () => {
    for (const css of [HUD, MODAL]) {
      expect(css).not.toMatch(/^[^\n]*[.:#[][^\n]*:hover[^\n]*\{/m);
      expect(css).toMatch(/:active:not\(:disabled\)/);
    }
  });

  it('the actions are illuminated pills, the notice a bevelled plate, sizes unchanged', () => {
    expect(HUD).toMatch(/\.cch-seat-change \{[\s\S]*?border-radius: 999px;/);
    expect(HUD).toMatch(/\.cch-seat-change::after \{/);
    expect(HUD).toMatch(/\.cch-move-notice \{[\s\S]*?max-width: 240px;/);
    expect(HUD).toMatch(/\.cch-move-notice \{[\s\S]*?pointer-events: none;/);
    expect(HUD).toMatch(
      /@media \(max-width: 600px\)[\s\S]*\.cch-move-notice \{[\s\S]*?max-width: 200px/
    );
    expect(MODAL).toMatch(/\.mml-btn,\s*\.mml-join \{[\s\S]*?border-radius: 999px;/);
    /* metallic-popups.css bevels every dialog button with !important; the
       glow has to be restated at higher specificity or the pill flattens. */
    expect(MODAL).toMatch(/\.mml-panel \.mml-btn,\s*\.mml-panel \.mml-join \{[\s\S]*?!important;/);
    /* No flat Facebook rectangles left: the old solid faces are gone. */
    expect(HUD).not.toMatch(/background: #1877f2;/);
    expect(MODAL).not.toMatch(/background: #1877f2;/);
    expect(MODAL).not.toMatch(/background: rgba\(255, 255, 255, 0\.04\);/);
  });

  it('no gold, no amber, no browns (design-guidelines.md)', () => {
    for (const css of [HUD, MODAL]) {
      expect(css).not.toMatch(/--realism-gold/);
      expect(css).not.toMatch(/#ffd700|#ffc93c|#d4af37|#ffb74d/i);
    }
  });
});

describe('the Must Move dialog owns keyboard focus', () => {
  function FocusHarness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open Game Lobby</button>
        <MustMoveLobbyModal
          isOpen={open}
          gameId={GAME}
          currentTableId={FEEDER}
          onClose={() => setOpen(false)}
        />
      </>
    );
  }

  async function openLobby() {
    mocks.rpc.mockResolvedValue({
      data: lobby({
        seated: false,
        seat_change: { available: false, used_at: null, request: null },
      }),
      error: null,
    });
    render(<FocusHarness />);
    const trigger = screen.getByRole('button', { name: 'Open Game Lobby' });
    trigger.focus();
    fireEvent.click(trigger);
    const close = screen.getByRole('button', { name: 'Close' });
    await waitFor(() => expect(close).toHaveFocus());
    return { trigger, close, join: await screen.findByRole('button', { name: 'Join Game' }) };
  }

  it('focuses Close on entry and contains forward, reverse and escaped focus', async () => {
    const { close, join, trigger } = await openLobby();
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(join).toHaveFocus();
    fireEvent.keyDown(join, { key: 'Tab', shiftKey: true });
    expect(close).toHaveFocus();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Tab' });
    expect(join).toHaveFocus();
    expect(mocks.rpc.mock.calls.every(([name]) => name === 'fn_cash_game_lobby')).toBe(true);
  });

  it.each(['Close', 'Escape'])(
    'returns focus to the trigger after %s dismissal',
    async (method) => {
      const { close, trigger } = await openLobby();
      if (method === 'Close') fireEvent.click(close);
      else fireEvent.keyDown(close, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(trigger).toHaveFocus();
    }
  );
});
