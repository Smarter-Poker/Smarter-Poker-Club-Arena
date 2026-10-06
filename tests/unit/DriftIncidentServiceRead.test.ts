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
  can_act: true,
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

const gatePanel = () => ({
  gate: {
    run_at: '2026-10-05T12:00:00Z',
    pass: true,
    window_hours: 24,
    failing: [],
    result: {},
  },
  supply_series: [
    {
      taken_at: '2026-10-05T11:00:00Z',
      unexplained: -1.25,
      total: 1200,
      cert_wallets: 1000,
      leaderboard_liability: 200,
    },
  ],
  diamond_series: [{ taken_at: '2026-10-05T11:00:00Z', unexplained: 0, total: 500 }],
  open_counts: { critical: 0, warning: 0, info: 2 },
  generated_at: '2026-10-05T12:00:01Z',
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

  it('withholds unstructured event objects instead of serializing internal data', async () => {
    state.responses.push({
      data: [
        incident({
          events: [
            {
              at: '2026-10-03T12:00:00Z',
              kind: 'created',
              actor: '11111111-1111-4111-8111-111111111111',
              detail: { entity_id: '22222222-2222-4222-8222-222222222222' },
            },
          ],
        }),
      ],
      error: null,
    });

    const rows = await DriftIncidentService.getDashboard(null, 10);
    expect(rows[0].events[0].detail).toBeNull();
  });

  it.each([null, {}, 'unavailable'])(
    'refuses malformed dashboard %j as an empty queue',
    async (data) => {
      state.responses.push({ data, error: null });
      await expect(DriftIncidentService.getDashboard()).rejects.toThrow('could not be verified');
    }
  );

  it.each([
    { id: 'not-an-incident-uuid' },
    { can_act: 'true' },
    { discrepancy_amount: Number.NaN },
    { discrepancy_amount: '0' },
    { past_target: 'false' },
    { occurrences: 0 },
    { status: 'resolved', resolved_at: null },
    { status: 'open', resolved_at: '2026-10-03T12:01:00Z' },
    { events: [{ at: 'not-a-time', kind: 'created', actor: null, detail: null }] },
  ])('refuses malformed incident financial or timeline state %#', async (overrides) => {
    state.responses.push({ data: [incident(overrides)], error: null });
    await expect(DriftIncidentService.getDashboard()).rejects.toThrow('could not be verified');
  });

  it('identifies the exact incident whose timeline is invalid', async () => {
    state.responses.push({
      data: [incident({ resolved_at: '2026-10-03T11:59:59Z', status: 'resolved' })],
      error: null,
    });
    await expect(DriftIncidentService.getDashboard()).rejects.toThrow(
      'Drift incident 11111111-1111-4111-8111-111111111111 timeline could not be verified'
    );
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
    const metrics = {
      open_total: 2,
      open_critical: 1,
      past_target: 1,
      auto_repairing: 2,
      resolved_today: 3,
      median_resolve_min: 4.5,
      worst_open_drift: 10.25,
      suspense_today: -10.25,
      ledger_write_failures_24h: 0,
      supply_unexplained_last: null,
      ledger_rows_today: 50,
    };
    state.responses.push({
      data: metrics,
      error: null,
    });
    await expect(DriftIncidentService.getMetrics()).resolves.toEqual(metrics);

    state.responses.push({ data: { ...metrics, auto_repairing: '2' }, error: null });
    await expect(DriftIncidentService.getMetrics()).rejects.toThrow('could not be verified');
  });

  it('accepts a complete scoped metric envelope without privileged ledger facts', async () => {
    const scopedMetrics = {
      open_total: 2,
      open_critical: 1,
      past_target: 1,
      auto_repairing: 0,
      resolved_today: 3,
      median_resolve_min: 4.5,
      worst_open_drift: 10.25,
    };
    state.responses.push({ data: scopedMetrics, error: null });

    await expect(DriftIncidentService.getMetrics()).resolves.toEqual(scopedMetrics);
  });

  it('refuses a partial privileged metric bundle', async () => {
    state.responses.push({
      data: {
        open_total: 2,
        open_critical: 1,
        past_target: 1,
        auto_repairing: 0,
        resolved_today: 3,
        median_resolve_min: null,
        worst_open_drift: 10.25,
        suspense_today: 1,
      },
      error: null,
    });

    await expect(DriftIncidentService.getMetrics()).rejects.toThrow(
      'Global drift metrics could not be verified'
    );
  });

  it.each([{ open_total: undefined }, { worst_open_drift: -1 }, { median_resolve_min: -1 }])(
    'rejects an incomplete or impossible metric envelope %#',
    async (override) => {
      state.responses.push({
        data: {
          open_total: 0,
          open_critical: 0,
          past_target: 0,
          auto_repairing: 0,
          resolved_today: 0,
          median_resolve_min: null,
          worst_open_drift: 0,
          suspense_today: 0,
          ledger_write_failures_24h: 0,
          supply_unexplained_last: null,
          ledger_rows_today: 0,
          ...override,
        },
        error: null,
      });
      await expect(DriftIncidentService.getMetrics()).rejects.toThrow('could not be verified');
    }
  );

  it('propagates an unavailable metrics read instead of returning an all-clear object', async () => {
    const error = { code: '42501', message: 'denied' };
    state.responses.push({ data: null, error });
    await expect(DriftIncidentService.getMetrics()).rejects.toBe(error);
  });

  it('distinguishes a gate-panel transport failure from a verified management refusal', async () => {
    const error = { code: '57014', message: 'gate read timed out' };
    state.responses.push({ data: null, error });
    await expect(DriftIncidentService.getGatePanel()).rejects.toBe(error);

    state.responses.push({ data: null, error: null });
    await expect(DriftIncidentService.getGatePanel()).resolves.toBeNull();
  });

  it('normalizes a verified gate panel without erasing signed unexplained deltas', async () => {
    const data = gatePanel();
    state.responses.push({ data, error: null });
    await expect(DriftIncidentService.getGatePanel()).resolves.toEqual(data);
  });

  it.each([
    () => ({ ...gatePanel(), generated_at: 'not-a-time' }),
    () => ({
      ...gatePanel(),
      generated_at: '2099-01-01T00:00:01Z',
      gate: { ...gatePanel().gate, run_at: '2099-01-01T00:00:00Z' },
    }),
    () => ({ ...gatePanel(), gate: { ...gatePanel().gate, pass: 'true' } }),
    () => ({ ...gatePanel(), gate: { ...gatePanel().gate, run_at: 'not-a-time' } }),
    () => ({
      ...gatePanel(),
      gate: { ...gatePanel().gate, run_at: '2026-10-05T12:00:02Z' },
    }),
    () => ({ ...gatePanel(), gate: { ...gatePanel().gate, window_hours: -1 } }),
    () => ({ ...gatePanel(), gate: { ...gatePanel().gate, failing: [''] } }),
    () => ({ ...gatePanel(), gate: { ...gatePanel().gate, failing: ['silent_lane'] } }),
    () => ({ ...gatePanel(), supply_series: 'unavailable' }),
    () => ({
      ...gatePanel(),
      supply_series: [{ ...gatePanel().supply_series[0], total: -1 }],
    }),
    () => ({
      ...gatePanel(),
      diamond_series: [{ ...gatePanel().diamond_series[0], unexplained: Number.NaN }],
    }),
    () => ({
      ...gatePanel(),
      supply_series: [{ ...gatePanel().supply_series[0], taken_at: '2026-10-05T12:00:02Z' }],
    }),
    () => ({
      ...gatePanel(),
      supply_series: [
        { ...gatePanel().supply_series[0], taken_at: '2026-10-05T11:30:00Z' },
        { ...gatePanel().supply_series[0], taken_at: '2026-10-05T11:00:00Z' },
      ],
    }),
    () => ({
      ...gatePanel(),
      diamond_series: [
        { ...gatePanel().diamond_series[0], taken_at: '2026-10-05T11:30:00Z' },
        { ...gatePanel().diamond_series[0], taken_at: '2026-10-05T11:00:00Z' },
      ],
    }),
    () => ({ ...gatePanel(), open_counts: { critical: '1' } }),
    () => ({ ...gatePanel(), open_counts: { unknown: 1 } }),
    () => ({ ...gatePanel(), open_counts: { critical: 1 } }),
  ])(
    'refuses malformed gate panel truth instead of rendering a green decision %#',
    async (make) => {
      state.responses.push({ data: make(), error: null });
      await expect(DriftIncidentService.getGatePanel()).rejects.toThrow('could not be verified');
    }
  );

  it('returns only a verified operator balance readout and withholds durable identities', async () => {
    const entityId = '22222222-2222-4222-8222-222222222222';
    const ledgerRow = '33333333-3333-4333-8333-333333333333';
    const asOf = '2026-10-05T12:00:00.000Z';
    state.responses.push({
      data: {
        found: true,
        account_type: 'club',
        entity_id: entityId,
        as_of: asOf,
        balance: 1234.56,
        recorded_at: '2026-10-05T11:59:00Z',
        ledger_row: ledgerRow,
        side: 'to',
      },
      error: null,
    });

    const readout = await DriftIncidentService.getBalanceAsOf('club', entityId, asOf);
    expect(readout).toEqual({
      found: true,
      accountType: 'club',
      asOf,
      balance: 1234.56,
      recordedAt: '2026-10-05T11:59:00Z',
      direction: 'Incoming',
    });
    expect(readout).not.toHaveProperty('entity_id');
    expect(readout).not.toHaveProperty('ledger_row');
  });

  it('normalizes the verified no-balance state without exposing its raw note or entity ID', async () => {
    const entityId = '22222222-2222-4222-8222-222222222222';
    const asOf = '2026-10-05T12:00:00.000Z';
    state.responses.push({
      data: {
        found: false,
        account_type: 'player',
        entity_id: entityId,
        as_of: asOf,
        note: 'no ledger row with a recorded balance at or before this time',
      },
      error: null,
    });

    await expect(DriftIncidentService.getBalanceAsOf('player', entityId, asOf)).resolves.toEqual({
      found: false,
      accountType: 'player',
      asOf,
    });
  });

  it.each([
    {
      found: true,
      account_type: 'union',
      entity_id: '22222222-2222-4222-8222-222222222222',
      as_of: '2026-10-05T12:00:00.000Z',
      balance: 100,
      recorded_at: '2026-10-05T11:59:00Z',
      ledger_row: '33333333-3333-4333-8333-333333333333',
      side: 'to',
    },
    {
      found: true,
      account_type: 'club',
      entity_id: '22222222-2222-4222-8222-222222222222',
      as_of: '2026-10-05T12:00:00.000Z',
      balance: 100,
      recorded_at: '2026-10-05T12:01:00Z',
      ledger_row: '33333333-3333-4333-8333-333333333333',
      side: 'to',
    },
    {
      found: true,
      account_type: 'club',
      entity_id: '22222222-2222-4222-8222-222222222222',
      as_of: '2026-10-05T12:00:00.000Z',
      balance: 100,
      recorded_at: '2026-10-05T11:59:00Z',
      ledger_row: 'internal-row',
      side: 'to',
    },
    {
      found: true,
      account_type: 'club',
      entity_id: '22222222-2222-4222-8222-222222222222',
      as_of: '2026-10-05T12:00:00.000Z',
      balance: 100,
      recorded_at: '2026-10-05T11:59:00Z',
      ledger_row: '33333333-3333-4333-8333-333333333333',
      side: 'middle',
    },
  ])('rejects a malformed or cross-scope balance reconstruction %#', async (data) => {
    const entityId = '22222222-2222-4222-8222-222222222222';
    const asOf = '2026-10-05T12:00:00.000Z';
    state.responses.push({ data, error: null });
    await expect(DriftIncidentService.getBalanceAsOf('club', entityId, asOf)).rejects.toThrow(
      'could not be verified'
    );
  });

  it('refuses malformed balance inputs before querying the RPC', async () => {
    await expect(
      DriftIncidentService.getBalanceAsOf('treasury', 'not-an-id', 'not-a-time')
    ).rejects.toThrow('entity type is invalid');
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('refuses a malformed action success envelope', async () => {
    state.responses.push({ data: { ok: 'true' }, error: null });
    await expect(DriftIncidentService.acknowledge('incident')).rejects.toThrow(
      'could not be verified'
    );
  });
});
