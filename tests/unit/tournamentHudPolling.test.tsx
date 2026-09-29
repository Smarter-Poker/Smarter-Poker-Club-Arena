/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT HUD — it listens, catches up, and never paints a stale owner
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This file used to drive a 45-second poll. The poll is gone (2026-09-22): the
 * bar now hears the engine's broadcasts through the bus TablePage feeds, and
 * re-reads the row only where a broadcast could have been missed. What is
 * pinned here is what a player can see or what the database pays for:
 *
 *   1. FAILURES ARE PRODUCTION-SHAPED. The previous version of this file
 *      stubbed `getTournament` with `mockRejectedValue`, which production never
 *      did: the service reported the error itself and RESOLVED null, the bar
 *      vanished, and the failure counter reset on every read. Here the REAL
 *      TournamentService runs against a Supabase stub that answers the way
 *      PostgREST does - `{ data: null, error: {...} }` or a missing row - so a
 *      HUD that forgot `throwOnError` fails these tests.
 *   2. ONE READER: one read in flight, one trailing, whatever arrives.
 *   3. NO STALE OWNER: an answer for another tournament or another account is
 *      never drawn.
 *   4. CATCH-UP happens on exactly the triggers it should, and not otherwise.
 *   5. BREAKS show their own countdown; the level clock runs on the ENGINE's
 *      clock, not this device's.
 *   6. UNMOUNT leaves nothing behind that can still read, even while another
 *      consumer (TablePage) keeps the channel and keeps relaying.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, screen } from '@testing-library/react';

const fx = vi.hoisted(() => ({
  user: { id: 'viewer' } as { id: string } | null,
  engineStatus: 'connected',
  engineListeners: new Set<(status: string) => void>(),
  presentation: new Set<(event: any) => void>(),
  bus: new Map<string, Set<(event: any) => void>>(),
  channelKeys: [] as string[],
  channels: [] as Array<{ topic: string; state: string; joinPush: { ref: string } }>,
  tournamentReads: [] as string[],
  playerReads: [] as string[],
  tournamentAnswer: (_id: string): unknown => ({ data: null, error: null }),
  playersAnswer: (_id: string): unknown => ({ data: [], error: null }),
  reportError: vi.fn(),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: fx.user }) }));
vi.mock('../../src/services/EngineStateClient', () => ({
  engineChannelClient: {
    getStatus: () => fx.engineStatus,
    onStatusChange: (listener: (status: string) => void) => {
      fx.engineListeners.add(listener);
      return () => fx.engineListeners.delete(listener);
    },
  },
}));
vi.mock('../../src/services/RealtimeChannelService', () => ({
  realtimeChannelService: {
    subscribeToTournament: (_id: string, callbacks: any) => {
      fx.presentation.add(callbacks.onEvent);
      return () => fx.presentation.delete(callbacks.onEvent);
    },
  },
}));
/** A real publish/subscribe bus, so the relay and the HUD meet the way they do in the app. */
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (name: string, handler: (event: any) => void) => {
      const set = fx.bus.get(name) ?? new Set();
      fx.bus.set(name, set);
      set.add(handler);
      return () => set.delete(handler);
    },
    subscribeDebounced: () => () => {},
    emit: (name: string, payload: unknown) => {
      for (const handler of [...(fx.bus.get(name) ?? [])]) {
        handler({ type: name, payload, timestamp: '' });
      }
    },
    getOrCreateChannel: (key: string) => {
      fx.channelKeys.push(key);
      const channel: any = { on: () => channel, subscribe: () => channel };
      return channel;
    },
    removeRegisteredChannel: () => {},
  },
}));
/**
 * PostgREST, as the client library presents it: every query resolves to
 * `{ data, error }`. A failure is an `error` OBJECT on a resolved result, never
 * a rejected promise - which is exactly why a caller that does not ask for
 * `throwOnError` never sees one.
 */
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const answer = () => {
        if (table === 'tournaments') {
          const id = String(filters.id);
          fx.tournamentReads.push(id);
          return Promise.resolve(fx.tournamentAnswer(id));
        }
        if (table === 'tournament_players') {
          const id = String(filters.tournament_id);
          fx.playerReads.push(id);
          return Promise.resolve(fx.playersAnswer(id));
        }
        return Promise.resolve({ data: null, error: null });
      };
      const chain: any = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        in: () => chain,
        maybeSingle: () => answer(),
        then: (ok: any, no: any) => answer().then(ok, no),
      };
      return chain;
    },
    getChannels: () => fx.channels,
  },
  getAuthUser: async () => null,
}));
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...args: unknown[]) => fx.reportError(...args),
}));

import { TournamentHUD } from '../../src/components/tournament/TournamentHUD';
import { tournamentService } from '../../src/services/TournamentService';
import { relayTournamentEvent } from '../../src/services/tournamentEventBridge';
import { recordServerTime, __resetServerClock } from '../../src/utils/serverClock';
import { masterBus } from '../../src/core/MasterBus';

const SAFETY_READ_MS = 300_000;
const FIELD_READ_DELAY_MS = 10_000;

const STRUCTURE = JSON.stringify([
  { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 },
  { level: 2, smallBlind: 50, bigBlind: 100, ante: 0, durationMinutes: 10 },
  { level: 3, smallBlind: 75, bigBlind: 150, ante: 0, durationMinutes: 10 },
  { level: 4, smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 10 },
  { level: 5, smallBlind: 150, bigBlind: 300, ante: 25, durationMinutes: 10 },
  { level: 6, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 10 },
]);

const iso = (ms: number) => new Date(ms).toISOString();

/** A running tournament whose current level began just now. */
const running = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'Test MTT',
  status: 'RUNNING',
  start_time: iso(Date.now() - 60_000),
  started_at: iso(Date.now() - 60_000),
  current_level: 0,
  level_started_at: iso(Date.now()),
  blind_structure: STRUCTURE,
  on_break: false,
  break_ends_at: null,
  ...over,
});

const ok = (row: unknown) => ({ data: row, error: null });
/** What PostgREST hands back when the request fails. */
const PG_ERROR = {
  message: 'TypeError: NetworkError when attempting to fetch resource.',
  details: '',
  hint: '',
  code: '',
};
const failed = () => ({ data: null, error: PG_ERROR });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(props: Partial<React.ComponentProps<typeof TournamentHUD>> = {}) {
  const utils = render(<TournamentHUD tournamentId="t1" {...props} />);
  await flush();
  return utils;
}

/** Stand in for TablePage: it holds `t-break-<id>` and relays every broadcast. */
async function broadcast(type: string, payload: Record<string, unknown> = {}, id = 't1') {
  await act(async () => {
    relayTournamentEvent(id, { type, payload });
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function emit(name: string, payload: Record<string, unknown>) {
  await act(async () => {
    (masterBus.emit as (n: string, p: unknown) => void)(name, payload);
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function engine(status: string) {
  await act(async () => {
    fx.engineStatus = status;
    for (const listener of [...fx.engineListeners]) listener(status);
    await vi.advanceTimersByTimeAsync(0);
  });
}

let documentHidden = false;
async function setDocumentHidden(value: boolean) {
  documentHidden = value;
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
  });
}

const hudBar = () => document.querySelector('.tournament-hud-bar');
const reportsFrom = (context: string) =>
  fx.reportError.mock.calls.filter((call) => call[1] === context).length;

/** Each test starts an hour after the last, so the relay's 1.5s dedupe never spans two. */
let clockBase = Date.parse('2026-09-22T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  clockBase += 3_600_000;
  vi.setSystemTime(clockBase);
  __resetServerClock();
  fx.user = { id: 'viewer' };
  fx.engineStatus = 'connected';
  fx.engineListeners.clear();
  fx.presentation.clear();
  fx.bus.clear();
  fx.channelKeys.length = 0;
  fx.channels.length = 0;
  fx.tournamentReads.length = 0;
  fx.playerReads.length = 0;
  fx.tournamentAnswer = () => ok(running());
  fx.playersAnswer = () => ({ data: [], error: null });
  fx.reportError.mockReset();
  documentHidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => documentHidden);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── 1. PRODUCTION-SHAPED FAILURES ──────────────────────────────────────────

describe('a failed read is a real failure, and the bar survives it', () => {
  it('keeps the last confirmed row on screen when a read errors', async () => {
    await mount();
    expect(hudBar()).toBeTruthy();
    expect(screen.getByText('25 / 50')).toBeTruthy();

    fx.tournamentAnswer = () => failed();
    await broadcast('late_reg_closed');
    expect(fx.tournamentReads).toHaveLength(2);

    expect(hudBar(), 'a transient error must not take the bar away').toBeTruthy();
    expect(screen.getByText('25 / 50')).toBeTruthy();
    // The HUD asked for the error (throwOnError), so the service did not
    // swallow it into a null and file its own report.
    expect(reportsFrom('TournamentService.Error_fetching_tournament')).toBe(0);
    expect(reportsFrom('TournamentHUD.load')).toBe(1);
  });

  it('treats a missing row as unknown, not as gone', async () => {
    await mount();
    fx.tournamentAnswer = () => ok(null);
    await broadcast('late_reg_closed');
    expect(hudBar()).toBeTruthy();
    expect(screen.getByText('25 / 50')).toBeTruthy();
    expect(reportsFrom('TournamentHUD.load')).toBe(1);
  });

  it('backs off on a run of failures, reports only the first two, and recovers', async () => {
    fx.tournamentAnswer = () => failed();
    await mount();
    expect(fx.tournamentReads).toHaveLength(1);
    expect(hudBar(), 'nothing confirmed yet, so nothing is drawn').toBeNull();

    // 5s, 10s, 20s, 40s, 80s, 160s, then capped at five minutes.
    const ladder = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000];
    for (const [i, gap] of ladder.entries()) {
      await advance(gap - 1);
      expect(fx.tournamentReads, `retry ${i + 1} came early`).toHaveLength(i + 1);
      await advance(1);
      expect(fx.tournamentReads, `retry ${i + 1} never came`).toHaveLength(i + 2);
    }

    expect(reportsFrom('TournamentHUD.load'), 'a sustained fault must not report per retry').toBe(
      2
    );
    expect(reportsFrom('TournamentService.Error_fetching_tournament')).toBe(0);

    // The network comes back: the next retry paints the bar.
    fx.tournamentAnswer = () => ok(running());
    await advance(300_000);
    expect(hudBar()).toBeTruthy();
    const recovered = fx.tournamentReads.length;

    // Healthy again: the next read is the five-minute safety read, not a retry.
    await advance(SAFETY_READ_MS - 1);
    expect(fx.tournamentReads).toHaveLength(recovered);
    await advance(1);
    expect(fx.tournamentReads).toHaveLength(recovered + 1);

    // And the ladder starts again from 5s: the counter really reset.
    fx.tournamentAnswer = () => failed();
    await advance(SAFETY_READ_MS);
    expect(fx.tournamentReads).toHaveLength(recovered + 2);
    await advance(5_000);
    expect(fx.tournamentReads).toHaveLength(recovered + 3);
  });
});

// ─── 2. ONE READER ──────────────────────────────────────────────────────────

describe('one read in flight, one trailing', () => {
  it('coalesces a burst of triggers into a single trailing read', async () => {
    const gates: Array<ReturnType<typeof deferred<unknown>>> = [];
    fx.tournamentAnswer = () => {
      const gate = deferred<unknown>();
      gates.push(gate);
      return gate.promise;
    };
    await mount();
    expect(fx.tournamentReads).toHaveLength(1);

    for (let i = 0; i < 4; i++) {
      await emit('TOURNAMENT_UPDATED', { tournamentId: 't1', status: 'late_reg_closed' });
    }
    expect(fx.tournamentReads, 'nothing new while one is in flight').toHaveLength(1);

    await act(async () => {
      gates[0].resolve(ok(running()));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fx.tournamentReads, 'exactly one trailing read').toHaveLength(2);

    await act(async () => {
      gates[1].resolve(ok(running()));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fx.tournamentReads).toHaveLength(2);
  });
});

// ─── 3. NO STALE OWNER ──────────────────────────────────────────────────────

describe('an answer for another tournament or account is never drawn', () => {
  it('drops a late row after the table switches tournament', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<unknown>>>();
    fx.tournamentAnswer = (id) => {
      const gate = deferred<unknown>();
      gates.set(id, gate);
      return gate.promise;
    };
    const { rerender } = await mount();
    rerender(<TournamentHUD tournamentId="t2" />);
    await flush();
    expect(fx.tournamentReads).toEqual(['t1', 't2']);

    // t1's answer lands late, at level 5.
    await act(async () => {
      gates.get('t1')!.resolve(ok(running({ id: 't1', current_level: 4 })));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hudBar(), "t1's row must not be drawn on t2's table").toBeNull();

    await act(async () => {
      gates.get('t2')!.resolve(ok(running({ id: 't2', current_level: 1 })));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hudBar()).toBeTruthy();
    expect(screen.getByText('50 / 100')).toBeTruthy();
    expect(screen.queryByText('150 / 300')).toBeNull();
  });

  it("drops a late field read after the account switches, so one player's rank is never another's", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<unknown>>>();
    fx.playersAnswer = () => {
      const gate = deferred<unknown>();
      gates.set(fx.user!.id, gate);
      return gate.promise;
    };
    fx.user = { id: 'alice' };
    const { rerender } = await mount();
    fx.user = { id: 'bob' };
    rerender(<TournamentHUD tournamentId="t1" />);
    await flush();
    expect(fx.playerReads).toHaveLength(2);

    const field = [
      { user_id: 'alice', chips: 9000, status: 'playing' },
      { user_id: 'bob', chips: 4000, status: 'playing' },
      { user_id: 'carol', chips: 6000, status: 'playing' },
      { user_id: 'dave', chips: 1000, status: 'playing' },
    ];
    // Alice's read lands after the switch: rank 1 is hers, not Bob's.
    await act(async () => {
      gates.get('alice')!.resolve({ data: field, error: null });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText('Rank'), "alice's answer must not paint bob's bar").toBeNull();

    await act(async () => {
      gates.get('bob')!.resolve({ data: field, error: null });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Rank')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });
});

// ─── 4. CATCH-UP ────────────────────────────────────────────────────────────

describe('catch-up reads happen where a broadcast could have been missed', () => {
  it('reads once on mount and then waits: no 45-second poll', async () => {
    await mount();
    expect(fx.tournamentReads).toHaveLength(1);
    expect(fx.playerReads).toHaveLength(1);
    await advance(SAFETY_READ_MS - 1_000);
    expect(fx.tournamentReads, 'the only recurring read is the five-minute one').toHaveLength(1);
    expect(fx.playerReads).toHaveLength(1);
  });

  it('reads when the shared channel joins, and again on every rejoin', async () => {
    await mount();
    expect(fx.tournamentReads).toHaveLength(1);

    // TablePage's subscribe lands after the mount read: the gap is closed.
    const channel = { topic: 'realtime:t-break-t1', state: 'joining', joinPush: { ref: '4' } };
    fx.channels.push(channel);
    await advance(2_000);
    expect(fx.tournamentReads).toHaveLength(1);
    channel.state = 'joined';
    await advance(1_000);
    expect(fx.tournamentReads).toHaveLength(2);
    await advance(10_000);
    expect(fx.tournamentReads, 'staying joined is not a rejoin').toHaveLength(2);

    // The socket drops and the channel rejoins.
    channel.state = 'errored';
    await advance(1_000);
    channel.state = 'joined';
    channel.joinPush.ref = '9';
    await advance(1_000);
    expect(fx.tournamentReads).toHaveLength(3);

    // A rejoin quicker than one look still changes the join reference.
    channel.joinPush.ref = '12';
    await advance(1_000);
    expect(fx.tournamentReads).toHaveLength(4);
  });

  it('reads when the tab comes back, and never while it is hidden', async () => {
    await mount();
    await setDocumentHidden(true);
    await broadcast('late_reg_closed');
    await advance(SAFETY_READ_MS * 2);
    expect(fx.tournamentReads, 'a hidden tab asks nothing').toHaveLength(1);

    await setDocumentHidden(false);
    expect(fx.tournamentReads).toHaveLength(2);
  });

  it('reads when the engine link comes back, but not on its first connect', async () => {
    fx.engineStatus = 'connecting';
    await mount();
    await engine('connected');
    expect(fx.tournamentReads, 'the first connect is covered by the mount read').toHaveLength(1);

    await engine('reconnecting');
    expect(fx.tournamentReads).toHaveLength(1);
    await engine('connected');
    expect(fx.tournamentReads).toHaveLength(2);
  });

  it('reads a few times after a level runs out with no level_up, then stops', async () => {
    // Ten seconds left on a ten-minute level.
    const stuck = running({ level_started_at: iso(Date.now() - 590_000) });
    fx.tournamentAnswer = () => ok(stuck);
    await mount();
    expect(screen.getByText('0:10')).toBeTruthy();

    await advance(10_000); // the level runs out
    await advance(4_000);
    expect(fx.tournamentReads, 'a short grace first').toHaveLength(1);
    await advance(2_000);
    expect(fx.tournamentReads).toHaveLength(2);
    await advance(10_000);
    expect(fx.tournamentReads).toHaveLength(3);
    await advance(30_000);
    expect(fx.tournamentReads).toHaveLength(4);
    await advance(75_000);
    expect(fx.tournamentReads).toHaveLength(5);
    await advance(150_000);
    expect(fx.tournamentReads, 'bounded: four catch-up reads, not a poll').toHaveLength(5);
  });

  it('needs no catch-up when the level_up arrives on time', async () => {
    fx.tournamentAnswer = () => ok(running({ level_started_at: iso(Date.now() - 590_000) }));
    await mount();
    await advance(10_000);
    fx.tournamentAnswer = () =>
      ok(running({ current_level: 1, level_started_at: iso(Date.now()) }));
    await broadcast('level_up', { level: 1, smallBlind: 50, bigBlind: 100, ante: 0 });
    expect(fx.tournamentReads).toHaveLength(2);
    expect(screen.getByText('50 / 100')).toBeTruthy();
    await advance(150_000);
    expect(fx.tournamentReads).toHaveLength(2);
  });

  it('reads on a level_up that skips levels, and once per level across both carriers', async () => {
    fx.tournamentAnswer = () => ok(running({ current_level: 2 }));
    await mount();

    // A level it already shows, and an older one: nothing to ask.
    await broadcast('level_up', { level: 2 });
    await broadcast('level_up', { level: 1 });
    expect(fx.tournamentReads).toHaveLength(1);

    // Two levels ahead of the row: a gap, so read.
    fx.tournamentAnswer = () => ok(running({ current_level: 4 }));
    await broadcast('level_up', { level: 4 });
    expect(fx.tournamentReads).toHaveLength(2);
    expect(screen.getByText('150 / 300')).toBeTruthy();

    // The table socket delivers the next level first; the broadcast after it is free.
    fx.tournamentAnswer = () => ok(running({ current_level: 5 }));
    await emit('TOURNAMENT_LEVEL_UP', { tournament_id: 't1', new_level: 5 });
    await broadcast('level_up', { level: 5 });
    expect(fx.tournamentReads).toHaveLength(3);
    // Another tournament's level is not this bar's business.
    await emit('TOURNAMENT_LEVEL_UP', { tournament_id: 't9', new_level: 8 });
    expect(fx.tournamentReads).toHaveLength(3);
  });

  it('re-reads the row on late_reg_closed and the add-on window opening', async () => {
    await mount();
    await broadcast('late_reg_closed', { prizePool: 1000 });
    expect(fx.tournamentReads).toHaveLength(2);
    await broadcast('ADDON_PERIOD_START', { endsAt: iso(Date.now() + 60_000) });
    expect(fx.tournamentReads).toHaveLength(3);
  });
});

describe('eliminations move the field, not the row', () => {
  it('does not re-read the tournament on a bust, and trails the field read', async () => {
    await mount();
    expect(fx.playerReads).toHaveLength(1);
    await broadcast('player_eliminated', { userId: 'u-1', position: 40 });
    await advance(3_000);
    await broadcast('player_eliminated', { userId: 'u-2', position: 39 });
    await broadcast('player_eliminated', { userId: 'u-3', position: 38 });
    expect(fx.tournamentReads, 'a bust is not a reason to read 95 columns').toHaveLength(1);
    expect(fx.playerReads).toHaveLength(1);

    await advance(FIELD_READ_DELAY_MS - 3_001);
    expect(fx.playerReads).toHaveLength(1);
    await advance(1);
    expect(fx.playerReads, 'three busts, one trailing read').toHaveLength(2);
  });

  it("shows bubble_burst's own count at once, and a trailing read cannot roll it back", async () => {
    const gate = deferred<unknown>();
    let first = true;
    fx.playersAnswer = () => {
      if (first) {
        first = false;
        return { data: new Array(20).fill({ user_id: 'x', chips: 100 }), error: null };
      }
      return gate.promise;
    };
    await mount();
    expect(screen.getByText('20')).toBeTruthy();

    await broadcast('player_eliminated', { userId: 'u-1', position: 19 });
    await advance(FIELD_READ_DELAY_MS);
    expect(fx.playerReads).toHaveLength(2); // in flight, begun before the bubble

    await broadcast('bubble_burst', { playersRemaining: 17 });
    expect(screen.getByText('17')).toBeTruthy();
    expect(fx.tournamentReads).toHaveLength(1);

    // The read that began before the bubble answers 19; the bubble is newer.
    await act(async () => {
      gate.resolve({ data: new Array(19).fill({ user_id: 'x', chips: 100 }), error: null });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('17')).toBeTruthy();
  });
});

describe('a table that is not on screen asks nothing', () => {
  it('does not read while hidden, and reads once when shown', async () => {
    const { rerender } = await mount({ hidden: true });
    expect(fx.tournamentReads).toHaveLength(0);
    expect(fx.playerReads).toHaveLength(0);

    await broadcast('late_reg_closed');
    await broadcast('player_eliminated', { userId: 'u-1', position: 9 });
    await engine('reconnecting');
    await engine('connected');
    await advance(SAFETY_READ_MS * 2);
    expect(fx.tournamentReads).toHaveLength(0);

    rerender(<TournamentHUD tournamentId="t1" hidden={false} />);
    await flush();
    expect(fx.tournamentReads).toHaveLength(1);
    expect(fx.playerReads).toHaveLength(1);
    expect(hudBar()).toBeTruthy();
  });

  it('stops the safety read while hidden, and skips a needless read when shown again', async () => {
    const { rerender } = await mount();
    rerender(<TournamentHUD tournamentId="t1" hidden />);
    await flush();
    await advance(60_000);
    rerender(<TournamentHUD tournamentId="t1" hidden={false} />);
    await flush();
    expect(fx.tournamentReads, 'nothing moved and the row is a minute old').toHaveLength(1);

    rerender(<TournamentHUD tournamentId="t1" hidden />);
    await flush();
    await advance(SAFETY_READ_MS * 3);
    expect(fx.tournamentReads).toHaveLength(1);
    rerender(<TournamentHUD tournamentId="t1" hidden={false} />);
    await flush();
    expect(fx.tournamentReads, 'shown again after the safety interval').toHaveLength(2);
  });

  it('owes a read for what arrived while hidden', async () => {
    const { rerender } = await mount();
    rerender(<TournamentHUD tournamentId="t1" hidden />);
    await flush();
    await broadcast('late_reg_closed');
    expect(fx.tournamentReads).toHaveLength(1);
    rerender(<TournamentHUD tournamentId="t1" hidden={false} />);
    await flush();
    expect(fx.tournamentReads).toHaveLength(2);
  });
});

describe('a finished event retires every listener', () => {
  it('asks nothing more once the row reads COMPLETED', async () => {
    fx.tournamentAnswer = () => ok(running({ status: 'COMPLETED' }));
    await mount();
    expect(fx.tournamentReads).toHaveLength(1);
    expect(screen.getByText('--:--')).toBeTruthy();

    await broadcast('level_up', { level: 3 });
    await broadcast('late_reg_closed');
    await broadcast('player_eliminated', { userId: 'u-1', position: 2 });
    await engine('reconnecting');
    await engine('connected');
    await setDocumentHidden(true);
    await setDocumentHidden(false);
    await advance(SAFETY_READ_MS * 3);
    expect(fx.tournamentReads).toHaveLength(1);
    for (const [name, handlers] of fx.bus) {
      expect(handlers.size, `${name} still has a listener`).toBe(0);
    }
  });

  it('keeps an unrecognised or pre-start status live', async () => {
    fx.tournamentAnswer = () => ok(running({ status: 'ANNOUNCED' }));
    await mount();
    await broadcast('late_reg_closed');
    expect(fx.tournamentReads).toHaveLength(2);
  });

  it('catches the start when no event announces it', async () => {
    fx.tournamentAnswer = () =>
      ok(running({ status: 'REGISTERING', start_time: iso(Date.now() + 20_000) }));
    await mount();
    expect(screen.getByText('--:--')).toBeTruthy();
    // The engine starts it on time and says nothing: no event marks a start.
    fx.tournamentAnswer = () => ok(running());
    await advance(25_000);
    expect(fx.tournamentReads).toHaveLength(2);
    expect(screen.getByText('Next')).toBeTruthy();
    expect(screen.queryByText('--:--')).toBeNull();
  });
});

describe('unmount leaves nothing that can still read', () => {
  it('holds no channel of its own, and a relay after unmount reaches nothing', async () => {
    fx.channels.push({ topic: 'realtime:t-break-t1', state: 'joined', joinPush: { ref: '1' } });
    for (let i = 0; i < 3; i++) {
      const { unmount } = await mount();
      unmount();
    }
    const before = fx.tournamentReads.length;
    expect(fx.channelKeys, 'the HUD binds nothing a sibling could keep alive').toEqual([]);

    // TablePage still holds t-break-t1 and keeps relaying.
    await broadcast('level_up', { level: 3 });
    await broadcast('break_ended', { level: 3 });
    await broadcast('late_reg_closed');
    await broadcast('player_eliminated', { userId: 'u-1', position: 2 });
    await engine('reconnecting');
    await engine('connected');
    await setDocumentHidden(true);
    await setDocumentHidden(false);
    fx.channels[0].joinPush.ref = '2';
    await advance(SAFETY_READ_MS * 2);

    expect(fx.tournamentReads).toHaveLength(before);
    expect(fx.engineListeners.size).toBe(0);
    for (const [name, handlers] of fx.bus) {
      expect(handlers.size, `${name} still has a listener`).toBe(0);
    }
  });
});

// ─── 5. BREAKS AND THE ENGINE'S CLOCK ───────────────────────────────────────

describe('a real break shows its own countdown', () => {
  it('counts down to break_ends_at instead of running the level clock', async () => {
    fx.tournamentAnswer = () =>
      ok(
        running({
          level_started_at: iso(Date.now() - 400_000),
          on_break: true,
          break_ends_at: iso(Date.now() + 180_000),
        })
      );
    await mount();
    expect(screen.getByText('Break')).toBeTruthy();
    expect(screen.getByText('Resumes')).toBeTruthy();
    expect(screen.getByText('3:00')).toBeTruthy();
    expect(screen.queryByText('Next')).toBeNull();
    await advance(60_000);
    expect(screen.getByText('2:00')).toBeTruthy();
  });

  it('says Last Hand while the break has no end stamped yet', async () => {
    fx.tournamentAnswer = () => ok(running({ on_break: true, break_ends_at: null }));
    await mount();
    expect(screen.getByText('Last Hand')).toBeTruthy();
  });

  it('takes the break from the broadcast without a read, and a stale read cannot undo it', async () => {
    await mount();
    const gate = deferred<unknown>();
    fx.tournamentAnswer = () => gate.promise;
    await broadcast('late_reg_closed'); // a read now in flight, answered pre-break

    const endsAt = iso(Date.now() + 240_000);
    await broadcast('tournament_break', { level: 0, phase: 'last_hand', breakEndsAt: null });
    expect(screen.getByText('Last Hand')).toBeTruthy();
    await broadcast('tournament_break_started', { level: 0, breakEndsAt: endsAt });
    expect(screen.getByText('4:00')).toBeTruthy();
    expect(fx.tournamentReads).toHaveLength(2);

    await act(async () => {
      gate.resolve(ok(running()));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Resumes'), 'the older answer must not end the break').toBeTruthy();
    expect(screen.getByText('4:00')).toBeTruthy();
  });

  it('re-reads on break_ended, because the resumed level anchor is not in the broadcast', async () => {
    fx.tournamentAnswer = () =>
      ok(running({ on_break: true, break_ends_at: iso(Date.now() + 5_000) }));
    await mount();
    fx.tournamentAnswer = () => ok(running({ level_started_at: iso(Date.now() - 100_000) }));
    await broadcast('break_ended', { level: 0 });
    expect(fx.tournamentReads).toHaveLength(2);
    expect(screen.getByText('Next')).toBeTruthy();
    expect(screen.getByText('8:20')).toBeTruthy();
  });

  it('catches up when break_ends_at passes and no break_ended arrives, then stops', async () => {
    const onBreak = running({
      level_started_at: iso(Date.now() - 400_000),
      on_break: true,
      break_ends_at: iso(Date.now() + 20_000),
    });
    fx.tournamentAnswer = () => ok(onBreak);
    await mount();
    expect(screen.getByText('0:20')).toBeTruthy();

    await advance(20_000); // the break's end passes, and the release is not heard
    await advance(4_000);
    expect(fx.tournamentReads, 'a short grace first').toHaveLength(1);
    await advance(2_000);
    expect(fx.tournamentReads).toHaveLength(2);
    await advance(300_000);
    expect(fx.tournamentReads, 'bounded: four catch-up reads, not a poll').toHaveLength(5);

    // The next read shows the released level, and the clock is the level's again.
    fx.tournamentAnswer = () => ok(running({ level_started_at: iso(Date.now() - 60_000) }));
    await emit('TOURNAMENT_UPDATED', { tournamentId: 't1', status: 'late_reg_closed' });
    expect(screen.getByText('Next')).toBeTruthy();
    expect(screen.getByText('9:00')).toBeTruthy();
  });

  it('shows the add-on break at the end of the persisted add-on window', async () => {
    fx.tournamentAnswer = () =>
      ok(
        running({
          add_on_available: true,
          addon_break_minutes: 1,
          addon_period_started_at: iso(Date.now() - 15_000),
          addon_period_ends_at: iso(Date.now() + 45_000),
        })
      );
    await mount();
    expect(screen.getByText('Add-On Period')).toBeTruthy();
    expect(screen.getByText('Break')).toBeTruthy();
    expect(screen.getByText('0:45')).toBeTruthy();
  });
});

describe("the level clock runs on the engine's clock", () => {
  it("measures level_started_at against serverNow(), not this device's clock", async () => {
    // This device runs thirty seconds FAST.
    recordServerTime(Date.now() - 30_000);
    // The engine anchored the level one minute ago, on its own clock.
    fx.tournamentAnswer = () =>
      ok(running({ level_started_at: iso(Date.now() - 30_000 - 60_000) }));
    await mount();
    expect(screen.getByText('9:00')).toBeTruthy();
    expect(screen.queryByText('8:30'), 'the device-clock answer').toBeNull();
  });

  it('getCurrentLevelState measures at nowMs when given, and at Date.now() otherwise', () => {
    const anchor = Date.now() - 125_000;
    const row = running({ level_started_at: iso(anchor) }) as any;
    expect(tournamentService.getCurrentLevelState(row, anchor + 5_000).timeRemainingSeconds).toBe(
      595
    );
    expect(tournamentService.getCurrentLevelState(row).timeRemainingSeconds).toBe(475);
  });
});

// ─── 6. WHAT THE STRIP SAYS ─────────────────────────────────────────────────

describe('late registration and the add-on window', () => {
  it('shows late registration while the entry window is open', async () => {
    fx.tournamentAnswer = () => ok(running({ late_reg_levels: 3 }));
    await mount();
    expect(screen.getByText('Late Reg Through Level 3')).toBeTruthy();
  });

  it('shows nothing once the prize pool is finalized', async () => {
    fx.tournamentAnswer = () => ok(running({ late_reg_levels: 3, prize_pool_finalized: true }));
    await mount();
    expect(screen.queryByText(/Late Reg/)).toBeNull();
  });

  it('counts down a minutes window on the engine clock', async () => {
    fx.tournamentAnswer = () =>
      ok(running({ late_reg_mins: 30, started_at: iso(Date.now() - 600_000) }));
    await mount();
    expect(screen.getByText('Late Reg Closes In 20:00')).toBeTruthy();
  });

  it('does not call a level after the entry window an add-on period', async () => {
    // The old approximation: any level inside `addon_levels` after the cap.
    fx.tournamentAnswer = () =>
      ok(running({ late_reg_levels: 1, current_level: 1, addon_cost: 5, addon_levels: 1 }));
    await mount();
    expect(screen.queryByText(/Add-On Period/)).toBeNull();
  });
});

it('shows actual manager hand-for-hand state in the mounted table HUD without replacing rebuy timing', async () => {
  fx.tournamentAnswer = () => ok(running({ late_reg_levels: 1, rebuy_cost: 1 }));
  await mount();
  expect(screen.getByText('Last Rebuy Level')).toBeTruthy();
  act(() => {
    for (const listener of fx.presentation)
      listener({
        type: 'tournament_presentation',
        payload: { handForHand: true },
      });
  });
  expect(screen.getByText('Hand For Hand · Last Rebuy Level')).toBeTruthy();
  act(() => {
    for (const listener of fx.presentation)
      listener({
        type: 'tournament_presentation',
        payload: { handForHand: false },
      });
  });
  expect(screen.queryByText(/Hand For Hand/)).toBeNull();
  expect(screen.getByText('Last Rebuy Level')).toBeTruthy();
});
