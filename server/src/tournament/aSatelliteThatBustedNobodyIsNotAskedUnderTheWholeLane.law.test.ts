/**
 * A SATELLITE THAT HAS BUSTED NOBODY IS NOT ASKED AGAIN UNDER THE WHOLE
 * FINISH LANE (2026-10-03).
 *
 * fn_get_satellite_qualifier_state takes ca:tournament-finish-lane:v1
 * exclusively, so every ordinary finish on the platform drains before it and
 * queues behind it. Production 13:03-13:33 UTC on 2026-10-03: four cohort
 * satellites with three eliminations in ten minutes asked ~6.7 times a
 * minute, each waiting ~3.3 s for the lane, and 96 Spin / Sit & Go / MTT
 * finishes waited ~3.6 s behind them.
 *
 * The law: an authoritative 'continuing' answer read while no boundary was
 * held, with the live field more than one player above the ticket count, is
 * reused until the boundary generation moves (every zero-stack hand holds
 * the boundary first) or five minutes pass. Everything near the bubble, and
 * every other state, is read under the lane exactly as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({ read: vi.fn(), settle: vi.fn(), report: vi.fn() }));
vi.mock('./satelliteQualifierRpc.js', () => ({
  readSatelliteQualifierState: rpc.read,
  requestSatelliteQualifierReceipt: rpc.settle,
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: rpc.report,
  describeError: (value: unknown) => String(value),
}));

import { TournamentManager } from './TournamentManager.js';
import { TournamentManagerEliminations } from './TournamentManagerEliminations.js';
import { supabase } from '../services/supabase.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EVENT = id(1);
const TABLE = id(3);
const field = (n: number) => Array.from({ length: n }, (_, i) => id(100 + i));
const continuing = (live: number, tickets: number) => ({
  state: 'continuing',
  fullTicketCount: tickets,
  qualifierIds: field(live),
});

function satellite() {
  const m: any = new TournamentManager(EVENT, {} as any, id(9), performance.now() + 60000);
  m.running = true;
  m.eliminationSweepDeadlineAt = 0;
  m.requestUrgentEliminationSweepAfter = vi.fn();
  m.isCohortSatellite = () => true;
  m.isRunning = () => true;
  m.eliminationMutationAllowed = () => true;
  m.declareConsolidationOutstanding = vi.fn();
  const engine = {
    isRunning: () => true,
    parkForTerminalCloseout: vi.fn(async () => true),
    releaseTerminalCloseoutPause: vi.fn(),
  };
  m.tableEngines.set(TABLE, engine);
  m.gameServer.getTableEngine = () => engine;
  m.satelliteQualifierBoundaryPending = false;
  m.satelliteQualifierBoundaryGeneration = 4;
  return m;
}

afterEach(() => {
  vi.restoreAllMocks();
  rpc.read.mockReset();
  rpc.settle.mockReset();
  rpc.report.mockReset();
});

describe('a satellite that has busted nobody is not asked again under the whole lane', () => {
  it('reuses a continuing answer for a field well above its tickets', async () => {
    const m = satellite();
    rpc.read.mockResolvedValue(continuing(15, 8));
    expect(await m.checkSatelliteQualifierCompletion()).toBe('continue');
    for (let i = 0; i < 5; i++)
      expect(await m.checkSatelliteQualifierCompletion()).toBe('continue');
    expect(rpc.read).toHaveBeenCalledTimes(1);
  });

  it('asks again under the lane after any zero-stack hand holds the boundary', async () => {
    const m = satellite();
    rpc.read.mockResolvedValue(continuing(15, 8));
    await m.checkSatelliteQualifierCompletion();
    m.holdSatelliteQualifierBoundary();
    // While the boundary is held, every sweep asks.
    rpc.read.mockResolvedValue({
      state: 'unresolved',
      fullTicketCount: 8,
      qualifierIds: field(14),
    });
    expect(await m.checkSatelliteQualifierCompletion()).toBe('pending');
    expect(rpc.read).toHaveBeenCalledTimes(2);
    expect(await m.checkSatelliteQualifierCompletion()).toBe('pending');
    expect(rpc.read).toHaveBeenCalledTimes(3);
  });

  it('a released boundary reuses only the answer read for its own generation', async () => {
    const m = satellite();
    rpc.read.mockResolvedValue(continuing(15, 8));
    await m.checkSatelliteQualifierCompletion();
    m.holdSatelliteQualifierBoundary();
    const query: any = {
      select: () => query,
      eq: () => query,
      in: async () => ({ data: [{ id: TABLE }], error: null }),
    };
    vi.spyOn(supabase, 'from').mockReturnValue(query);
    rpc.read.mockResolvedValue(continuing(14, 8));
    // Held: parks, reads twice under the lane, releases, answers continue.
    expect(await m.checkSatelliteQualifierCompletion()).toBe('continue');
    expect(m.satelliteQualifierBoundaryPending).toBe(false);
    const asked = rpc.read.mock.calls.length;
    expect(await m.checkSatelliteQualifierCompletion()).toBe('continue');
    expect(rpc.read).toHaveBeenCalledTimes(asked);
  });

  it('a field within one player of its tickets is read every time', async () => {
    const m = satellite();
    rpc.read.mockResolvedValue(continuing(9, 8));
    await m.checkSatelliteQualifierCompletion();
    await m.checkSatelliteQualifierCompletion();
    expect(rpc.read).toHaveBeenCalledTimes(2);
  });

  it('entry_open, unresolved and an unreadable answer are never reused', async () => {
    const m = satellite();
    rpc.read.mockResolvedValue({ state: 'entry_open' });
    await m.checkSatelliteQualifierCompletion();
    await m.checkSatelliteQualifierCompletion();
    expect(rpc.read).toHaveBeenCalledTimes(2);

    const u = satellite();
    rpc.read.mockReset();
    rpc.read.mockResolvedValue({
      state: 'unresolved',
      fullTicketCount: 8,
      qualifierIds: field(15),
    });
    await u.checkSatelliteQualifierCompletion();
    u.satelliteQualifierBoundaryPending = false;
    await u.checkSatelliteQualifierCompletion();
    expect(rpc.read).toHaveBeenCalledTimes(2);

    const e = satellite();
    rpc.read.mockReset();
    rpc.read.mockRejectedValueOnce(new Error('lock timeout'));
    rpc.read.mockResolvedValue(continuing(15, 8));
    expect(await e.checkSatelliteQualifierCompletion()).toBe('pending');
    expect(await e.checkSatelliteQualifierCompletion()).toBe('continue');
    expect(rpc.read).toHaveBeenCalledTimes(2);
  });

  it('a boundary held while the answer was in flight is not reused', async () => {
    const m = satellite();
    rpc.read.mockImplementationOnce(async () => {
      m.holdSatelliteQualifierBoundary();
      return continuing(15, 8);
    });
    rpc.read.mockResolvedValue(continuing(15, 8));
    await m.checkSatelliteQualifierCompletion();
    m.satelliteQualifierBoundaryPending = false;
    await m.checkSatelliteQualifierCompletion();
    expect(rpc.read.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('five minutes is the longest an answer is reused', async () => {
    const m = satellite();
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    rpc.read.mockResolvedValue(continuing(15, 8));
    await m.checkSatelliteQualifierCompletion();
    now += TournamentManagerEliminations.SATELLITE_CONTINUATION_REUSE_MS - 1;
    await m.checkSatelliteQualifierCompletion();
    expect(rpc.read).toHaveBeenCalledTimes(1);
    now += 1;
    await m.checkSatelliteQualifierCompletion();
    expect(rpc.read).toHaveBeenCalledTimes(2);
  });

  it('a single-ticket event keeps its legacy answer and reuses it the same way', async () => {
    const m = satellite();
    rpc.read.mockResolvedValue(continuing(6, 1));
    expect(await m.checkSatelliteQualifierCompletion()).toBe('legacy');
    expect(await m.checkSatelliteQualifierCompletion()).toBe('legacy');
    expect(rpc.read).toHaveBeenCalledTimes(1);
  });

  it('a non-cohort event never asks', async () => {
    const m = satellite();
    m.isCohortSatellite = () => false;
    expect(await m.checkSatelliteQualifierCompletion()).toBe('legacy');
    expect(rpc.read).not.toHaveBeenCalled();
  });
});
