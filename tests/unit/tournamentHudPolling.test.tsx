/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT HUD — the POLL, exercised rather than grepped
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The specs that shipped with this poll asserted the SOURCE TEXT of the file —
 * that a constant existed, that a `clearInterval` appeared somewhere. Two of
 * them were satisfied by unrelated lines (the unmount cleanup matched the
 * "stops polling" assertion), and one actively PINNED the bug it was supposed
 * to be guarding: it required the exact allow-list `status !== 'RUNNING' &&
 * status !== 'REGISTERING'`, which is what stopped the poll dead on ANNOUNCED.
 *
 * A source-text assertion cannot tell you whether a timer fires. This file
 * drives the component with fake timers and a stubbed service and asserts what
 * actually HAPPENS, because the whole reason this poll exists is that a HUD
 * which silently stops updating looks exactly like a HUD that is up to date.
 *
 * WHAT IS BEING PROTECTED, in the order the incidents happened:
 *
 *   1. it polls at all, on a cadence, without a realtime event;
 *   2. a LIVE-but-unrecognised status (ANNOUNCED) does not stop it;
 *   3. a TERMINAL status does stop it;
 *   4. a run of failures backs the cadence off instead of giving up;
 *   5. a recovery returns it to the normal cadence;
 *   6. unmount stops everything.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, screen } from '@testing-library/react';

const presentation = vi.hoisted(() => ({ listeners: new Set<(event: any) => void>() }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'viewer' } }) }));
vi.mock('../../src/services/EngineStateClient', () => ({
  engineChannelClient: { onStatusChange: () => () => {} },
}));
vi.mock('../../src/services/RealtimeChannelService', () => ({
  realtimeChannelService: {
    subscribeToTournament: (_id: string, callbacks: any) => {
      presentation.listeners.add(callbacks.onEvent);
      return () => presentation.listeners.delete(callbacks.onEvent);
    },
  },
}));

const POLL_MS = 45_000;
const BACKOFF_MS = 300_000;

/** The service call the HUD polls. Swapped per test. */
const getTournament = vi.fn();

vi.mock('../../src/services/TournamentService', () => ({
  tournamentService: {
    getTournament: (...args: unknown[]) => getTournament(...args),
    // The HUD calls this during render; a fixed answer keeps the render pure
    // so the test is only ever observing the POLL.
    getCurrentLevelState: () => ({
      currentLevel: { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 },
      nextLevel: null,
      timeRemainingSeconds: 600,
      levelIndex: 0,
    }),
  },
}));

/**
 * A realtime channel that never fires ON ITS OWN - the poll is the subject of
 * most of this file, and the point of the poll is that it works WITHOUT this.
 *
 * It does now RECORD its handlers, because the HUD has gained a second reason to
 * hold a channel: the engine's `t-break-<id>` broadcast, which is how a level
 * change reaches it instantly instead of up to 45s (or, backed off, 5 minutes)
 * later. Recording is enough to let one test drive that path deliberately; no
 * test gets an event it did not send.
 */
const bus = vi.hoisted(() => ({
  broadcastHandlers: [] as Array<(message: unknown) => void>,
  channelKeys: [] as string[],
}));
vi.mock('../../src/core/MasterBus', () => {
  const makeChannel = () => {
    const channel: any = {
      on: (kind: string, _opts: unknown, handler: (message: unknown) => void) => {
        if (kind === 'broadcast' && typeof handler === 'function') {
          bus.broadcastHandlers.push(handler);
        }
        return channel;
      },
      subscribe: () => channel,
    };
    return channel;
  };
  return {
    masterBus: {
      getOrCreateChannel: (key: string) => {
        bus.channelKeys.push(key);
        return makeChannel();
      },
      removeRegisteredChannel: () => {},
      emit: () => {},
      subscribe: () => () => {},
    },
  };
});

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }),
  },
}));

const reportError = vi.fn();
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));

import { TournamentHUD } from '../../src/components/tournament/TournamentHUD';

const running = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'Test MTT',
  status: 'RUNNING',
  started_at: new Date().toISOString(),
  current_level: 0,
  level_started_at: new Date().toISOString(),
  blind_structure: JSON.stringify([
    { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 },
  ]),
  ...over,
});

/** Advance fake time and let every promise the poll created settle. */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Render and let the mount-time fetch resolve. */
async function mount(id = 't1') {
  const utils = render(<TournamentHUD tournamentId={id} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return utils;
}

beforeEach(() => {
  vi.useFakeTimers();
  getTournament.mockReset();
  reportError.mockReset();
  bus.broadcastHandlers.length = 0;
  bus.channelKeys.length = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TournamentHUD polling — behaviour, not source text', () => {
  it('re-reads the tournament on a cadence with no realtime event at all', async () => {
    getTournament.mockResolvedValue(running());
    await mount();

    // The mount read.
    expect(getTournament).toHaveBeenCalledTimes(1);

    await tick(POLL_MS);
    expect(getTournament).toHaveBeenCalledTimes(2);

    await tick(POLL_MS);
    expect(getTournament).toHaveBeenCalledTimes(3);
  });

  it('does NOT stop on ANNOUNCED — a live status the allow-list used to kill', async () => {
    /* THE REGRESSION. The first version stopped the poll on anything that was
       not RUNNING / REGISTERING / LATE_REG. ANNOUNCED is a perfectly ordinary
       pre-registration state, so a HUD whose first read returned it never
       polled again — and nothing restarts the interval, so it was still dead
       when the event went RUNNING. That is the exact single point of failure
       the poll was added to remove. */
    getTournament.mockResolvedValue(running({ status: 'ANNOUNCED' }));
    await mount();
    expect(getTournament).toHaveBeenCalledTimes(1);

    await tick(POLL_MS);
    expect(getTournament, 'ANNOUNCED must keep polling').toHaveBeenCalledTimes(2);

    // And it picks the change up when the event actually starts.
    getTournament.mockResolvedValue(running({ status: 'RUNNING' }));
    await tick(POLL_MS);
    expect(getTournament).toHaveBeenCalledTimes(3);
  });

  it('does not stop on a status it has never heard of', async () => {
    // Fail safe: an unknown status costs one read every 45s. A stopped clock
    // costs the player the blind level.
    getTournament.mockResolvedValue(running({ status: 'SOMETHING_NEW' }));
    await mount();
    await tick(POLL_MS);
    expect(getTournament).toHaveBeenCalledTimes(2);
  });

  it('stops for good once the event is COMPLETED', async () => {
    getTournament.mockResolvedValue(running({ status: 'COMPLETED' }));
    await mount();
    expect(getTournament).toHaveBeenCalledTimes(1);

    await tick(POLL_MS * 4);
    expect(getTournament, 'a finished event has nothing left to ask').toHaveBeenCalledTimes(1);
  });

  it('stops for good once the event is CANCELLED', async () => {
    getTournament.mockResolvedValue(running({ status: 'CANCELLED' }));
    await mount();
    await tick(POLL_MS * 4);
    expect(getTournament).toHaveBeenCalledTimes(1);
  });

  it('backs off after a run of failures instead of giving up, and RECOVERS', async () => {
    /* The first version stopped the poll permanently after five failures.
       Five failures is about three minutes — a tab that went through a tunnel —
       and because PersistentTableLayer hides rather than unmounts, permanently
       meant the rest of the session. */
    getTournament.mockRejectedValue(new Error('offline'));
    await mount();
    expect(getTournament).toHaveBeenCalledTimes(1); // failure 1

    // failures 2..5
    for (let i = 0; i < 4; i++) await tick(POLL_MS);
    expect(getTournament).toHaveBeenCalledTimes(5);

    // The normal cadence is no longer in force...
    await tick(POLL_MS);
    expect(getTournament, 'should be on the backoff cadence now').toHaveBeenCalledTimes(5);

    // ...but it has NOT given up: the backoff interval still fires.
    await tick(BACKOFF_MS);
    expect(getTournament, 'the poll must survive a sustained fault').toHaveBeenCalledTimes(6);

    // Now the network comes back. The next backoff tick succeeds and the
    // normal cadence is restored.
    //
    // Asserted as a CADENCE, not as a running total. The recovering read
    // reinstalls the 45s interval at the moment it resolves, so whether that
    // interval also fires before this advance finishes depends on exactly where
    // in the 300s window the backoff tick landed — an arithmetic detail of the
    // fake clock, not a property of the component. (The first draft of this
    // test asserted 7 and got 8, for precisely that reason.) What matters is
    // that afterwards a 45s step produces a read and it is no longer waiting
    // 300s between them.
    getTournament.mockResolvedValue(running());
    await tick(BACKOFF_MS);
    const afterRecovery = getTournament.mock.calls.length;
    expect(afterRecovery, 'the recovering read must happen').toBeGreaterThanOrEqual(7);

    await tick(POLL_MS);
    expect(
      getTournament.mock.calls.length,
      'recovery must restore the 45s cadence, not stay on the 5-minute backoff'
    ).toBeGreaterThan(afterRecovery);
  });

  it('reports the first failures only, not one every 45 seconds forever', async () => {
    getTournament.mockRejectedValue(new Error('offline'));
    await mount();
    for (let i = 0; i < 6; i++) await tick(POLL_MS);

    expect(reportError.mock.calls.length).toBeGreaterThan(0);
    expect(
      reportError.mock.calls.length,
      'a persistent fault must not file a report per tick'
    ).toBeLessThanOrEqual(2);
  });

  it('stops polling when it unmounts', async () => {
    getTournament.mockResolvedValue(running());
    const { unmount } = await mount();
    await tick(POLL_MS);
    expect(getTournament).toHaveBeenCalledTimes(2);

    unmount();
    await tick(POLL_MS * 3);
    expect(getTournament, 'no timer may outlive the component').toHaveBeenCalledTimes(2);
  });
});

it('shows actual manager hand-for-hand state in the mounted table HUD without replacing rebuy timing', async () => {
  getTournament.mockResolvedValue(running({ late_reg_levels: 1, rebuy_cost: 1 }));
  await mount();
  expect(screen.getByText('Last Rebuy Level')).toBeTruthy();
  act(() => {
    for (const listener of presentation.listeners)
      listener({
        type: 'tournament_presentation',
        payload: { handForHand: true },
      });
  });
  expect(screen.getByText('Hand For Hand · Last Rebuy Level')).toBeTruthy();
  act(() => {
    for (const listener of presentation.listeners)
      listener({
        type: 'tournament_presentation',
        payload: { handForHand: false },
      });
  });
  expect(screen.queryByText(/Hand For Hand/)).toBeNull();
  expect(screen.getByText('Last Rebuy Level')).toBeTruthy();
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CARRIER THAT ALREADY EXISTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The poll above is a backstop, and until now it was the ENTIRE mechanism: this
 * HUD had no bus listener of any kind, and its `tournaments` postgres_changes
 * subscription cannot fire because that table is not in the publication
 * (5,477,895 writes over 117 columns). A seated player could be looking at the
 * wrong blind level for up to 45 seconds, or five minutes after a sustained
 * fault, while betting.
 *
 * The engine has been broadcasting `level_up` on `t-break-<id>` the whole time,
 * over Realtime Broadcast, which needs no publication and no row image.
 * TournamentPage has consumed it since it was written. These tests assert this
 * HUD now does too, and that it re-reads the AUTHORITATIVE row rather than
 * trusting the broadcast payload - the payload's `level` is a zero-based index
 * and carries no `level_started_at`, and that arithmetic has shipped wrong twice.
 */
describe('TournamentHUD - the engine broadcast', () => {
  it('joins the tournament broadcast channel, not only its own', async () => {
    getTournament.mockResolvedValue(running());
    render(<TournamentHUD tournamentId="t1" />);
    await tick(0);
    expect(bus.channelKeys).toContain('t-break-t1');
  });

  it('re-reads the authoritative row the moment a level change is broadcast', async () => {
    getTournament.mockResolvedValue(running());
    render(<TournamentHUD tournamentId="t1" />);
    await tick(0);
    const afterMount = getTournament.mock.calls.length;
    expect(bus.broadcastHandlers.length).toBeGreaterThan(0);

    // The engine advances the level. No timer is advanced at all here: the
    // whole point is that the refresh does not wait for the 45s poll.
    await act(async () => {
      for (const handler of bus.broadcastHandlers) {
        handler({
          payload: { type: 'level_up', payload: { level: 1, smallBlind: 50, bigBlind: 100 } },
        });
      }
    });

    expect(
      getTournament.mock.calls.length,
      'a level_up broadcast must trigger an immediate authoritative read'
    ).toBeGreaterThan(afterMount);
  });

  it('refreshes on an elimination too, and ignores an event it does not map', async () => {
    getTournament.mockResolvedValue(running());
    render(<TournamentHUD tournamentId="t1" />);
    await tick(0);

    const before = getTournament.mock.calls.length;
    await act(async () => {
      for (const handler of bus.broadcastHandlers) {
        handler({
          payload: { type: 'player_eliminated', payload: { userId: 'u-1', position: 9 } },
        });
      }
    });
    const afterElimination = getTournament.mock.calls.length;
    expect(afterElimination).toBeGreaterThan(before);

    await act(async () => {
      for (const handler of bus.broadcastHandlers) {
        handler({ payload: { type: 'chip_race', payload: {} } });
      }
    });
    expect(
      getTournament.mock.calls.length,
      'an unmapped broadcast must not cost a database read'
    ).toBe(afterElimination);
  });

  it('survives a malformed broadcast without throwing or reading', async () => {
    getTournament.mockResolvedValue(running());
    render(<TournamentHUD tournamentId="t1" />);
    await tick(0);
    const before = getTournament.mock.calls.length;
    await act(async () => {
      for (const handler of bus.broadcastHandlers) {
        handler({});
        handler({ payload: null });
        handler({ payload: { payload: { level: 3 } } }); // no type
      }
    });
    expect(getTournament.mock.calls.length).toBe(before);
  });
});
