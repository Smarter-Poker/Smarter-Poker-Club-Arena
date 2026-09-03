/**
 * A WEBSOCKET BLIP IS NOT A PLAYER LEAVING.
 *
 * A player has two independent transports to a table: the websocket, and the
 * HTTP heartbeat their client posts every 5s. Round 2 wired the websocket close
 * straight into markDisconnected so that closing a tab starts the auto-action
 * ladder in milliseconds instead of waiting out the 30s stale-heartbeat sweep.
 *
 * But it concluded from the socket dying, not from the PLAYER being gone. A
 * blip on somebody whose heartbeat was landing normally marked them
 * disconnected, and their next heartbeat — at most 5s later — marked them back.
 *
 * That pair is not a log line. In ConnectionHUD it is: the disconnect warning
 * banner, playDisconnect(), a double haptic buzz, then a reconnect sound,
 * another buzz, a "Connection restored" toast and a stale-data banner. Mid-hand,
 * at a player who never went anywhere.
 *
 * The window must therefore be silent when it is cancelled — not quieter, but
 * completely silent. That is what the first test asserts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DisconnectEngine } from './DisconnectEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';

const TABLE = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const PLAYER = 'hero';

let engine: DisconnectEngine;
let events: string[];

beforeEach(() => {
  vi.useFakeTimers();
  events = [];
  engine = new DisconnectEngine(new PreciseActionTimer(), (e) => events.push(e.type));
  engine.registerPlayer(TABLE, PLAYER);
});

afterEach(() => {
  engine.disposeAll();
  vi.useRealTimers();
});

describe('markTransportGone', () => {
  it('emits NOTHING when a heartbeat arrives inside the window', () => {
    engine.markTransportGone(TABLE, PLAYER);
    // The client's next 5s heartbeat lands, as it does for a socket blip.
    vi.advanceTimersByTime(3_000);
    engine.heartbeat(TABLE, PLAYER);
    vi.advanceTimersByTime(30_000);

    expect(events).toEqual([]);
    expect(engine.isConnected(TABLE, PLAYER)).toBe(true);
  });

  it('CLOSES the window on a heartbeat rather than leaving it to time out harmlessly', () => {
    // The first test passes with or without the cancel, because the timer
    // callback also re-checks lastHeartbeat and stands down. Both mechanisms
    // are wanted, but they are not the same mechanism and only one of them is
    // primary: if the grace were ever tuned below the heartbeat period, the
    // callback's check would start concluding wrongly and the cancel is what
    // would still be right. Pin it directly.
    const pending = () =>
      (engine as unknown as { transportGraceTimers: Map<string, unknown> }).transportGraceTimers
        .size;

    engine.markTransportGone(TABLE, PLAYER);
    expect(pending()).toBe(1);

    engine.heartbeat(TABLE, PLAYER);
    expect(pending()).toBe(0);
  });

  it('still concludes when NEITHER transport says anything - the tab is closed', () => {
    engine.markTransportGone(TABLE, PLAYER);
    expect(engine.isConnected(TABLE, PLAYER)).toBe(true); // not yet

    vi.advanceTimersByTime(9_000);

    expect(events).toEqual(['PLAYER_DISCONNECTED']);
    expect(engine.isConnected(TABLE, PLAYER)).toBe(false);
  });

  it('is still far faster than the 30s sweep it replaced', () => {
    engine.markTransportGone(TABLE, PLAYER);
    vi.advanceTimersByTime(10_000);
    expect(engine.isConnected(TABLE, PLAYER)).toBe(false);
  });

  it('does not stack windows when a flapping socket closes repeatedly', () => {
    engine.markTransportGone(TABLE, PLAYER);
    engine.markTransportGone(TABLE, PLAYER);
    engine.markTransportGone(TABLE, PLAYER);
    vi.advanceTimersByTime(9_000);
    expect(events).toEqual(['PLAYER_DISCONNECTED']);
  });

  it('a player who left the table takes their pending window with them', () => {
    engine.markTransportGone(TABLE, PLAYER);
    engine.unregisterPlayer(TABLE, PLAYER);
    vi.advanceTimersByTime(30_000);
    expect(events).toEqual([]);
  });

  it('disposeAll clears pending windows rather than leaking them past teardown', () => {
    engine.markTransportGone(TABLE, PLAYER);
    engine.disposeAll();
    vi.advanceTimersByTime(30_000);
    expect(events).toEqual([]);
  });
});
