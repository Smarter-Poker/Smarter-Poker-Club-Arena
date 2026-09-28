/**
 * A SATELLITE SETTLEMENT REFUSED BY A TABLE BREAK FINISHES THE BREAK, AND A
 * BREAK THAT MOVES NOBODY SAYS WHY (2026-09-28).
 *
 * `fn_settle_satellite_qualifiers` writes the qualifiers' seats and
 * registrations, and `f06_source_guard` refuses those writes
 * (`F06_SOURCE_EXCLUDED`) while a table break is open on one of the event's
 * tables. Only the elimination sweep's balance stage finishes a break. The
 * qualifier check answered that refusal with 'pending', which resets the
 * sweep cursor, so the balance stage was never reached again: the settlement
 * waited for the break and the break waited for the settlement, every table
 * parked for the qualifier boundary. Production 2026-09-28: satellites
 * b165b22f, 0e1d340e and e8cc6c78, every remaining player qualifying, frozen
 * 11 to 15 hours.
 *
 * The same day, three begun breaks (fae96c1e in 6a18ddaa, 0d1ff042 in
 * 2dbd67a7, b7c61dda in 0e1d340e) held active attempts that were never
 * dispatched, and the log said nothing, because every guard in
 * `dispatchTournamentBreakMembers` answered a bare `return`.
 *
 * See docs/changelog/2026-09-28-a-qualifier-refused-by-a-break-finishes-the-break.md.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({
  read: vi.fn(),
  settle: vi.fn(),
  report: vi.fn(),
}));
vi.mock('./satelliteQualifierRpc.js', () => ({
  readSatelliteQualifierState: rpc.read,
  requestSatelliteQualifierReceipt: rpc.settle,
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: rpc.report,
  describeError: (value: unknown) => String(value),
}));

import { readFileSync } from 'node:fs';
import { TournamentManager } from './TournamentManager.js';
import { isTableBreakExclusion } from './TournamentManagerEliminations.js';
import { SatelliteSettlementRefusedError } from './satelliteSettlementRpc.js';
import { supabase } from '../services/supabase.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EVENT = id(1);
const TABLE = id(3);
const BREAK = id(2);
const QUALIFYING = {
  state: 'qualifying',
  fullTicketCount: 7,
  qualifierIds: [id(11), id(12), id(13), id(14), id(15), id(16)],
};

function manager() {
  const m: any = new TournamentManager(EVENT, {} as any, id(9), performance.now() + 60000);
  m.running = true;
  m.eliminationSweepDeadlineAt = 0;
  m.requestUrgentEliminationSweepAfter = vi.fn();
  return m;
}

/** A cohort satellite whose one table is parked at the qualifier boundary. */
function qualifyingSatellite() {
  const m = manager();
  const engine = {
    isRunning: () => true,
    parkForTerminalCloseout: vi.fn(async () => true),
    releaseTerminalCloseoutPause: vi.fn(),
  };
  m.isCohortSatellite = () => true;
  m.isRunning = () => true;
  m.eliminationMutationAllowed = () => true;
  m.tableEngines.set(TABLE, engine);
  m.satelliteQualifierEngines.set(TABLE, engine);
  m.gameServer.getTableEngine = () => engine;
  m.satelliteQualifierBoundaryPending = true;
  m.satelliteQualifierBoundaryGeneration = 4;
  const query: any = {
    select: () => query,
    eq: () => query,
    in: async () => ({ data: [{ id: TABLE }], error: null }),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(query);
  rpc.read.mockResolvedValue(QUALIFYING);
  return { m, engine };
}

const begun = (): any => ({
  ok: true,
  reason: null,
  break_id: BREAK,
  tournament_id: EVENT,
  source_table_id: TABLE,
  lifecycle: '1',
  state: 'begun',
  revision: '3',
  custody_id: null,
  custody_generation: null,
  terminal_handoff_required: false,
  members: [
    {
      user_id: id(11),
      source_seat_id: id(111),
      source_seat_number: 1,
      occupancy_id: id(211),
      request_id: id(311),
      destination_table_id: id(8),
      destination_seat_number: 2,
      original_destination_table_id: id(8),
      original_destination_seat_number: 2,
      active_request_id: id(311),
      winner_request_id: null,
      winning_receipt: null,
      attempt_revision: 1,
    },
  ],
});

afterEach(() => {
  vi.restoreAllMocks();
  rpc.read.mockReset();
  rpc.settle.mockReset();
  rpc.report.mockReset();
});

describe('a qualifier settlement refused by a table break finishes the break', () => {
  it('the refusal is recognised by its code, and only by its code', () => {
    expect(isTableBreakExclusion(new SatelliteSettlementRefusedError('F06_SOURCE_EXCLUDED'))).toBe(
      true
    );
    expect(isTableBreakExclusion(new Error('refused: F06_SOURCE_EXCLUDED (55000)'))).toBe(true);
    expect(isTableBreakExclusion(new SatelliteSettlementRefusedError('F06_SOURCE_NOT_EXACT'))).toBe(
      false
    );
    expect(isTableBreakExclusion('F06_SOURCE_EXCLUDED')).toBe(false);
  });

  it('F06_SOURCE_EXCLUDED lets the sweep go on to the balance stage, keeps every table parked, and asks again', async () => {
    const { m, engine } = qualifyingSatellite();
    rpc.settle.mockRejectedValue(new SatelliteSettlementRefusedError('F06_SOURCE_EXCLUDED'));
    const answer = await m.checkSatelliteQualifierCompletion();
    expect(answer).toBe('continue');
    // The boundary is still held: no dealer may deal while qualifiers are open.
    expect(m.satelliteQualifierBoundaryPending).toBe(true);
    expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
    expect(m.tournamentFinished).toBe(false);
    expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
    // The refusal names its event.
    expect(rpc.report).toHaveBeenCalledWith(
      expect.any(SatelliteSettlementRefusedError),
      'Tournament.satellite_qualifiers_refused',
      expect.objectContaining({ tournamentId: EVENT, qualifierCount: 6 })
    );
  });

  it('every other refusal keeps its old answer', async () => {
    const { m, engine } = qualifyingSatellite();
    rpc.settle.mockRejectedValue(
      new SatelliteSettlementRefusedError('satellite qualifier set changed')
    );
    expect(await m.checkSatelliteQualifierCompletion()).toBe('pending');
    expect(m.satelliteQualifierBoundaryPending).toBe(true);
    expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
    expect(m.tournamentFinished).toBe(false);
  });

  it("'continue' is the answer the sweep turns into the balance stage, not a cursor reset", () => {
    const source = readFileSync(
      new URL('./TournamentManagerEliminations.ts', import.meta.url),
      'utf8'
    );
    const finish = source.slice(
      source.indexOf('const satelliteFinish = await this.checkSatelliteQualifierCompletion();'),
      source.indexOf('// Check remaining players AFTER all eliminations processed')
    );
    expect(finish).toMatch(
      /if \(satelliteFinish === 'continue'\) \{\s*if \(completedStage\(3\)\) return;\s*break finishStage;/
    );
    const balance = source.indexOf('balanceStage: {');
    expect(balance).toBeGreaterThan(source.indexOf('finishStage: {'));
    expect(source.slice(balance, balance + 1200)).toContain('await this.checkTableBalance()');
  });
});

describe('a begun break that moves nobody says why', () => {
  it('an unresolved seat move names itself once per change', async () => {
    const m = manager();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    m.pendingTournamentSeatMoveOutcomes.set(id(400), { input: { sourceTableId: id(7) } });
    await m.dispatchTournamentBreakMembers(begun());
    await m.dispatchTournamentBreakMembers(begun());
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((l) => l.includes('members not dispatched'))).toEqual([
      `[Tournament:${EVENT.slice(0, 8)}] Break ${BREAK.slice(0, 8)} members not dispatched: seat_move_outcome_pending:1`,
    ]);
    expect(m.lastBreakDispatchRefusal(BREAK)).toBe('seat_move_outcome_pending:1');
  });

  it('a source with no engine names itself', async () => {
    const m = manager();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await m.dispatchTournamentBreakMembers(begun());
    expect(m.lastBreakDispatchRefusal(BREAK)).toBe('source_engine_absent');
  });

  it('a source boundary that could not be claimed names itself', async () => {
    const m = manager();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const engine = {};
    m.eliminationMutationAllowed = () => true;
    m.tableEngines.set(TABLE, engine);
    m.gameServer.ownsTournamentTableEngine = () => true;
    m.claimTournamentMoveBoundary = vi.fn(async () => null);
    await m.dispatchTournamentBreakMembers(begun());
    expect(m.claimTournamentMoveBoundary).toHaveBeenCalledTimes(1);
    expect(m.lastBreakDispatchRefusal(BREAK)).toBe('source_boundary_unclaimed');
  });

  it('an acknowledged break forgets its dispatch refusal', async () => {
    const m = manager();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await m.dispatchTournamentBreakMembers(begun());
    expect(m.lastBreakDispatchRefusal(BREAK)).toBe('source_engine_absent');
    m.rememberTournamentBreak({ ...begun(), state: 'acknowledged' });
    expect(m.lastBreakDispatchRefusal(BREAK)).toBeNull();
  });
});
