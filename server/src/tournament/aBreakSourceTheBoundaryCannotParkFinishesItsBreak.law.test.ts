/**
 * A BREAK SOURCE THE QUALIFIER BOUNDARY CANNOT PARK FINISHES ITS BREAK
 * (2026-10-12).
 *
 * A table break stops its source dealer before it closes the source table,
 * and the table row stays 'running' until the close commits. When the close
 * did not land, the cohort satellite's qualifier boundary found that source
 * with no running dealer, answered 'pending', and reset the sweep cursor, so
 * the balance stage that retries the close was never reached again.
 * Production 2026-10-12: satellite 61961519, break 444d8b63, close timed out
 * at 23:52:21Z, 9 players dealt nothing for over three hours.
 *
 * See docs/changelog/2026-10-12-a-break-source-the-boundary-cannot-park-finishes-its-break.md.
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

import { TournamentManager } from './TournamentManager.js';
import { supabase } from '../services/supabase.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EVENT = id(1);
const BREAK = id(2);
const SOURCE = id(3);
const DESTINATION = id(4);
const CONTINUING = {
  state: 'continuing',
  fullTicketCount: 7,
  qualifierIds: [id(11), id(12), id(13), id(14), id(15), id(16), id(17), id(18), id(19)],
};

function engine(running: boolean) {
  return {
    isRunning: () => running,
    parkForTerminalCloseout: vi.fn(async () => true),
    releaseTerminalCloseoutPause: vi.fn(),
  };
}

const begunBreak = (): any => ({
  ok: true,
  reason: null,
  break_id: BREAK,
  tournament_id: EVENT,
  source_table_id: SOURCE,
  lifecycle: '1156318',
  state: 'begun',
  revision: '1',
  custody_id: id(5),
  custody_generation: id(9),
  terminal_handoff_required: false,
  members: [],
});

/**
 * The production shape: both tables still 'running' in the database, the
 * source dealer stopped by its break's retirement, every player on the
 * destination, and the qualifier boundary held.
 */
function heldBoundary(source: ReturnType<typeof engine> | null) {
  const m: any = new TournamentManager(EVENT, {} as any, id(9), performance.now() + 60000);
  m.running = true;
  m.eliminationSweepDeadlineAt = 0;
  m.requestUrgentEliminationSweepAfter = vi.fn();
  m.isCohortSatellite = () => true;
  m.isRunning = () => true;
  m.eliminationMutationAllowed = () => true;
  const destination = engine(true);
  if (source) m.tableEngines.set(SOURCE, source);
  m.tableEngines.set(DESTINATION, destination);
  m.gameServer.getTableEngine = (tableId: string) => m.tableEngines.get(tableId);
  m.satelliteQualifierBoundaryPending = true;
  m.satelliteQualifierBoundaryGeneration = 4;
  const query: any = {
    select: () => query,
    eq: () => query,
    in: async () => ({ data: [{ id: SOURCE }, { id: DESTINATION }], error: null }),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(query);
  rpc.read.mockResolvedValue(CONTINUING);
  return { m, destination };
}

afterEach(() => {
  vi.restoreAllMocks();
  rpc.read.mockReset();
  rpc.settle.mockReset();
  rpc.report.mockReset();
});

describe('a break source the qualifier boundary cannot park finishes its break', () => {
  it('a stopped source whose break is open sends the sweep on to the balance stage', async () => {
    const { m, destination } = heldBoundary(engine(false));
    m.rememberTournamentBreak(begunBreak());
    expect(await m.checkSatelliteQualifierCompletion()).toBe('continue');
    // The boundary is still held: nothing is dealt until the break is finished.
    expect(m.satelliteQualifierBoundaryPending).toBe(true);
    expect(destination.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
    expect(rpc.settle).not.toHaveBeenCalled();
    expect(m.tournamentFinished).toBe(false);
    expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
  });

  it('a source with no dealer at all (a rebuilt manager) is treated the same way', async () => {
    const { m } = heldBoundary(null);
    m.rememberTournamentBreak(begunBreak());
    expect(await m.checkSatelliteQualifierCompletion()).toBe('continue');
    expect(m.satelliteQualifierBoundaryPending).toBe(true);
  });

  it('a stopped dealer with no open break keeps the old answer', async () => {
    const { m } = heldBoundary(engine(false));
    expect(await m.checkSatelliteQualifierCompletion()).toBe('pending');
    expect(m.satelliteQualifierBoundaryPending).toBe(true);
  });

  it('once the break is acknowledged the source no longer answers for it', async () => {
    const { m } = heldBoundary(engine(false));
    m.rememberTournamentBreak(begunBreak());
    m.rememberTournamentBreak({ ...begunBreak(), state: 'acknowledged' });
    expect(m.tableBreakOwnsSource(SOURCE)).toBe(false);
    expect(await m.checkSatelliteQualifierCompletion()).toBe('pending');
  });

  it('a running source is still parked like every other table', async () => {
    const source = engine(true);
    const { m, destination } = heldBoundary(source);
    m.rememberTournamentBreak(begunBreak());
    const answer = await m.checkSatelliteQualifierCompletion();
    expect(source.parkForTerminalCloseout).toHaveBeenCalledWith(0);
    expect(destination.parkForTerminalCloseout).toHaveBeenCalledWith(0);
    expect(answer).not.toBe('pending');
  });

  it('only the break source answers, never its destination', () => {
    const { m } = heldBoundary(engine(false));
    m.rememberTournamentBreak(begunBreak());
    expect(m.tableBreakOwnsSource(SOURCE)).toBe(true);
    expect(m.tableBreakOwnsSource(DESTINATION)).toBe(false);
  });
});
