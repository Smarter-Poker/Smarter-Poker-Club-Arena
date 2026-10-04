/**
 * THE BREAK DOES NOT BURN AN ABSENCE CLOCK (CLAUDE.md 13 rule 4).
 *
 * A cash seat is released five minutes after its player sat out, or five
 * minutes after the engine concluded nobody was behind it. The hourly break
 * freezes the platform for five minutes. The engine judged both limits on
 * stamps the freeze never moved, so a player who sat out or dropped one
 * minute before :55 was stood up and cashed out on the first sweep after the
 * thaw, with four of their five minutes unspent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeReconnectFreeze,
  completeTableReconnectFreeze,
  thawPresenceClock,
} from './reconnectFreeze.js';
import { DisconnectEngine } from '../engine/DisconnectEngine.js';
import { PreciseActionTimer } from '../engine/PreciseActionTimer.js';

const MINUTE = 60_000;
const timers: PreciseActionTimer[] = [];
let epoch = 20_000_000;
let now = epoch;

afterEach(() => {
  timers.splice(0).forEach((t) => t.dispose());
  vi.restoreAllMocks();
});

function engine() {
  const timer = new PreciseActionTimer();
  timers.push(timer);
  return new DisconnectEngine(timer);
}

/** A fresh hour for every case: the completed freeze is process-wide. */
function clock() {
  epoch += 3_600_000;
  now = epoch;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
}

describe('the five-minute sit-out limit keeps the minutes the break froze', () => {
  it('a restarted engine and the original both give back the frozen time, once', () => {
    clock();
    const original = engine();
    original.sitOut('t', 'u', 'voluntary');
    now += MINUTE; // one minute sat out, then the break
    const freezeStart = now;
    const park = original.getFsmStatesForTable('t');
    now += 3 * MINUTE;
    const restartedDuringBreak = engine();
    restartedDuringBreak.restoreFsmStates('t', park);
    now += 2 * MINUTE;
    completeReconnectFreeze(freezeStart, 5 * MINUTE);
    const restoredAfterThaw = engine();
    restoredAfterThaw.restoreFsmStates('t', park);

    for (const e of [original, restartedDuringBreak, restoredAfterThaw]) {
      expect(e.tickSitOutsAndCollectEvictions('t', ['u'])).toEqual([]);
      // Asked twice, and re-parked: the credit is not granted again.
      expect(e.getFsmState('t', 'u')!.sitOutSinceMs).toBe(freezeStart - MINUTE + 5 * MINUTE);
      const again = engine();
      again.restoreFsmStates('t', e.getFsmStatesForTable('t'));
      expect(again.getFsmState('t', 'u')!.sitOutSinceMs).toBe(freezeStart + 4 * MINUTE);
    }

    now += 4 * MINUTE - 1;
    for (const e of [original, restartedDuringBreak, restoredAfterThaw]) {
      expect(e.tickSitOutsAndCollectEvictions('t', ['u'])).toEqual([]);
    }
    now += 1;
    for (const e of [original, restartedDuringBreak, restoredAfterThaw]) {
      expect(e.tickSitOutsAndCollectEvictions('t', ['u'])).toEqual(['u']);
    }
  });

  it('a sit-out that began after the thaw is not moved', () => {
    clock();
    completeReconnectFreeze(now, 5 * MINUTE);
    now += 6 * MINUTE;
    const e = engine();
    e.sitOut('t', 'u', 'voluntary');
    const began = now;
    now += 5 * MINUTE;
    expect(e.getFsmState('t', 'u')!.sitOutSinceMs).toBe(began);
    expect(e.tickSitOutsAndCollectEvictions('t', ['u'])).toEqual(['u']);
  });

  it('a table resumed in a later wave is credited through its own resume', () => {
    clock();
    const e = engine();
    e.sitOut('late-wave', 'u', 'voluntary');
    const freezeStart = now;
    now += 5 * MINUTE;
    completeReconnectFreeze(freezeStart, 5 * MINUTE);
    now += 20_000;
    completeTableReconnectFreeze('late-wave', freezeStart, now);
    expect(e.getFsmState('late-wave', 'u')!.sitOutSinceMs).toBe(now);
  });
});

describe('the five-minute abandoned-seat limit keeps the minutes the break froze', () => {
  it.each(['page left', 'socket lost'])('%s two minutes before the break', (how) => {
    clock();
    const original = engine();
    original.registerPlayer('t', 'u');
    if (how === 'page left') original.markPageLeft('t', 'u');
    else original.markDisconnected('t', 'u');
    now += 2 * MINUTE;
    const freezeStart = now;
    const park = original.getFsmStatesForTable('t');
    now += 5 * MINUTE;
    completeReconnectFreeze(freezeStart, 5 * MINUTE);
    const restarted = engine();
    restarted.restoreFsmStates('t', park);

    for (const e of [original, restarted]) {
      expect(e.collectAbandonedSeatEvictions('t', ['u'])).toEqual([]);
    }
    now += 3 * MINUTE - 1;
    for (const e of [original, restarted]) {
      expect(e.collectAbandonedSeatEvictions('t', ['u'])).toEqual([]);
    }
    now += 1;
    for (const e of [original, restarted]) {
      expect(e.collectAbandonedSeatEvictions('t', ['u'])).toEqual(['u']);
    }
  });

  it('a seat the restarted engine found empty during the break starts its clock at the thaw', () => {
    clock();
    const freezeStart = now;
    now += 3 * MINUTE;
    const restarted = engine();
    restarted.registerPlayer('t', 'u');
    restarted.markDisconnected('t', 'u'); // stale beat, noticed mid-break
    now += 2 * MINUTE;
    completeReconnectFreeze(freezeStart, 5 * MINUTE);
    now += 5 * MINUTE - 1;
    expect(restarted.collectAbandonedSeatEvictions('t', ['u'])).toEqual([]);
    now += 1;
    expect(restarted.collectAbandonedSeatEvictions('t', ['u'])).toEqual(['u']);
  });
});

describe('thawPresenceClock', () => {
  it('credits only the part of the freeze not already credited', () => {
    const c = { sitOutSince: 50_000, presenceThawedAtMs: 250_000 };
    thawPresenceClock(c, { startMs: 100_000, endMs: 400_000 });
    expect(c).toEqual({
      sitOutSince: 200_000,
      disconnectedAt: undefined,
      pageLeftAt: undefined,
      presenceThawedAtMs: 400_000,
    });
    thawPresenceClock(c, { startMs: 100_000, endMs: 400_000 });
    expect(c.sitOutSince).toBe(200_000);
  });
});
