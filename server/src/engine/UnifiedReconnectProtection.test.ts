import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisconnectEngine } from './DisconnectEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';

const timers: PreciseActionTimer[] = [];
afterEach(() => {
  for (const t of timers.splice(0)) t.dispose();
  vi.restoreAllMocks();
});
function setup() {
  let now = 2_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const timer = new PreciseActionTimer();
  timers.push(timer);
  const engine = new DisconnectEngine(timer);
  return {
    engine,
    timer,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe('uniform reconnect protection uses one absolute allowance', () => {
  it.each(['cash', 'mtt', 'spin', 'sng', 'heads_up'])(
    '%s ignores table-specific timeout overrides and grants VIP exactly 50 percent more',
    (format) => {
      const h = setup();
      h.engine.configure(format, {
        disconnectTimeoutSeconds: 120,
        maxConsecutiveTimeouts: 9,
        preferCheckOverFold: false,
      });
      h.engine.registerPlayer(format, 'regular', { is_vip: false });
      h.engine.registerPlayer(format, 'vip', { is_vip: true, vip_tier: 'lifetime' });
      for (const [id, seconds] of [
        ['regular', 30],
        ['vip', 45],
      ] as const) {
        h.engine.markDisconnected(format, id);
        const deadline = h.engine.getFsmState(format, id)!.graceDeadlineMs!;
        expect(deadline - h.now()).toBe(seconds * 1000);
        h.advance(5000);
        h.engine.onPlayerTurn(format, id, true);
        expect(h.engine.armedAutoActionDeadlineMs(format, id)).toBe(deadline);
      }
    }
  );
  it('heartbeat flapping cannot replenish an allowance, but a voluntary action can', () => {
    const h = setup();
    h.engine.registerPlayer('t', 'u', { is_vip: true, vip_tier: 'lifetime' });
    h.engine.markDisconnected('t', 'u');
    const first = h.engine.getFsmState('t', 'u')!.graceDeadlineMs;
    h.advance(10000);
    h.engine.heartbeat('t', 'u');
    h.engine.markDisconnected('t', 'u');
    expect(h.engine.getFsmState('t', 'u')!.graceDeadlineMs).toBe(first);
    h.engine.heartbeat('t', 'u');
    h.engine.recordPlayerActed('t', 'u');
    h.engine.markDisconnected('t', 'u');
    expect(h.engine.getFsmState('t', 'u')!.graceDeadlineMs).toBe(h.now() + 45000);
  });
  it('a restart retains a VIP deadline while offline and after a heartbeat', () => {
    const h = setup();
    h.engine.registerPlayer('t', 'u', { is_vip: true, vip_tier: 'lifetime' });
    h.engine.markDisconnected('t', 'u');
    const deadline = h.engine.getFsmState('t', 'u')!.graceDeadlineMs;
    h.engine.heartbeat('t', 'u');
    const snapshot = h.engine.getFsmStatesForTable('t');
    const restored = new DisconnectEngine(h.timer);
    restored.restoreFsmStates('t', snapshot);
    h.advance(10000);
    restored.markDisconnected('t', 'u');
    expect(restored.getFsmState('t', 'u')!.graceDeadlineMs).toBe(deadline);
  });
});
