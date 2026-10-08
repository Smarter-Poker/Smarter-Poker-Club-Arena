/**
 * A DARK EVENT GETS ITS MANAGER REBUILT, AND A REBUILD THAT DOES NOT CURE IT
 * IS PAGED (2026-10-08)
 *
 * Three unrelated causes left RUNNING events with two or more live players
 * dealing nothing for hours in the seven days to 2026-10-08 (a refused
 * re-admission for 14.4 h, players marked eliminated without a sequence for
 * 8-23 h, a settlement refused by its own receipt for 17 h). The zombie
 * reaper rebuilds table engines, never the manager; the never-dealt sweep
 * only knows an event that never dealt; the decided sweep only one down to a
 * single player. GameServer.rebuildManagersOfDarkTournaments reads the
 * database's own definition of dark (fn_ca_tournament_dark_candidates) and
 * retires the exact manager it holds so RUNNING resume re-admits it fresh,
 * once per tournament per rebuild window; a second dark reading after a
 * rebuild raises one CRITICAL financial alert.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ rows: [] as unknown[], error: null as null | { message: string } }));
const alerts = vi.hoisted(() => ({
  raise: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
}));
const freeze = vi.hoisted(() => ({ frozen: false }));
vi.mock('./services/supabase.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    supabase: {
      ...(actual.supabase as Record<string, unknown>),
      rpc: vi.fn(async () => ({ data: db.rows, error: db.error })),
    },
  };
});
vi.mock('./services/financialAlerts.js', () => ({ raiseFinancialAlert: alerts.raise }));
vi.mock('./maintenance/freezeState.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, isMaintenanceFrozen: () => freeze.frozen };
});
vi.mock('./services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (value: unknown) => String(value),
}));

import { GameServer } from './GameServer.js';

const EVENT = '00000000-0000-4000-8000-000000000001';
const TABLE = '00000000-0000-4000-8000-000000000003';

function manager(overrides: Partial<{ onBreak: boolean; tables: string[] }> = {}) {
  return {
    isOnBreak: () => overrides.onBreak ?? false,
    getTableIds: () => overrides.tables ?? [TABLE],
  };
}

function engine(overrides: Partial<{ parked: boolean; pausedMs: number; running: boolean }> = {}) {
  return {
    isRunning: () => overrides.running ?? true,
    isParkedByDesign: () => overrides.parked ?? false,
    msPaused: () => overrides.pausedMs ?? 0,
  };
}

function server() {
  const s: any = new GameServer();
  s.running = true;
  s.retireTournamentManagerInDiscovery = vi.fn();
  s.tournamentEngines = new Map();
  s.tableEngines = new Map();
  return s;
}

afterEach(() => {
  vi.useRealTimers();
  db.rows = [];
  db.error = null;
  freeze.frozen = false;
  alerts.raise.mockClear();
});

describe('a dark event gets its manager rebuilt', () => {
  it('retires the exact manager of a dark event this process holds', async () => {
    const s = server();
    const m = manager();
    s.tournamentEngines.set(EVENT, m);
    s.tableEngines.set(TABLE, engine());
    db.rows = [{ tournament_id: EVENT, name: 'Dark Spin', alive: 2, live_minutes: 16 }];
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).toHaveBeenCalledWith(
      EVENT,
      m,
      'GameServer.dark_tournament_manager_rebuild'
    );
    expect(alerts.raise).not.toHaveBeenCalled();
  });

  it('leaves an unowned event to the resume lane, and a break, a fresh admission or a healthy park alone', async () => {
    const s = server();
    db.rows = [{ tournament_id: EVENT, name: 'x', alive: 2, live_minutes: 16 }];
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).not.toHaveBeenCalled();

    const onBreak = manager({ onBreak: true });
    s.tournamentEngines.set(EVENT, onBreak);
    s.tableEngines.set(TABLE, engine());
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).not.toHaveBeenCalled();

    const fresh = manager();
    s.tournamentEngines.set(EVENT, fresh);
    s.tournamentManagerAdmittedAtMs.set(fresh, Date.now());
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).not.toHaveBeenCalled();

    const parked = manager();
    s.tournamentEngines.set(EVENT, parked);
    s.tableEngines.set(TABLE, engine({ parked: true, pausedMs: 60_000 }));
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).not.toHaveBeenCalled();

    // A park past MAX_HEALTHY_PAUSE_MS is never healthy: that one is rebuilt.
    s.tableEngines.set(
      TABLE,
      engine({ parked: true, pausedMs: GameServer.MAX_HEALTHY_PAUSE_MS + 1 })
    );
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).toHaveBeenCalledTimes(1);
  });

  it('does nothing inside a maintenance freeze or on an unreadable board', async () => {
    const s = server();
    s.tournamentEngines.set(EVENT, manager());
    s.tableEngines.set(TABLE, engine());
    db.rows = [{ tournament_id: EVENT, alive: 2, live_minutes: 16 }];
    freeze.frozen = true;
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).not.toHaveBeenCalled();
    freeze.frozen = false;
    db.error = { message: 'timeout' };
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).not.toHaveBeenCalled();
  });

  it('rebuilds once per window, and pages when the event is dark again after its rebuild', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
    const s = server();
    const m1 = manager();
    s.tournamentEngines.set(EVENT, m1);
    s.tableEngines.set(TABLE, engine());
    db.rows = [{ tournament_id: EVENT, name: 'Dark', alive: 3, live_minutes: 16 }];
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).toHaveBeenCalledTimes(1);

    // Still dark ten minutes later, replacement manager admitted long enough ago: inside the window, nothing.
    vi.setSystemTime(new Date('2026-10-08T12:10:00Z'));
    const m2 = manager();
    s.tournamentEngines.set(EVENT, m2);
    s.tournamentManagerAdmittedAtMs.set(m2, Date.now() - 16 * 60_000);
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).toHaveBeenCalledTimes(1);
    expect(alerts.raise).not.toHaveBeenCalled();

    // Dark again after the window: paged once and rebuilt again.
    vi.setSystemTime(new Date('2026-10-08T12:31:00Z'));
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).toHaveBeenCalledTimes(2);
    expect(alerts.raise).toHaveBeenCalledTimes(1);
    expect(alerts.raise.mock.calls[0][1]).toBe('GameServer.tournament_dark_after_rebuild');
    expect(alerts.raise.mock.calls[0][4]).toBe(`tournament-dark-after-rebuild:${EVENT}`);
  });
});

describe('a resume that keeps failing is paged', () => {
  it('raises one critical alert per tournament failing past the threshold, refreshed per window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
    const s = server();
    s.tournamentResumeCooldowns.recordFailure(EVENT, Date.now() - 11 * 60_000);
    s.tournamentResumeCooldowns.recordFailure(EVENT, Date.now() - 60_000);
    await s.pageLongFailingResumes();
    await s.pageLongFailingResumes();
    expect(alerts.raise).toHaveBeenCalledTimes(1);
    expect(alerts.raise.mock.calls[0][1]).toBe('GameServer.tournament_resume_failing_repeatedly');
    expect(alerts.raise.mock.calls[0][3]).toMatchObject({ tournament_id: EVENT, failures: 2 });
    vi.setSystemTime(new Date('2026-10-08T12:31:00Z'));
    await s.pageLongFailingResumes();
    expect(alerts.raise).toHaveBeenCalledTimes(2);
    // A manager arrived: the streak is forgotten and nothing more is paged.
    s.tournamentResumeCooldowns.forget(EVENT);
    vi.setSystemTime(new Date('2026-10-08T13:31:00Z'));
    await s.pageLongFailingResumes();
    expect(alerts.raise).toHaveBeenCalledTimes(2);
  });
});
