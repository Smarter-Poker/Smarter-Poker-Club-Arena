/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DECIDED EVENT IS PAID BEFORE THE BREAK, NOT AFTER IT (2026-10-02)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Production, 2026-10-02, read from tournament_terminal_settlements and
 * engine_maintenance_break_log: 16-25 terminal settlements a minute up to the
 * hourly announcement, then none at all until the thaw. The last before each
 * break landed at 14:52:54, 15:52:57 and 16:52:58; the next at 15:03:09,
 * 16:03:00 and 17:02:48. finishTournament refused on isMaintenanceFrozen(),
 * which goes up at the :53 ANNOUNCEMENT, so a field that was already down to
 * its last player sat out the last-hand minutes and the whole break with its
 * winner unpaid (b719bb0e: last bust 14:45:54, completed 15:05:52), and
 * fn_ca_tournament_finished_but_not_completed(15) filed a critical each hour.
 *
 * A decided event moves no table action. The settlement gate is now the break
 * itself: a finish is admitted during the announced last-hand window until
 * TERMINAL_SETTLEMENT_LEAD_MS before :55 (longer than the terminal RPC's own
 * 45-second statement ceiling, so an admitted finish is answered before the
 * five minutes begin). After that the finish is deferred exactly as before,
 * but its field is declared decided and the thaw edge asks for its pass, so
 * the scheduler's decided lane - read before every live lane - serves it
 * first when the platform comes back.
 *
 * Unchanged, and pinned elsewhere: every other gate still reads
 * isMaintenanceFrozen() from :53 (theFreezeIsTotal), and the finish still
 * refuses during the break proper (CommittedSettlementCleanup.guard).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  requestTerminal: vi.fn(),
  reportError: vi.fn(),
}));
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
vi.mock('../services/errorReporter.js', () => ({ reportError: fixture.reportError }));
vi.mock('./terminalSettlementRpc.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./terminalSettlementRpc.js')>()),
  requestTournamentTerminalReceipt: fixture.requestTerminal,
}));

const {
  setMaintenanceFrozen,
  isMaintenanceFrozen,
  isTerminalSettlementFrozen,
  TERMINAL_SETTLEMENT_LEAD_MS,
} = await import('../maintenance/freezeState.js');
const { MaintenanceBreak } = await import('../maintenance/MaintenanceBreak.js');
const { tournamentEliminationScheduler } = await import('./TournamentEliminationScheduler.js');
const { TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js');

const decidedId = '00000000-0000-4000-8000-00000000d0d0';
const winnerId = '00000000-0000-4000-8000-00000000a111';
const ANNOUNCED_AT = Date.parse('2026-10-02T14:53:00.000Z');
const BREAK_AT = Date.parse('2026-10-02T14:55:00.000Z');

const receipt = () => ({
  tournamentId: decidedId,
  winnerId,
  winnerAmount: 190,
  settlementMode: 'places',
});

/** A manager whose field is down to one player, with the finish's tail stubbed. */
function decidedManager() {
  const m = Object.create(TournamentManagerEliminations.prototype) as any;
  Object.assign(m, {
    tournamentId: decidedId,
    running: true,
    committedFinishReceipt: null,
    committedSatelliteReceipt: null,
    tournamentFinished: false,
    tournamentCache: { variant: 'nlh', tournament_type: 'SNG' },
    pendingManagerWakes: new Map(),
    clearFinishRefusalStreak: vi.fn(),
    cleanupCommittedTournament: vi.fn().mockResolvedValue(undefined),
  });
  return m;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(ANNOUNCED_AT);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fixture.requestTerminal.mockReset();
  fixture.requestTerminal.mockResolvedValue(receipt());
});

afterEach(() => {
  setMaintenanceFrozen(false);
  tournamentEliminationScheduler.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the settlement gate is the break, not the announcement', () => {
  it('is open from the announcement until the lead before :55, while everything else is frozen', () => {
    setMaintenanceFrozen(true, BREAK_AT);
    expect(isMaintenanceFrozen()).toBe(true);
    expect(isTerminalSettlementFrozen(ANNOUNCED_AT)).toBe(false);
    expect(isTerminalSettlementFrozen(BREAK_AT - TERMINAL_SETTLEMENT_LEAD_MS - 1)).toBe(false);
    expect(isTerminalSettlementFrozen(BREAK_AT - TERMINAL_SETTLEMENT_LEAD_MS)).toBe(true);
    expect(isTerminalSettlementFrozen(BREAK_AT)).toBe(true);
  });

  it('leaves room for one whole terminal statement before the break begins', () => {
    // fn_complete_tournament_terminal carries a 45-second statement ceiling.
    expect(TERMINAL_SETTLEMENT_LEAD_MS).toBeGreaterThan(45_000);
  });

  it('is closed from the first instant of any freeze entered without an announced start', () => {
    setMaintenanceFrozen(true);
    expect(isTerminalSettlementFrozen(ANNOUNCED_AT)).toBe(true);
    // The countdown re-asserts the freeze with no start: the window closes even early.
    setMaintenanceFrozen(true, BREAK_AT);
    setMaintenanceFrozen(true);
    expect(isTerminalSettlementFrozen(ANNOUNCED_AT)).toBe(true);
  });

  it('is open again at the thaw', () => {
    setMaintenanceFrozen(true);
    setMaintenanceFrozen(false);
    expect(isTerminalSettlementFrozen()).toBe(false);
  });
});

describe('a tournament with one player left during the pre-break countdown', () => {
  it('is finished and paid inside the last-hand window', async () => {
    setMaintenanceFrozen(true, BREAK_AT);
    vi.setSystemTime(ANNOUNCED_AT + 30_000); // 14:53:30, "Last Hand" on every felt
    const m = decidedManager();

    await m.finishTournament(winnerId);

    expect(fixture.requestTerminal).toHaveBeenCalledOnce();
    expect(fixture.requestTerminal).toHaveBeenCalledWith(decidedId, 'places', winnerId);
    expect(m.committedFinishReceipt).toEqual(receipt());
    expect(m.cleanupCommittedTournament).toHaveBeenCalledOnce();
    expect(m.tournamentFinished).toBe(true);
  });

  it('is deferred past the cutoff, declared decided, and re-armed', async () => {
    setMaintenanceFrozen(true, BREAK_AT);
    vi.setSystemTime(BREAK_AT - TERMINAL_SETTLEMENT_LEAD_MS + 1_000);
    const setDecided = vi.spyOn(tournamentEliminationScheduler, 'setDecided');
    const wakeUrgentAfter = vi.spyOn(tournamentEliminationScheduler, 'wakeUrgentAfter');
    const m = decidedManager();

    await m.finishTournament(winnerId);

    expect(fixture.requestTerminal).not.toHaveBeenCalled();
    expect(m.tournamentFinished).toBe(false);
    expect(setDecided).toHaveBeenCalledWith(decidedId);
    expect(wakeUrgentAfter).toHaveBeenCalledWith(decidedId, expect.any(Number));
  });
});

describe('a finish the break deferred is first in line after the thaw', () => {
  it('is dispatched ahead of live work that was queued before it', async () => {
    setMaintenanceFrozen(true); // the break proper
    const dispatched: string[] = [];
    const releases: Array<() => void> = [];
    const hold = (id: string) => () =>
      new Promise<void>((resolve) => {
        dispatched.push(id);
        releases.push(resolve);
      });

    // Four live sweeps hold every general slot through the break.
    for (let i = 0; i < 4; i++) {
      const id = `00000000-0000-4000-8000-0000000000b${i}`;
      tournamentEliminationScheduler.register({ tournamentId: id, run: hold(id) });
    }
    // Five more live events queue behind them, with busts to record.
    const live: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `00000000-0000-4000-8000-0000000000c${i}`;
      live.push(id);
      tournamentEliminationScheduler.register({ tournamentId: id, run: hold(id) });
      tournamentEliminationScheduler.wake(id);
    }
    // The decided event registers last, at the back of the general queue.
    const m = decidedManager();
    tournamentEliminationScheduler.register({
      tournamentId: decidedId,
      run: async () => {
        dispatched.push(decidedId);
        await m.finishTournament(winnerId);
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatched).toHaveLength(4);

    // Its sweep reached the finish during the break: deferred.
    await m.finishTournament(winnerId);
    expect(fixture.requestTerminal).not.toHaveBeenCalled();

    // The thaw. One live slot comes back.
    setMaintenanceFrozen(false);
    await vi.advanceTimersByTimeAsync(0);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);

    expect(dispatched[4]).toBe(decidedId);
    expect(fixture.requestTerminal).toHaveBeenCalledOnce();
    expect(fixture.requestTerminal).toHaveBeenCalledWith(decidedId, 'places', winnerId);
    expect(m.tournamentFinished).toBe(true);
    // The live events that were queued before it come after it, in their order.
    expect(dispatched.slice(5)).toEqual([live[0]]);
    for (const release of releases) release();
  });

  it('a manager that is no longer running asks for nothing at the thaw, and lets go of it', async () => {
    setMaintenanceFrozen(true);
    const wake = vi.spyOn(tournamentEliminationScheduler, 'wake');
    const m = decidedManager();
    await m.finishTournament(winnerId);
    expect(m.decidedThawUnsubscribe).toEqual(expect.any(Function));
    m.running = false;
    setMaintenanceFrozen(false);
    expect(wake).not.toHaveBeenCalledWith(decidedId);
    expect(m.decidedThawUnsubscribe).toBeNull();
  });

  it('one subscription per manager, however many times the break defers it', async () => {
    setMaintenanceFrozen(true);
    const wake = vi.spyOn(tournamentEliminationScheduler, 'wake').mockReturnValue(true);
    const m = decidedManager();
    await m.finishTournament(winnerId);
    await m.finishTournament(winnerId);
    await m.finishTournament(winnerId);
    setMaintenanceFrozen(false);
    expect(wake.mock.calls.filter(([id]) => id === decidedId)).toHaveLength(1);
  });
});

describe('the maintenance break opens the window at the announcement and shuts it at the countdown', () => {
  /** One quiet table at its gate, and a store that keeps what it is given. */
  function build() {
    let row: any = null;
    const engine = {
      paused: false,
      pauseForMaintenance() {
        this.paused = true;
      },
      resumeFromMaintenance() {
        this.paused = false;
      },
      isParkedBetweenHands: () => true,
      isBetweenHands: () => true,
      isRunning: () => true,
    };
    const store = {
      loadReleaseBoundary: async () => null,
      load: async () => row,
      save: async (state: any) => {
        row = { ...state };
      },
      claim: async () => row,
      clear: async () => {
        row = null;
      },
    };
    const mb = new MaintenanceBreak({
      engines: () => new Map([['t0', engine]]).entries() as any,
      isRunning: () => true,
      emit: () => {},
      store: store as any,
      recordOutcome: async () => {},
      recordFault: async () => {},
    });
    return mb;
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A quiet :20, so no clock-derived break is running when the test starts.
    vi.setSystemTime(Date.parse('2026-10-02T12:20:00.000Z'));
  });

  it("freezes every other gate at once but leaves a decided event's settlement open until the lead", async () => {
    const mb = build();
    const announcedAt = Date.now();
    await mb.announceLastHand();
    expect(isMaintenanceFrozen()).toBe(true);
    expect(isTerminalSettlementFrozen()).toBe(false);
    const cutoff = announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS - TERMINAL_SETTLEMENT_LEAD_MS;
    expect(isTerminalSettlementFrozen(cutoff - 1)).toBe(false);
    expect(isTerminalSettlementFrozen(cutoff)).toBe(true);
  });

  it('shuts the window the moment the countdown begins, even an early one', async () => {
    const mb = build();
    await mb.announceLastHand();
    await mb.beginCountdown(); // a manual call well before the scheduled :55
    expect(isMaintenanceFrozen()).toBe(true);
    expect(isTerminalSettlementFrozen()).toBe(true);
  });
});
