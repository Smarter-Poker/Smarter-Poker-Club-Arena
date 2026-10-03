import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  responses: [] as Array<{ data: unknown; error: unknown }>,
  rpc: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => {
      state.rpc(...args);
      return Promise.resolve(state.responses.shift());
    },
  },
}));
vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { DriftIncidentService } from '../../src/services/DriftIncidentService';

const incident = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  detected_at: '2026-10-03T12:00:00Z',
  deadline_at: '2026-10-03T12:20:00Z',
  classification: 'ledger_imbalance',
  severity: 'critical',
  layer: 'ledger',
  status: 'open',
  source: 'fixture',
  club_id: null,
  union_id: null,
  table_id: null,
  tournament_id: null,
  hand_id: null,
  settlement_id: null,
  currency: 'club_chips',
  expected_amount: 100.25,
  actual_amount: 99.25,
  discrepancy_amount: -1,
  ledger_balanced: false,
  suspected_cause: null,
  auto_repair_status: 'pending',
  escalation_level: 0,
  past_target: false,
  occurrences: 1,
  acknowledged_by: null,
  acknowledged_at: null,
  assigned_to: null,
  root_cause: null,
  correction_ref: null,
  resolution: null,
  resolved_at: null,
  metadata: {},
  club_name: null,
  union_name: null,
  age_minutes: 1,
  events: [
    {
      at: '2026-10-03T12:00:00Z',
      kind: 'created',
      actor: null,
      detail: { headline: 'Drift Opened', action: 'inspect' },
    },
  ],
  ...overrides,
});

beforeEach(() => {
  state.responses = [];
  state.rpc.mockReset();
});

describe('DriftIncidentService verified reads', () => {
  it('retains verified signed money and normalizes event detail', async () => {
    state.responses.push({ data: [incident()], error: null });
    const rows = await DriftIncidentService.getDashboard(null, 10);
    expect(rows[0]).toMatchObject({
      expected_amount: 100.25,
      actual_amount: 99.25,
      discrepancy_amount: -1,
      occurrences: 1,
    });
    expect(rows[0].events[0].detail).toBe('Drift Opened | inspect');
  });

  it.each([null, {}, 'unavailable'])(
    'refuses malformed dashboard %j as an empty queue',
    async (data) => {
      state.responses.push({ data, error: null });
      await expect(DriftIncidentService.getDashboard()).rejects.toThrow('could not be verified');
    }
  );

  it.each([
    { discrepancy_amount: Number.NaN },
    { discrepancy_amount: '0' },
    { past_target: 'false' },
    { occurrences: 0 },
    { events: [{ at: 'not-a-time', kind: 'created', actor: null, detail: null }] },
  ])('refuses malformed incident financial or timeline state %#', async (overrides) => {
    state.responses.push({ data: [incident(overrides)], error: null });
    await expect(DriftIncidentService.getDashboard()).rejects.toThrow('could not be verified');
  });

  it('refuses duplicate incident identities', async () => {
    state.responses.push({ data: [incident(), incident()], error: null });
    await expect(DriftIncidentService.getDashboard()).rejects.toThrow('duplicate incidents');
  });

  it('does not query an invalid page limit', async () => {
    await expect(DriftIncidentService.getDashboard(null, 501)).rejects.toThrow('limit is invalid');
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('validates metrics instead of coercing malformed values to zero', async () => {
    state.responses.push({
      data: { auto_repairing: 2, suspense_today: -10.25, median_resolve_min: 4.5 },
      error: null,
    });
    await expect(DriftIncidentService.getMetrics()).resolves.toEqual({
      auto_repairing: 2,
      suspense_today: -10.25,
      median_resolve_min: 4.5,
    });

    state.responses.push({ data: { auto_repairing: '2' }, error: null });
    await expect(DriftIncidentService.getMetrics()).rejects.toThrow('could not be verified');
  });

  it('propagates an unavailable metrics read instead of returning an all-clear object', async () => {
    const error = { code: '42501', message: 'denied' };
    state.responses.push({ data: null, error });
    await expect(DriftIncidentService.getMetrics()).rejects.toBe(error);
  });

  it('refuses a malformed action success envelope', async () => {
    state.responses.push({ data: { ok: 'true' }, error: null });
    await expect(DriftIncidentService.acknowledge('incident')).rejects.toThrow(
      'could not be verified'
    );
  });
});
