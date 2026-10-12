/**
 * LAW: A SATELLITE CONSERVATION ALERT IS ONE ROW PER SATELLITE AND CLOSES
 * ITSELF WHEN THE SATELLITE CONSERVES (2026-10-09).
 *
 * FeeReconciler.satellite_conservation held 22 open criticals for three
 * Diamond satellites that had paid every winner. It raised a fresh row each
 * hourly pass with no subject key, and nothing ever closed a row once the
 * audit stopped reporting the satellite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const from = vi.fn<(...args: unknown[]) => unknown>();
const raiseFinancialAlert = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('./supabase.js', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) },
  logBBJCollection: vi.fn(),
}));
vi.mock('./supabase/bbj.js', () => ({ processBBJPayout: vi.fn(), setBBJPayoutQueue: vi.fn() }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('./financialAlerts.js', () => ({
  raiseFinancialAlert: (...a: unknown[]) => raiseFinancialAlert(...a),
}));

import {
  auditSatelliteConservation,
  satelliteIdsOfAlert,
  SATELLITE_CONSERVATION_RECHECK_HOURS,
} from './FeeReconciler.js';

const SAT_A = '7e56f752-e92b-4447-b12e-66d83d1c062a';
const SAT_B = 'e2ea5f2a-da30-425b-96cb-88a19799e21f';
const SAT_OLD = '11111111-1111-4111-8111-111111111111';

const recent = new Date(Date.now() - 36 * 3_600_000).toISOString();
const ancient = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();

function chain(result: { data: unknown; error: unknown }, onUpdate?: (patch: unknown) => void) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'or', 'limit', 'in']) c[m] = () => c;
  c.update = (patch: unknown) => {
    onUpdate?.(patch);
    return c;
  };
  c.then = (res: (v: unknown) => void) => res(result);
  return c;
}

const row = (sid: string) => ({
  satellite_id: sid,
  satellite_name: 'Sunday Deep Stack Satellite',
  pool: 600,
  ticket_cost: 200,
  awardable: 3,
  seats_funded: 0,
  cash_paid: 0,
  unpaid_winners: 0,
  excess_disbursed: 0,
});

function wire(opts: {
  flagged24: string[];
  flaggedRecheck: string[];
  open: Array<{ id: string; context: unknown }>;
  events: Array<{ id: string; status: string; ended_at: string }>;
}) {
  const updates: Array<{ patch: unknown }> = [];
  rpc.mockImplementation(async (_name: unknown, args: unknown) => {
    const hours = (args as { p_hours: number }).p_hours;
    const ids =
      hours === SATELLITE_CONSERVATION_RECHECK_HOURS ? opts.flaggedRecheck : opts.flagged24;
    return { data: ids.map(row), error: null };
  });
  from.mockImplementation((tableName: unknown) => {
    if (tableName === 'tournaments') return chain({ data: opts.events, error: null });
    return chain({ data: opts.open, error: null }, (patch) => updates.push({ patch }));
  });
  return updates;
}

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
  raiseFinancialAlert.mockReset();
  raiseFinancialAlert.mockResolvedValue({ persisted: true, alertId: 'x' });
});

describe('a satellite conservation alert is one row per satellite', () => {
  it('keys every alert on the satellite it names', async () => {
    wire({ flagged24: [SAT_A, SAT_B], flaggedRecheck: [SAT_A, SAT_B], open: [], events: [] });
    const out = await auditSatelliteConservation(24);
    expect(out).toEqual({ violations: 2, resolved: 0 });
    expect(raiseFinancialAlert).toHaveBeenCalledTimes(2);
    for (const [call, sid] of [
      [raiseFinancialAlert.mock.calls[0], SAT_A],
      [raiseFinancialAlert.mock.calls[1], SAT_B],
    ] as const) {
      expect(call[0]).toBe('critical');
      expect(call[1]).toBe('FeeReconciler.satellite_conservation');
      expect(call[4]).toBe(`satellite-conservation:${sid}`);
      expect(call[5]).toBe(sid);
    }
  });

  it('reads satellite ids from both the old multi-row shape and the new one', () => {
    expect(
      satelliteIdsOfAlert({ rows: [{ satellite_id: SAT_A }, { satellite_id: SAT_B }] })
    ).toEqual([SAT_A, SAT_B]);
    expect(satelliteIdsOfAlert({ satellite_id: SAT_A, rows: [{ satellite_id: SAT_A }] })).toEqual([
      SAT_A,
    ]);
    expect(satelliteIdsOfAlert(null)).toEqual([]);
  });
});

describe('and it closes itself only when every satellite it names conserves', () => {
  it('closes an alert whose satellites the audit read and no longer reports', async () => {
    const updates = wire({
      flagged24: [],
      flaggedRecheck: [],
      open: [{ id: 'al-1', context: { rows: [{ satellite_id: SAT_A }, { satellite_id: SAT_B }] } }],
      events: [
        { id: SAT_A, status: 'COMPLETED', ended_at: recent },
        { id: SAT_B, status: 'COMPLETED', ended_at: recent },
      ],
    });
    const out = await auditSatelliteConservation(24);
    expect(out).toEqual({ violations: 0, resolved: 1 });
    expect(updates).toHaveLength(1);
    const patch = updates[0].patch as { resolved: boolean; resolution: string };
    expect(patch.resolved).toBe(true);
    expect(patch.resolution).toContain(SAT_A);
    expect(patch.resolution).toContain('No money was moved');
  });

  it('keeps open an alert while any satellite it names is still reported', async () => {
    const updates = wire({
      flagged24: [],
      flaggedRecheck: [SAT_B],
      open: [{ id: 'al-1', context: { rows: [{ satellite_id: SAT_A }, { satellite_id: SAT_B }] } }],
      events: [
        { id: SAT_A, status: 'COMPLETED', ended_at: recent },
        { id: SAT_B, status: 'COMPLETED', ended_at: recent },
      ],
    });
    expect(await auditSatelliteConservation(24)).toEqual({ violations: 0, resolved: 0 });
    expect(updates).toHaveLength(0);
  });

  it('never reads absence as proof for a satellite the audit could not see', async () => {
    const updates = wire({
      flagged24: [],
      flaggedRecheck: [],
      open: [{ id: 'al-old', context: { satellite_id: SAT_OLD } }],
      events: [{ id: SAT_OLD, status: 'COMPLETED', ended_at: ancient }],
    });
    expect(await auditSatelliteConservation(24)).toEqual({ violations: 0, resolved: 0 });
    expect(updates).toHaveLength(0);
  });

  it('never closes an alert that names no satellite', async () => {
    const updates = wire({
      flagged24: [],
      flaggedRecheck: [],
      open: [{ id: 'al-x', context: {} }],
      events: [],
    });
    expect(await auditSatelliteConservation(24)).toEqual({ violations: 0, resolved: 0 });
    expect(updates).toHaveLength(0);
  });
});
