/**
 * A DARK EVENT IS REBUILT WHATEVER ITS PAUSE TIMER SAYS (2026-10-12)
 *
 * Satellite 61961519 (Sunday Funday Six-Card Closer Satellite) dealt nothing
 * from 23:52 to 05:00 UTC on 2026-10-11 with 9 players alive. The database
 * paged it dark at 00:18. GameServer.rebuildManagersOfDarkTournaments never
 * rebuilt its manager, because it skipped any event whose every running table
 * was "parked on purpose for under MAX_HEALTHY_PAUSE_MS":
 *
 *   - table c01b0657's dealer had been stopped by break 444d8b63, whose close
 *     timed out, and a stopped dealer was not counted at all;
 *   - table 4af8f60c was parked by the satellite qualifier boundary. Past ten
 *     minutes the zombie reaper condemned it, the manager rebuilt its engine,
 *     the boundary re-parked the replacement, and msPaused() restarted from
 *     zero (25 zombie rebuilds in 4.7 hours).
 *
 * The rule now: once the database's dealing clock reads the event dark, only
 * a NAMED deliberate authority inside its own bound stands the rebuild down
 * (the maintenance break, an operator floor hold that was read, the add-on
 * break, an open final-table deal review). A park, a pause timer and a
 * stopped dealer are never reasons to wait. The rebuild stays bounded to one
 * per tournament per DARK_TOURNAMENT_REBUILD_EVERY_MS.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ rows: [] as unknown[] }));
const alerts = vi.hoisted(() => ({
  raise: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
}));
vi.mock('./services/supabase.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    supabase: {
      ...(actual.supabase as Record<string, unknown>),
      rpc: vi.fn(async () => ({ data: db.rows, error: null })),
    },
  };
});
vi.mock('./services/financialAlerts.js', () => ({ raiseFinancialAlert: alerts.raise }));
vi.mock('./maintenance/freezeState.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, isMaintenanceFrozen: () => false };
});
vi.mock('./services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (value: unknown) => String(value),
}));

import { GameServer } from './GameServer.js';
import { TournamentManager } from './tournament/TournamentManager.js';
import { ServerTableEngine } from './engine/ServerTableEngine.js';

const SATELLITE = '61961519-ed97-43d8-b6e6-60dbe9b1b9db';
const SOURCE = 'c01b0657-5754-4d8c-b73d-65278b62bdb1';
const LIVE = '4af8f60c-5ffc-43e0-ba63-e80f7719d986';
const MINUTE = 60_000;

/** A manager carrying the real deliberateDealingHold of TournamentManager. */
function realManager(fields: Record<string, unknown> = {}): any {
  const m: any = Object.create(TournamentManager.prototype);
  m.addOnBreakActive = false;
  m.addOnBreakEndsAtMs = 0;
  m.finalTableDealReview = null;
  Object.assign(m, fields);
  m.getTableIds = () => [SOURCE, LIVE];
  return m;
}

/** A table engine carrying the real isHeldByOperatorFloor of ServerTableEngine. */
function realEngine(
  fields: Partial<{
    running: boolean;
    parked: boolean;
    pausedMs: number;
    maintenancePaused: boolean;
    operatorFloorPaused: boolean;
    operatorFloorHoldRead: boolean;
  }> = {}
): any {
  const e: any = Object.create(ServerTableEngine.prototype);
  e.maintenancePaused = fields.maintenancePaused ?? false;
  e.operatorFloorPaused = fields.operatorFloorPaused ?? false;
  e.operatorFloorHoldRead = fields.operatorFloorHoldRead ?? false;
  e.isRunning = () => fields.running ?? true;
  e.isParkedByDesign = () => fields.parked ?? false;
  e.msPaused = () => fields.pausedMs ?? 0;
  return e;
}

function server(manager: any, live: any, source: any = realEngine({ running: false })) {
  const s: any = new GameServer();
  s.running = true;
  s.retireTournamentManagerInDiscovery = vi.fn();
  s.tournamentEngines = new Map([[SATELLITE, manager]]);
  s.tableEngines = new Map([
    [SOURCE, source],
    [LIVE, live],
  ]);
  s.tournamentManagerAdmittedAtMs.set(manager, Date.now() - 4 * 60 * MINUTE);
  s.maintenanceBreak = { isHoldingTable: () => false };
  return s;
}

const DARK = {
  tournament_id: SATELLITE,
  name: 'Sunday Funday Six-Card Closer Satellite',
  alive: 9,
  live_minutes: 20.2,
};

afterEach(() => {
  vi.useRealTimers();
  db.rows = [];
  alerts.raise.mockClear();
});

describe('a dark event is rebuilt whatever its pause timer says', () => {
  it('rebuilds satellite 61961519: a stopped source dealer and a boundary park the zombie reaper keeps resetting', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T00:18:00Z'));
    const m = realManager();
    // The live table was rebuilt by the zombie reaper ninety seconds ago and
    // re-parked by the qualifier boundary: parked by design, timer near zero.
    const s = server(m, realEngine({ parked: true, pausedMs: 90_000 }));
    db.rows = [DARK];
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).toHaveBeenCalledWith(
      SATELLITE,
      m,
      'GameServer.dark_tournament_manager_rebuild'
    );
  });

  it('stays bounded through four hours of zombie rebuilds: one rebuild per window, one page per window after it', async () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-12T00:18:00Z');
    vi.setSystemTime(start);
    const m = realManager();
    const live = realEngine({ parked: true });
    const s = server(m, live);
    db.rows = [DARK];
    for (let minute = 0; minute < 240; minute += 1) {
      vi.setSystemTime(start + minute * MINUTE);
      // The zombie reaper's cycle: parked, timer climbs to ten minutes, the
      // engine is rebuilt and the boundary parks the replacement at zero.
      live.msPaused = () => (minute % 11) * MINUTE;
      await s.rebuildManagersOfDarkTournaments();
    }
    // Minutes 0, 30, 60, ... 210: eight rebuilds in four hours, never a loop.
    expect(s.retireTournamentManagerInDiscovery).toHaveBeenCalledTimes(8);
    expect(alerts.raise).toHaveBeenCalledTimes(7);
    expect(alerts.raise.mock.calls[0][1]).toBe('GameServer.tournament_dark_after_rebuild');
  });

  it('a running table with no pause at all and a stopped dealer is not a reason to wait either', async () => {
    const m = realManager();
    const s = server(m, realEngine({ running: false }));
    db.rows = [DARK];
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).toHaveBeenCalledTimes(1);
  });
});

describe('a deliberate authority holds a dark event by its own name and bound', () => {
  it('the maintenance break, while it still holds the table', async () => {
    const m = realManager();
    const s = server(m, realEngine({ parked: true, maintenancePaused: true }));
    s.maintenanceBreak = { isHoldingTable: (id: string) => id === LIVE };
    db.rows = [DARK];
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).not.toHaveBeenCalled();
    // A maintenance flag the break no longer holds is not an authority.
    s.maintenanceBreak = { isHoldingTable: () => false };
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).toHaveBeenCalledTimes(1);
  });

  it('an operator floor hold that was read, never a floor read that failed', async () => {
    const held = realEngine({
      parked: true,
      operatorFloorPaused: true,
      operatorFloorHoldRead: true,
    });
    const s1 = server(realManager(), held);
    db.rows = [DARK];
    await s1.rebuildManagersOfDarkTournaments();
    expect(s1.retireTournamentManagerInDiscovery).not.toHaveBeenCalled();

    const unknown = realEngine({
      parked: true,
      operatorFloorPaused: true,
      operatorFloorHoldRead: false,
    });
    const s2 = server(realManager(), unknown);
    await s2.rebuildManagersOfDarkTournaments();
    expect(s2.retireTournamentManagerInDiscovery).toHaveBeenCalledTimes(1);
  });

  it('the add-on break until its durable end plus the last-hand grace', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T00:18:00Z'));
    const endsAt = Date.now() + MINUTE;
    const m = realManager({ addOnBreakActive: true, addOnBreakEndsAtMs: endsAt });
    const s = server(m, realEngine({ parked: true }));
    db.rows = [DARK];
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).not.toHaveBeenCalled();
    vi.setSystemTime(endsAt + 3 * MINUTE);
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).toHaveBeenCalledTimes(1);
  });

  it('an open final-table deal review inside its fifteen minutes plus grace, never a closing or overdue one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T00:18:00Z'));
    const review = { reviewId: 'r', tableId: LIVE, openedAtMs: Date.now() - 5 * MINUTE };
    const m = realManager({ finalTableDealReview: review });
    const s = server(m, realEngine({ parked: true }));
    db.rows = [DARK];
    await s.rebuildManagersOfDarkTournaments();
    expect(s.retireTournamentManagerInDiscovery).not.toHaveBeenCalled();

    const closing = realManager({ finalTableDealReview: { ...review, closingReason: 'expired' } });
    const s2 = server(closing, realEngine({ parked: true }));
    await s2.rebuildManagersOfDarkTournaments();
    expect(s2.retireTournamentManagerInDiscovery).toHaveBeenCalledTimes(1);

    const overdue = realManager({
      finalTableDealReview: { ...review, openedAtMs: Date.now() - 18 * MINUTE },
    });
    const s3 = server(overdue, realEngine({ parked: true }));
    await s3.rebuildManagersOfDarkTournaments();
    expect(s3.retireTournamentManagerInDiscovery).toHaveBeenCalledTimes(1);
  });
});
