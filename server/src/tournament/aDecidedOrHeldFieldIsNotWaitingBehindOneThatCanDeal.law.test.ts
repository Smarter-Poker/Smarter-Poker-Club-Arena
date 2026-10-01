/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DECIDED OR HELD FIELD IS NOT WAITING BEHIND ONE THAT CAN DEAL (2026-10-01)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Production, 2026-10-01 19:00-20:10 UTC, engine 84131f2d: the process-wide
 * elimination scheduler held 625 managers with 577 queued, the oldest waiter
 * at 280 s and a sweep averaging 2.4 s over four slots.
 *
 * - Midday Free Buy 32375574 recorded its last bust at 19:32:22 and paid its
 *   winner at 19:52:14; DSS $100 Turbo Freeroll 9fee5704 recorded its last
 *   bust at 19:37:29 and completed at 20:07:19. The manager's own diagnostic
 *   showed no sweep admitted between 19:37:29 and 19:54:00 although the
 *   decided-but-RUNNING board woke it every ~70 s: each wake took a place at
 *   the back of the general FIFO.
 * - Cohort satellites c2a1ece4 (one survivor) and bd973d49 (two players, one
 *   seat) were re-adopted at 18:56, which holds the qualifier boundary and
 *   parks every table until a sweep reads the serialized state. Neither
 *   dealt nor finished for more than 90 minutes: the sweep that releases the
 *   boundary waited behind the whole platform, the zombie reaper rebuilt the
 *   parked tables every 600 s, and each rebuild held the boundary again.
 *
 * A decided field and a field parked on a qualifier boundary cannot deal, and
 * the only thing that can move either is this manager's sweep. Like a spread
 * field (aFieldThatCannotDealIsNotWaitingBehindOneThatCan), both are served
 * from the consolidation lane.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock('../services/errorReporter.js', () => ({ reportError: fixture.reportError }));
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => false }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: () => {
      throw new Error('no database in this fixture');
    },
    rpc: () => {
      throw new Error('no database in this fixture');
    },
  },
  maintenanceSupabase: {},
}));

const { tournamentEliminationScheduler } = await import('./TournamentEliminationScheduler.js');
const { TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js');

const tournamentId = '00000000-0000-4000-8000-0000000000dd';

function manager(extra: Record<string, unknown> = {}) {
  const m = Object.create(TournamentManagerEliminations.prototype) as any;
  Object.assign(m, {
    tournamentId,
    consolidationDeclared: false,
    pendingManagerWakes: new Map(),
    satelliteQualifierBoundaryPending: false,
    satelliteQualifierBoundaryGeneration: 0,
    satelliteQualifierEngines: new Map(),
    tableEngines: new Map(),
    ...extra,
  });
  return m;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a decided field asks for its finish pass from the consolidation lane', () => {
  it('the decided-but-RUNNING wake moves the manager to the lane before it is queued', () => {
    const order: string[] = [];
    vi.spyOn(tournamentEliminationScheduler, 'setConsolidating').mockImplementation(
      (id: string, on: boolean) => {
        order.push(`lane:${id}:${on}`);
        return true;
      }
    );
    vi.spyOn(tournamentEliminationScheduler, 'wake').mockImplementation((id: string) => {
      order.push(`wake:${id}`);
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = manager();
    expect(m.requestEliminationSweep('stalled_decided_survivor')).toBe(true);
    expect(order).toEqual([`lane:${tournamentId}:true`, `wake:${tournamentId}`]);
  });

  it('an ordinary wake leaves the lane alone', () => {
    const setConsolidating = vi.spyOn(tournamentEliminationScheduler, 'setConsolidating');
    vi.spyOn(tournamentEliminationScheduler, 'wake').mockReturnValue(true);
    const m = manager();
    m.requestEliminationSweep();
    m.requestEliminationSweep('break_ended');
    expect(setConsolidating).not.toHaveBeenCalled();
  });
});

describe('a held satellite qualifier boundary is served from the consolidation lane', () => {
  it('holding the boundary parks every table and moves the manager to the lane', () => {
    const setConsolidating = vi
      .spyOn(tournamentEliminationScheduler, 'setConsolidating')
      .mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const park = vi.fn().mockResolvedValue(false);
    const m = manager({ tableEngines: new Map([['table-1', { parkForTerminalCloseout: park }]]) });
    m.holdSatelliteQualifierBoundary();
    expect(m.satelliteQualifierBoundaryPending).toBe(true);
    expect(park).toHaveBeenCalledWith(0);
    expect(setConsolidating).toHaveBeenCalledWith(tournamentId, true);
  });

  it('an adopted satellite whose boundary was held before registration re-declares the lane', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./TournamentManagerBase.ts', import.meta.url), 'utf8');
    const register = source.slice(
      source.indexOf('protected registerEliminationScheduler('),
      source.indexOf('protected unregisterEliminationScheduler(')
    );
    const registered = register.indexOf('tournamentEliminationScheduler.register(');
    const redeclared = register.indexOf(
      'if (this.satelliteQualifierBoundaryPending) this.declareConsolidationOutstanding(true);'
    );
    expect(registered).toBeGreaterThan(0);
    expect(redeclared).toBeGreaterThan(registered);
  });

  it('a clean balance pass does not return a held boundary to the general lanes', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('./TournamentManagerEliminations.ts', import.meta.url),
      'utf8'
    );
    const balance = source.slice(
      source.indexOf('balanceStage: {'),
      source.indexOf('expansionStage: {')
    );
    expect(balance).toMatch(
      /this\.declareConsolidationOutstanding\(\s*this\.satelliteQualifierBoundaryPending \|\|/
    );
  });
});
