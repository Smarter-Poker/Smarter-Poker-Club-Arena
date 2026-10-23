import { afterEach, describe, expect, it, vi } from 'vitest';
const fx = vi.hoisted(() => ({
  events: new Map<string, (event: unknown) => void>(),
  statuses: new Set<(status: string) => void>(),
  auth: (_event: any) => {},
  stops: vi.fn(),
}));
vi.mock('../../src/services/RealtimeChannelService', () => ({
  realtimeChannelService: {
    subscribeToTournament: (id: string, callbacks: any) => {
      fx.events.set(id, callbacks.onEvent);
      return () => {
        fx.events.delete(id);
        fx.stops();
      };
    },
  },
}));
vi.mock('../../src/services/EngineStateClient', () => ({
  engineChannelClient: {
    onStatusChange: (cb: (status: string) => void) => {
      fx.statuses.add(cb);
      return () => {
        fx.statuses.delete(cb);
      };
    },
  },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (_name: string, cb: any) => {
      fx.auth = cb;
      return () => {};
    },
  },
}));
import { subscribeTournamentStandings } from '../../src/services/tournamentStandingsUpdates';
afterEach(() => {
  vi.useRealTimers();
  fx.stops.mockClear();
});
describe('shared committed standings invalidations', () => {
  it('coalesces ordinary hands for table and lobby without cross-event updates', async () => {
    vi.useFakeTimers();
    const table = vi.fn();
    const lobby = vi.fn();
    const other = vi.fn();
    const stops = [
      subscribeTournamentStandings('one', table),
      subscribeTournamentStandings('one', lobby),
      subscribeTournamentStandings('two', other),
    ];
    expect(fx.events.size).toBe(2);
    for (let i = 0; i < 20; i++) fx.events.get('one')?.({ type: 'standings_changed' });
    await vi.advanceTimersByTimeAsync(100);
    expect(table).toHaveBeenCalledOnce();
    expect(lobby).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    stops[0]();
    fx.events.get('one')?.({ type: 'standings_changed' });
    await vi.advanceTimersByTimeAsync(100);
    expect(table).toHaveBeenCalledOnce();
    expect(lobby).toHaveBeenCalledTimes(2);
    stops[1]();
    stops[2]();
    expect(fx.events.size).toBe(0);
    expect(fx.statuses.size).toBe(0);
  });
  it('rebinds at the identity boundary and cancels a pending flush on cleanup', async () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const stop = subscribeTournamentStandings('identity', notify);
    fx.auth({ payload: { isAuthenticated: false } });
    expect(fx.events.size).toBe(0);
    fx.auth({ payload: { isAuthenticated: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(fx.events.has('identity')).toBe(true);
    fx.events.get('identity')?.({ type: 'standings_changed' });
    stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(notify).not.toHaveBeenCalled();
  });
});
