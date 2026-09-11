import { afterEach, describe, expect, it, vi } from 'vitest';
import { onNextMaintenanceThaw, setMaintenanceFrozen } from '../maintenance/freezeState.js';
import { TournamentManager } from './TournamentManager.js';
import { thawPassDelayMs } from './TournamentManagerEliminations.js';
import type { GameServer } from '../GameServer.js';

const liveManagers: TournamentManager[] = [];
function manager() {
  const instance = new TournamentManager('aaaaaaaa-0000-4000-8000-000000000001', {} as GameServer);
  const internal = instance as any;
  internal.lifecycleEpoch.begin();
  internal.running = true;
  const request = vi
    .spyOn(internal, 'requestUrgentEliminationSweepAfter')
    .mockImplementation(() => {});
  liveManagers.push(instance);
  return { instance, internal, request, owe: () => internal.owePassAfterTheThaw() };
}
afterEach(() => {
  for (const instance of liveManagers.splice(0)) instance.fenceForServerShutdown();
  setMaintenanceFrozen(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('maintenance thaw redrives the real manager', () => {
  it('waits through clock boundaries and emits one scheduler request for duplicate debt', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:17:00Z'));
    setMaintenanceFrozen(true);
    const m = manager();
    m.owe();
    m.owe();
    m.owe();
    vi.advanceTimersByTime(2 * 3_600_000);
    expect(m.request).not.toHaveBeenCalled();
    setMaintenanceFrozen(false);
    expect(m.request).toHaveBeenCalledOnce();
    expect(m.request).toHaveBeenCalledWith(thawPassDelayMs(m.internal.tournamentId, 10_000));
    setMaintenanceFrozen(false);
    expect(m.request).toHaveBeenCalledTimes(1);
  });
  it('removes an old lifecycle subscription and permits the replacement generation', () => {
    setMaintenanceFrozen(true);
    const m = manager();
    m.owe();
    m.internal.lifecycleEpoch.begin();
    m.owe();
    setMaintenanceFrozen(false);
    expect(m.request).toHaveBeenCalledTimes(1);
  });
  it('the actual shutdown fence cancels owed work before the thaw', () => {
    setMaintenanceFrozen(true);
    const m = manager();
    m.owe();
    m.instance.fenceForServerShutdown();
    setMaintenanceFrozen(false);
    expect(m.request).not.toHaveBeenCalled();
  });
  it('rearms if a new freeze begins before an already-thawed microtask runs', async () => {
    setMaintenanceFrozen(false);
    const m = manager();
    m.owe();
    setMaintenanceFrozen(true);
    await Promise.resolve();
    expect(m.request).not.toHaveBeenCalled();
    setMaintenanceFrozen(false);
    expect(m.request).toHaveBeenCalledTimes(1);
  });
  it('can owe one new pass in a later freeze', () => {
    setMaintenanceFrozen(true);
    const m = manager();
    m.owe();
    setMaintenanceFrozen(false);
    setMaintenanceFrozen(true);
    m.owe();
    m.owe();
    setMaintenanceFrozen(false);
    expect(m.request).toHaveBeenCalledTimes(2);
  });
});

describe('one-shot thaw subscription lifecycle', () => {
  it('explicit cancellation and signal abort remove callbacks while frozen', () => {
    setMaintenanceFrozen(true);
    const first = vi.fn();
    const second = vi.fn();
    const controller = new AbortController();
    onNextMaintenanceThaw(first)();
    onNextMaintenanceThaw(second, controller.signal);
    controller.abort();
    setMaintenanceFrozen(false);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
  it('cancels an already-thawed delivery before its microtask', async () => {
    setMaintenanceFrozen(false);
    const listener = vi.fn();
    const controller = new AbortController();
    onNextMaintenanceThaw(listener, controller.signal);
    controller.abort();
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });
  it('a failed callback cannot prevent the other owed work', () => {
    setMaintenanceFrozen(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = vi.fn();
    onNextMaintenanceThaw(() => {
      throw new Error('callback failed');
    });
    onNextMaintenanceThaw(second);
    setMaintenanceFrozen(false);
    expect(second).toHaveBeenCalledOnce();
  });
  it('spreads scheduler requests deterministically within the existing wave', () => {
    const delays = Array.from({ length: 100 }, (_, i) =>
      thawPassDelayMs(`${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`, 10_000)
    );
    expect(new Set(delays).size).toBe(100);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...delays)).toBeLessThan(10_000);
  });
});
