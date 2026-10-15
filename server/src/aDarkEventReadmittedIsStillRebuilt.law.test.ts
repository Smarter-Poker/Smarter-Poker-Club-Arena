/**
 * A DARK EVENT RE-ADMITTED OVER AND OVER IS STILL REBUILT AND PAGED (2026-10-15)
 *
 * Freeroll a38b88a9 sat RUNNING, 58 players, no hand for 35 hours. The resume
 * lane re-admitted its manager more often than the dark window, and the
 * "admitted recently" skip read each fresh admission, so the sweep never
 * rebuilt or paged it again; after six hours it also forgot it had ever
 * rebuilt it. The skip now yields once this sweep has seen the event dark for
 * the whole window, and an event still dark keeps its rebuild record.
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
    deliberateDealingHold: () => null,
  };
}

function engine(overrides: Partial<{ parked: boolean; pausedMs: number; running: boolean }> = {}) {
  return {
    isRunning: () => overrides.running ?? true,
    isParkedByDesign: () => overrides.parked ?? false,
    msPaused: () => overrides.pausedMs ?? 0,
    isMaintenancePaused: () => false,
    isHeldByOperatorFloor: () => false,
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

describe('a dark event re-admitted over and over is still rebuilt and paged', () => {
  const MIN = 60_000;
  it('a fresh admission defers the first sighting, not one that is dark for the whole window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    const s = server();
    s.tableEngines.set(TABLE, engine());
    db.rows = [{ tournament_id: EVENT, name: 'Freeroll', alive: 58, live_minutes: 30 }];
    const first = manager();
    s.tournamentEngines.set(EVENT, first);
    s.tournamentManagerAdmittedAtMs.set(first, Date.now());
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).not.toHaveBeenCalled();
    // Re-admitted again 19 minutes later, still dark: a reset admission no
    // longer defers once the sweep has seen it dark for the whole window.
    vi.setSystemTime(new Date(Date.now() + 25 * MIN));
    const again = manager();
    s.tournamentEngines.set(EVENT, again);
    s.tournamentManagerAdmittedAtMs.set(again, Date.now() - 1 * MIN);
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).toHaveBeenCalledWith(
      EVENT,
      again,
      'GameServer.dark_tournament_manager_rebuild'
    );
  });

  it('keeps the rebuild record of an event still dark past six hours, and forgets one that recovered', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    const s = server();
    s.tableEngines.set(TABLE, engine());
    s.tournamentEngines.set(EVENT, manager());
    db.rows = [{ tournament_id: EVENT, name: 'Freeroll', alive: 58, live_minutes: 600 }];
    s.darkTournamentRebuiltAtMs.set(EVENT, Date.now() - 7 * 60 * MIN);
    await s.rebuildManagersOfDarkTournaments();
    expect(s.darkTournamentRebuiltAtMs.has(EVENT)).toBe(true);
    expect(alerts.raise).toHaveBeenCalledWith(
      'critical',
      'GameServer.tournament_dark_after_rebuild',
      expect.any(String),
      expect.objectContaining({ tournament_id: EVENT }),
      `tournament-dark-after-rebuild:${EVENT}`,
      EVENT
    );
    db.rows = [];
    vi.setSystemTime(new Date(Date.now() + 7 * 60 * MIN));
    await s.rebuildManagersOfDarkTournaments();
    expect(s.darkTournamentRebuiltAtMs.has(EVENT)).toBe(false);
    expect(s.darkTournamentFirstSeenAtMs.has(EVENT)).toBe(false);
  });
});
