import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeReconnectFreeze,
  thawReconnectClock,
  type ReconnectClock,
} from './reconnectFreeze.js';
import { DisconnectEngine } from '../engine/DisconnectEngine.js';
import { PreciseActionTimer } from '../engine/PreciseActionTimer.js';

const timers: PreciseActionTimer[] = [];
let epoch = 10_000_000;
afterEach(() => {
  timers.splice(0).forEach((t) => t.dispose());
  vi.restoreAllMocks();
});
function engine() {
  const timer = new PreciseActionTimer();
  timers.push(timer);
  return new DisconnectEngine(timer);
}
describe('maintenance preserves reconnect time without refilling it', () => {
  it('credits a legitimate recovery tail longer than the old fifteen-minute ceiling', () => {
    epoch += 3_600_000;
    const start = epoch;
    const duration = 21 * 60_000;
    const clock: ReconnectClock = {
      reconnectGrantedAtMs: start,
      reconnectDeadlineMs: start + 30_000,
    };

    completeReconnectFreeze(start, duration);
    thawReconnectClock(clock);
    expect(clock.reconnectDeadlineMs).toBe(start + 30_000 + duration);
    expect(clock.reconnectThawedAtMs).toBe(start + duration);
  });

  it.each([30, 45])(
    'retains the unused portion of a %s-second grant through both restore orders',
    (seconds) => {
      epoch += 3_600_000;
      let now = epoch;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const before = engine();
      before.registerPlayer('t', 'u', { is_vip: seconds === 45, vip_expires_at: null });
      before.markDisconnected('t', 'u');
      now += 10_000;
      const start = now;
      const snapshot = before.getFsmStatesForTable('t');
      const restoredBefore = engine();
      restoredBefore.restoreFsmStates('t', snapshot);
      now += 300_000;
      completeReconnectFreeze(start, 300_000);
      const restoredAfter = engine();
      restoredAfter.restoreFsmStates('t', snapshot);
      for (const e of [before, restoredBefore, restoredAfter]) {
        expect(e.getFsmState('t', 'u')!.graceDeadlineMs).toBe(now + (seconds - 10) * 1000);
        e.onPlayerTurn('t', 'u', true);
        expect(e.armedAutoActionDeadlineMs('t', 'u')).toBe(now + (seconds - 10) * 1000);
        const shifted = e.getFsmStatesForTable('t');
        const again = engine();
        again.restoreFsmStates('t', shifted);
        expect(again.getFsmState('t', 'u')!.graceDeadlineMs).toBe(shifted.u.graceDeadlineMs);
      }
    }
  );
  it('credits only frozen time after a grant made during the break', () => {
    const clock = { reconnectDeadlineMs: 230_000, reconnectGrantedAtMs: 200_000 };
    thawReconnectClock(clock, { startMs: 100_000, endMs: 400_000 });
    expect(clock.reconnectDeadlineMs).toBe(430_000);
  });
  it('does not revive an expired grant or move a grant made after the thaw', () => {
    for (const deadline of [90_000, 100_000]) {
      const clock = { reconnectDeadlineMs: deadline };
      thawReconnectClock(clock, { startMs: 100_000, endMs: 400_000 });
      expect(clock.reconnectDeadlineMs).toBe(deadline);
    }
    const clock = { reconnectDeadlineMs: 530_000, reconnectGrantedAtMs: 500_000 };
    thawReconnectClock(clock, { startMs: 100_000, endMs: 400_000 });
    expect(clock.reconnectDeadlineMs).toBe(530_000);
  });
  it('accepts legacy deadlines and refuses duplicate compensation', () => {
    const clock = { reconnectDeadlineMs: 120_000 };
    const freeze = { startMs: 100_000, endMs: 400_000 };
    thawReconnectClock(clock, freeze);
    thawReconnectClock(clock, freeze);
    expect(clock.reconnectDeadlineMs).toBe(420_000);
  });
  it('a restored legacy allowance keeps its age through a heartbeat flap', () => {
    epoch += 3_600_000;
    let now = epoch;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const e = engine();
    e.restoreFsmStates('t', {
      u: { state: 'MISSING', sinceMs: now, graceDeadlineMs: now + 30_000 },
    });
    const start = now + 10_000;
    now += 100_000;
    e.heartbeat('t', 'u');
    e.markDisconnected('t', 'u');
    now = start + 300_000;
    completeReconnectFreeze(start, 300_000);
    expect(e.getFsmState('t', 'u')!.graceDeadlineMs).toBe(now + 20_000);
  });
  it('a heartbeat flap during maintenance does not replace the original grant', () => {
    epoch += 3_600_000;
    let now = epoch;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const e = engine();
    e.registerPlayer('t', 'u');
    e.markDisconnected('t', 'u');
    const start = now + 10_000;
    now += 100_000;
    e.heartbeat('t', 'u');
    e.markDisconnected('t', 'u');
    now = start + 300_000;
    completeReconnectFreeze(start, 300_000);
    expect(e.getFsmState('t', 'u')!.graceDeadlineMs).toBe(now + 20_000);
    e.heartbeat('t', 'u');
    e.recordPlayerActed('t', 'u');
    e.markDisconnected('t', 'u');
    expect(e.getFsmState('t', 'u')!.graceDeadlineMs).toBe(now + 30_000);
  });
});

describe('incremental compensation follows the recorded interval', () => {
  it('adds only a late resume extension even after the original shifted deadline passed', () => {
    const clock = { reconnectDeadlineMs: 101_000, reconnectGrantedAtMs: 71_000 };
    thawReconnectClock(clock, { startMs: 100_000, endMs: 400_000 });
    expect(clock.reconnectDeadlineMs).toBe(401_000);
    thawReconnectClock(clock, { startMs: 100_000, endMs: 410_500 });
    expect(clock.reconnectDeadlineMs).toBe(411_500);
    thawReconnectClock(clock, { startMs: 100_000, endMs: 410_500 });
    expect(clock.reconnectDeadlineMs).toBe(411_500);
  });
  it('never revives a grant exhausted before maintenance, including on a later wave', () => {
    const clock = { reconnectDeadlineMs: 100_000, reconnectGrantedAtMs: 70_000 };
    thawReconnectClock(clock, { startMs: 100_000, endMs: 400_000 });
    thawReconnectClock(clock, { startMs: 100_000, endMs: 410_500 });
    expect(clock.reconnectDeadlineMs).toBe(100_000);
  });
  it('credits a new grant only for its own overlap with a later wave', () => {
    const clock = { reconnectDeadlineMs: 435_000, reconnectGrantedAtMs: 405_000 };
    thawReconnectClock(clock, { startMs: 100_000, endMs: 400_000 });
    thawReconnectClock(clock, { startMs: 100_000, endMs: 410_500 });
    expect(clock.reconnectDeadlineMs).toBe(440_500);
  });
});
