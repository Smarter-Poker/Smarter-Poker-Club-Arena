import { afterEach, expect, it, vi } from 'vitest';
import { TimeBankEngine } from './TimeBankEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
const timers: PreciseActionTimer[] = [];
afterEach(() => {
  for (const t of timers.splice(0)) t.dispose();
  vi.restoreAllMocks();
});
it('resumes only the retained unspent grant after an outage without spending another activation', () => {
  const timer = new PreciseActionTimer();
  timers.push(timer);
  const engine = new TimeBankEngine(timer);
  engine.initializePlayer('t', 'u', { remainingSeconds: 60, usesRemaining: 3 });
  let now = 100000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  expect(engine.activate('t', 'u', () => {})).toBe(true);
  now += 5000;
  const saved = { ...engine.getPlayerBank('t', 'u')!, onExpire: undefined };
  const captured = now;
  now += 3600000;
  const nextTimer = new PreciseActionTimer();
  timers.push(nextTimer);
  const next = new TimeBankEngine(nextTimer);
  const start = vi.spyOn(nextTimer, 'startTimer');
  next.restorePlayerForRecovery('t', 'u', saved, captured);
  expect(next.resumeRecoveredAllocation('t', 'u', () => {})).toBe(15);
  expect(start.mock.calls.at(-1)?.[2]).toBe(15000);
  expect(next.getUsesRemaining('t', 'u')).toBe(2);
  expect(next.getPlayerBank('t', 'u')!.streetActivations).toBe(1);
  expect(next.resumeRecoveredAllocation('t', 'u', () => {})).toBeNull();
  next.playerActed('t', 'u');
  expect(next.getRemainingSeconds('t', 'u')).toBe(40);
});
it('refuses mismatched bank ownership and invalid balance instead of resetting allowance', () => {
  const timer = new PreciseActionTimer();
  timers.push(timer);
  const engine = new TimeBankEngine(timer);
  engine.initializePlayer('t', 'u');
  const saved = { ...engine.getPlayerBank('t', 'u')!, onExpire: undefined };
  expect(() => engine.restorePlayerForRecovery('other', 'u', saved, Date.now())).toThrow('Invalid');
  expect(() =>
    engine.restorePlayerForRecovery('t', 'u', { ...saved, remainingSeconds: -1 }, Date.now())
  ).toThrow('Invalid');
});
