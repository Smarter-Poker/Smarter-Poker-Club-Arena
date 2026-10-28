import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.unmock('../../src/core/MasterBus');

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  viewer: 'hero',
  waiting: 0,
  position: null as number | null,
  onList: false,
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: state.rpc } }));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: Object.assign(
    (select: (s: unknown) => unknown) => select({ user: { id: state.viewer } }),
    { getState: () => ({ user: { id: state.viewer } }) }
  ),
}));
vi.mock('../../src/lib/analytics', () => ({ capture: vi.fn() }));
vi.mock('../../src/services/queuedCashoutWatcher', () => ({
  hasQueuedCashout: () => false,
  awaitQueuedCashouts: vi.fn(),
}));
import { ClusterWaitlistCallToAction } from '../../src/components/table/ClusterWaitlistCallToAction';
import { useCashGameLobby } from '../../src/components/table/useCashGameLobby';
import { joinCashGame, leaveCashGameWaitlist } from '../../src/services/cashGameLobby';

const lobby = (game = 'game') => ({
  game: { id: game },
  tables: [],
  must_move_list: [],
  waitlist: { waiting: state.waiting },
  me: {
    user_id: state.viewer,
    seated: false,
    waitlist: { on_list: state.onList, position: state.position, waiting: state.waiting },
  },
});
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  state.viewer = 'hero';
  state.waiting = 0;
  state.position = null;
  state.onList = false;
  state.rpc.mockReset().mockImplementation(async (rpc: string, args: { p_game_id: string }) => {
    if (rpc === 'fn_cash_game_join') {
      state.waiting = 1;
      state.position = 1;
      state.onList = true;
      return { data: { ok: true, action: 'waitlisted', position: 1 }, error: null };
    }
    if (rpc === 'fn_cash_game_leave_waitlist') {
      state.waiting = 0;
      state.position = null;
      state.onList = false;
      return { data: { ok: true, cancelled: 1, released_offers: 0 }, error: null };
    }
    return { data: lobby(args.p_game_id), error: null };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the felt repeats the game lobby waiting list', () => {
  it('shows the real game queue and opens its lobby without submitting a join', async () => {
    state.waiting = 3;
    state.position = 1;
    state.onList = true;
    const open = vi.fn();
    render(<ClusterWaitlistCallToAction gameId="game" onClick={open} />);
    await flush();
    const button = screen.getByRole('button', {
      name: 'You Are On The Waiting List, Position 1 Of 3',
    });
    fireEvent.click(button);
    expect(open).toHaveBeenCalledOnce();
    expect(state.rpc).toHaveBeenCalledExactlyOnceWith('fn_cash_game_lobby', { p_game_id: 'game' });
  });

  it('refreshes every confirmed join and leave immediately, including within one hand', async () => {
    render(<ClusterWaitlistCallToAction gameId="game" onClick={() => {}} />);
    await flush();
    expect(screen.getByRole('button').textContent).toContain('0 Waiting');
    await act(async () => {
      await joinCashGame('game');
    });
    expect(screen.getByRole('button').textContent).toContain('Position 1 Of 1');
    await act(async () => {
      await leaveCashGameWaitlist('game');
    });
    expect(screen.getByRole('button').textContent).toContain('0 Waiting');
    expect(screen.getByRole('button').textContent).not.toContain('You Are On');
  });

  it('shares a successful lobby read with the mounted felt without another poll', async () => {
    function LobbyReader({ gameId = 'game' }: { gameId?: string }) {
      const { lobby: current, load } = useCashGameLobby(gameId, true, 5000);
      return <button onClick={() => void load()}>Lobby {current?.waitlist.waiting}</button>;
    }
    render(
      <>
        <ClusterWaitlistCallToAction gameId="game" onClick={() => {}} />
        <LobbyReader />
        <LobbyReader gameId="other-game" />
      </>
    );
    await flush();
    state.waiting = 4;
    state.position = 1;
    state.onList = true;
    fireEvent.click(screen.getAllByRole('button', { name: 'Lobby 0' })[1]);
    await flush();
    // A different queue never supplies this game's membership.
    expect(
      screen.getByRole('button', { name: 'Table Full · 0 Waiting. Join The Waiting List' })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lobby 0' }));
    await flush();
    expect(
      screen.getByRole('button', { name: 'You Are On The Waiting List, Position 1 Of 4' })
    ).toBeTruthy();
  });

  it('does not claim an unread or failed game queue has zero waiting', async () => {
    let resolve!: (value: unknown) => void;
    state.rpc.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    render(<ClusterWaitlistCallToAction gameId="game" onClick={() => {}} />);
    expect(screen.getByRole('button').textContent).toContain('Reading The Waiting List');
    expect(screen.getByRole('button').textContent).not.toContain('0 Waiting');
    await act(async () => {
      resolve({ data: null, error: new Error('Offline') });
    });
    expect(screen.getByRole('button').textContent).toContain('Waiting List Unavailable');
    expect(screen.getByRole('button').textContent).not.toContain('Join The Waiting List');
  });

  it('forgets the old game and viewer immediately while reading their replacement', async () => {
    state.waiting = 2;
    state.position = 2;
    state.onList = true;
    const view = render(<ClusterWaitlistCallToAction gameId="game" onClick={() => {}} />);
    await flush();
    expect(screen.getByRole('button').textContent).toContain('Position 2 Of 2');
    state.rpc.mockImplementation(() => new Promise(() => {}));
    state.viewer = 'other';
    view.rerender(<ClusterWaitlistCallToAction gameId="next" onClick={() => {}} />);
    expect(screen.getByRole('button').textContent).toContain('Reading The Waiting List');
    expect(screen.getByRole('button').textContent).not.toContain('Position 2');
  });

  it('routes the full cluster footer through its own queue rather than the table queue', () => {
    const page = readFileSync('src/pages/TablePage.tsx', 'utf8');
    expect(page).toMatch(/tableState\.clusterId\s*\?\s*\(\s*<ClusterWaitlistCallToAction/);
    expect(page).toMatch(
      /<ClusterWaitlistCallToAction[\s\S]*?gameId=\{tableState\.clusterId\}[\s\S]*?onClick=\{handleOpenWaitlist\}/
    );
  });
});
