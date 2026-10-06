import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: mocks }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { UnionOpsService } from '../../src/services/UnionOpsService';

// Any union: the service has no default union and no hardcoded one.
const UNION_ID = '22222222-2222-4222-8222-222222222222';
const CLUB_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = '44444444-4444-4444-8444-444444444444';

const preview = () => ({
  union_id: UNION_ID,
  period_start: '2026-09-07',
  period_end: '2026-09-14',
  round1: { already_executed: true, rake_treasury_available: 100 },
  round2: { payees: 1, amount: 10, clubs_short: 0, short_by: 0, detail: [] },
  round3: { payees: 1, amount: 5, agents_short: 0, short_by: 0, detail: [] },
  total_to_move: 15,
  has_blockers: false,
});

const distribution = () => ({
  period_start: '2026-09-07T07:00:00+00:00',
  rake_collected: 100,
  agent_commissions: 60,
  player_rakeback: 20,
  total_distributed: 80,
  over_distributed_by: 0,
  healthy: true,
  note: 'Server-owned explanation',
});

const lawStatus = () => ({
  available: true,
  healthy: true,
  breaches: [] as Array<Record<string, unknown>>,
  warnings: [] as Array<Record<string, unknown>>,
  run_status: 'succeeded',
  started_at: '2026-10-05T06:00:00+00:00',
  checked_at: '2026-10-05T06:01:00+00:00',
});

const riskRow = () => ({
  agent_user_id: AGENT_ID,
  agent_name: 'River Captain',
  club_name: 'Shark Club',
  role: 'super_agent',
  players: 3,
  seated_now: 1,
  rake_generated: 12.34,
  player_net: -4.5,
  commission_accrued: 2.25,
  credit_extended: 10.01,
});

const settlementRound = () => ({
  round_no: 2,
  round_name: 'club_to_agents',
  payees: 3,
  amount: 12.34,
  shortfalls: 0,
  executed_at: '2026-10-05T06:01:00+00:00',
  detail: { status: 'complete' },
});

const coverage = () => ({
  require_agent_for_players: true,
  players_total: 4,
  players_with_agent: 3,
  players_without_agent: 1,
  player_coverage_pct: 75,
  super_agents: 1,
  agents: 2,
  sub_agents: 1,
  agents_under_a_super_agent: 1,
  agents_orphaned: 1,
  sub_agents_under_an_agent: 1,
  sub_agents_orphaned: 0,
  agents_that_have_sub_agents: 1,
  commission_rates_out_of_policy: 0,
  player_rakeback_deals: 2,
  player_rakeback_gap_breaches: 1,
  policy_band: { min: 0.2, max: 0.7 },
});

function mockSettlementRoundRead(data: unknown, error: unknown = null) {
  const limit = vi.fn().mockResolvedValue({ data, error });
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit,
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);
  mocks.from.mockReturnValue(chain);
  return { chain, limit };
}

beforeEach(() => vi.resetAllMocks());

describe('union settlement preview receipt', () => {
  it('refuses a preview for a different union', async () => {
    mocks.rpc.mockResolvedValue({ data: { union_id: 'another-union' }, error: null });
    await expect(UnionOpsService.getSettlementPreview(UNION_ID)).rejects.toThrow(
      'Could Not Be Verified For The Selected Union'
    );
  });

  it.each([
    null,
    { ...preview(), period_start: undefined },
    { ...preview(), period_start: '' },
    { ...preview(), period_start: '2026-02-30' },
    { ...preview(), period_start: 'not-a-period' },
    { ...preview(), period_end: '2026-09-07' },
    { ...preview(), period_end: '2026-09-01' },
    { ...preview(), round1: null },
    { ...preview(), round1: { already_executed: 'true', rake_treasury_available: 100 } },
    { ...preview(), round1: { already_executed: true, rake_treasury_available: -1 } },
    { ...preview(), round2: { ...preview().round2, payees: 1.5 } },
    { ...preview(), round2: { ...preview().round2, amount: Number.NaN } },
    { ...preview(), round2: { ...preview().round2, clubs_short: -1 } },
    { ...preview(), round2: { ...preview().round2, short_by: Number.POSITIVE_INFINITY } },
    { ...preview(), round2: { ...preview().round2, detail: null } },
    { ...preview(), round2: { ...preview().round2, detail: [null] } },
    {
      ...preview(),
      round2: {
        ...preview().round2,
        clubs_short: 1,
        detail: [{ club_id: CLUB_ID, club: '   ', owed: 4, treasury: 1, short_by: 3 }],
      },
      has_blockers: true,
    },
    {
      ...preview(),
      round2: {
        ...preview().round2,
        clubs_short: 1,
        short_by: 3,
        detail: [{ club_id: CLUB_ID, owed: 4, treasury: 1, short_by: 3 }],
      },
      has_blockers: true,
    },
    {
      ...preview(),
      round2: {
        ...preview().round2,
        clubs_short: 1,
        detail: [{ club_id: CLUB_ID, club: null, owed: '4', treasury: 1, short_by: 3 }],
      },
      has_blockers: true,
    },
    {
      ...preview(),
      round2: {
        ...preview().round2,
        clubs_short: 1,
        detail: [{ club_id: CLUB_ID, club: null, owed: 4, treasury: -1, short_by: 3 }],
      },
      has_blockers: true,
    },
    {
      ...preview(),
      round2: {
        ...preview().round2,
        clubs_short: 1,
        detail: [{ club_id: CLUB_ID, club: null, owed: 4, treasury: 1, short_by: Number.NaN }],
      },
      has_blockers: true,
    },
    {
      ...preview(),
      round2: {
        ...preview().round2,
        clubs_short: 1,
        short_by: 3,
        detail: [{ club: null, owed: 4, treasury: 1, short_by: 3 }],
      },
      has_blockers: true,
    },
    {
      ...preview(),
      round2: {
        ...preview().round2,
        clubs_short: 1,
        short_by: 3,
        detail: [{ club_id: 'not-a-uuid', club: null, owed: 4, treasury: 1, short_by: 3 }],
      },
      has_blockers: true,
    },
    {
      ...preview(),
      round2: { ...preview().round2, clubs_short: 1, detail: [] },
      has_blockers: true,
    },
    {
      ...preview(),
      round2: {
        ...preview().round2,
        clubs_short: 1,
        short_by: 2,
        detail: [{ club_id: CLUB_ID, club: null, owed: 4, treasury: 1, short_by: 2 }],
      },
      has_blockers: true,
    },
    {
      ...preview(),
      round2: {
        ...preview().round2,
        clubs_short: 1,
        short_by: 2,
        detail: [{ club_id: CLUB_ID, club: null, owed: 4, treasury: 1, short_by: 3 }],
      },
      has_blockers: true,
    },
    { ...preview(), round3: { ...preview().round3, payees: '1' } },
    { ...preview(), round3: { ...preview().round3, amount: -1 } },
    { ...preview(), round3: { ...preview().round3, agents_short: 0.5 } },
    { ...preview(), round3: { ...preview().round3, short_by: -1 } },
    { ...preview(), round3: { ...preview().round3, detail: {} } },
    { ...preview(), round3: { ...preview().round3, detail: [null] } },
    {
      ...preview(),
      round3: {
        ...preview().round3,
        agents_short: 1,
        detail: [
          {
            agent_user_id: AGENT_ID,
            club_id: CLUB_ID,
            agent: '   ',
            owed: 4,
            agent_balance: 1,
            short_by: 3,
          },
        ],
      },
      has_blockers: true,
    },
    {
      ...preview(),
      round3: {
        ...preview().round3,
        agents_short: 1,
        short_by: 3,
        detail: [
          {
            agent_user_id: AGENT_ID,
            club_id: CLUB_ID,
            owed: 4,
            agent_balance: 1,
            short_by: 3,
          },
        ],
      },
      has_blockers: true,
    },
    {
      ...preview(),
      round3: {
        ...preview().round3,
        agents_short: 1,
        detail: [
          {
            agent_user_id: AGENT_ID,
            club_id: CLUB_ID,
            agent: null,
            owed: 4,
            agent_balance: Number.POSITIVE_INFINITY,
            short_by: 3,
          },
        ],
      },
      has_blockers: true,
    },
    {
      ...preview(),
      round3: {
        ...preview().round3,
        agents_short: 1,
        detail: [
          {
            agent_user_id: AGENT_ID,
            club_id: CLUB_ID,
            agent: null,
            owed: 4,
            agent_balance: 1,
            short_by: -1,
          },
        ],
      },
      has_blockers: true,
    },
    {
      ...preview(),
      round3: {
        ...preview().round3,
        agents_short: 1,
        short_by: 3,
        detail: [{ agent: null, club_id: CLUB_ID, owed: 4, agent_balance: 1, short_by: 3 }],
      },
      has_blockers: true,
    },
    {
      ...preview(),
      round3: {
        ...preview().round3,
        agents_short: 1,
        short_by: 3,
        detail: [
          {
            agent_user_id: AGENT_ID,
            club_id: 'not-a-uuid',
            agent: null,
            owed: 4,
            agent_balance: 1,
            short_by: 3,
          },
        ],
      },
      has_blockers: true,
    },
    {
      ...preview(),
      round3: { ...preview().round3, agents_short: 1, detail: [] },
      has_blockers: true,
    },
    {
      ...preview(),
      round3: {
        ...preview().round3,
        agents_short: 1,
        short_by: 2,
        detail: [
          {
            agent_user_id: AGENT_ID,
            club_id: CLUB_ID,
            agent: null,
            owed: 5,
            agent_balance: 3,
            short_by: 1,
          },
        ],
      },
      has_blockers: true,
    },
    { ...preview(), total_to_move: Number.NaN },
    { ...preview(), total_to_move: -1 },
    { ...preview(), total_to_move: 14.99 },
    { ...preview(), has_blockers: 'false' },
    { ...preview(), has_blockers: true },
  ])('refuses a malformed same-union settlement preview', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(UnionOpsService.getSettlementPreview(UNION_ID)).rejects.toThrow(
      'Could Not Be Verified For The Selected Union And Period'
    );
  });

  it('preserves an exact verified timestamp period and complete nested preview', async () => {
    const data = {
      ...preview(),
      period_start: '2026-09-07T07:00:00+00:00',
      period_end: '2026-09-14T07:00:00+00:00',
      round2: {
        ...preview().round2,
        clubs_short: 1,
        short_by: 3,
        detail: [{ club_id: CLUB_ID, club: null, owed: 4, treasury: 1, short_by: 3 }],
      },
      round3: {
        ...preview().round3,
        agents_short: 1,
        short_by: 2,
        detail: [
          {
            agent_user_id: AGENT_ID,
            club_id: CLUB_ID,
            agent: 'Agent One',
            owed: 5,
            agent_balance: 3,
            short_by: 2,
          },
        ],
      },
      has_blockers: true,
    };
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(UnionOpsService.getSettlementPreview(UNION_ID)).resolves.toEqual(data);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_union_settlement_preview', {
      p_union_id: UNION_ID,
      p_period_start: null,
      p_period_end: null,
    });
  });
});

describe('union integrity sweep receipt', () => {
  it.each([
    null,
    [],
    {},
    { union_id: 'another-union', window_hours: 24, signals: 0 },
    { union_id: UNION_ID, window_hours: 12, signals: 0 },
    { union_id: UNION_ID, window_hours: 24, signals: -1 },
    { union_id: UNION_ID, window_hours: 24, signals: 1.5 },
    { union_id: UNION_ID, window_hours: 24, signals: '0' },
    { union_id: UNION_ID, window_hours: 24, signals: Number.NaN },
  ])('refuses an absent, wrong-scope or malformed sweep receipt', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(UnionOpsService.runIntegritySweep(UNION_ID, 24)).rejects.toThrow(
      'Could Not Be Verified'
    );
  });

  it('returns only a matching nonnegative-integer sweep receipt', async () => {
    const data = { union_id: UNION_ID, window_hours: 24, signals: 3 };
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(UnionOpsService.runIntegritySweep(UNION_ID, 24)).resolves.toEqual(data);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_union_integrity_sweep', {
      p_union_id: UNION_ID,
      p_hours: 24,
    });
  });
});

describe('union distribution verdict boundary', () => {
  it('returns only a finite, arithmetically coherent distribution verdict', async () => {
    const data = distribution();
    mocks.rpc.mockResolvedValue({ data, error: null });

    await expect(UnionOpsService.getDistributionCheck(UNION_ID)).resolves.toEqual({
      period_start: data.period_start,
      rake_collected: 100,
      agent_commissions: 60,
      player_rakeback: 20,
      total_distributed: 80,
      over_distributed_by: 0,
      healthy: true,
    });
  });

  it('allows the one-cent skew created by independently rounded components', async () => {
    const data = {
      ...distribution(),
      agent_commissions: 0.01,
      player_rakeback: 0.01,
      total_distributed: 0.01,
    };
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(UnionOpsService.getDistributionCheck(UNION_ID)).resolves.toMatchObject({
      agent_commissions: 0.01,
      player_rakeback: 0.01,
      total_distributed: 0.01,
      healthy: true,
    });
  });

  it.each([
    null,
    [],
    { ...distribution(), period_start: 'not-a-time' },
    { ...distribution(), rake_collected: Number.NaN },
    { ...distribution(), agent_commissions: '60' },
    { ...distribution(), player_rakeback: Number.POSITIVE_INFINITY },
    { ...distribution(), total_distributed: 79 },
    { ...distribution(), over_distributed_by: -1 },
    { ...distribution(), over_distributed_by: 1 },
    { ...distribution(), healthy: 'true' },
    { ...distribution(), healthy: false },
    {
      ...distribution(),
      rake_collected: 50,
      total_distributed: 80,
      over_distributed_by: 30,
      healthy: true,
    },
  ])('rejects malformed or internally contradictory distribution truth %#', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(UnionOpsService.getDistributionCheck(UNION_ID)).rejects.toThrow(
      'Union Distribution Reading Could Not Be Verified'
    );
  });

  it('binds an explicit distribution window before asking the database', async () => {
    await expect(UnionOpsService.getDistributionCheck(UNION_ID, 'not-a-time')).rejects.toThrow(
      'Union Distribution Window Could Not Be Verified'
    );
    expect(mocks.rpc).not.toHaveBeenCalled();

    mocks.rpc.mockResolvedValue({ data: distribution(), error: null });
    await expect(
      UnionOpsService.getDistributionCheck(UNION_ID, '2026-09-08T07:00:00+00:00')
    ).rejects.toThrow('Union Distribution Reading Could Not Be Verified');
  });
});

describe('persisted union-law verdict boundary', () => {
  it('accepts a current healthy run while preserving actionable warnings', async () => {
    const data = {
      ...lawStatus(),
      warnings: [{ check: 'players_without_agent', count: 12 }],
    };
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(UnionOpsService.getLawSelfTest()).resolves.toEqual(data);
  });

  it('accepts only an explicit unavailable state as unavailable', async () => {
    const data = {
      available: false,
      healthy: false,
      breaches: [],
      warnings: [],
      run_status: 'pending',
      started_at: null,
      checked_at: null,
      note: 'The Scheduled Union Law Audit Has Not Run Yet.',
    };
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(UnionOpsService.getLawSelfTest()).resolves.toEqual(data);
  });

  it.each([
    null,
    [],
    { ...lawStatus(), available: 'true' },
    { ...lawStatus(), healthy: 'true' },
    { ...lawStatus(), breaches: {} },
    { ...lawStatus(), warnings: [null] },
    { ...lawStatus(), breaches: [{}] },
    { ...lawStatus(), healthy: true, breaches: [{ check: 'ledger_gap', count: 1 }] },
    { ...lawStatus(), healthy: false, breaches: [] },
    { ...lawStatus(), run_status: 'failed' },
    { ...lawStatus(), started_at: 'not-a-time' },
    {
      ...lawStatus(),
      started_at: '2026-10-05T06:02:00+00:00',
      checked_at: '2026-10-05T06:01:00+00:00',
    },
    {
      ...lawStatus(),
      available: false,
      healthy: true,
      run_status: 'pending',
      note: 'Pending',
    },
    {
      ...lawStatus(),
      available: false,
      healthy: false,
      run_status: 'pending',
      note: 'Pending',
      warnings: [{ check: 'stale_warning' }],
    },
    {
      ...lawStatus(),
      available: false,
      healthy: false,
      run_status: 'succeeded',
      note: 'Pending',
    },
  ])('rejects malformed or internally contradictory law status %#', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(UnionOpsService.getLawSelfTest()).rejects.toThrow(
      'Union Law Audit Status Could Not Be Verified'
    );
  });
});

describe('authorized union option list', () => {
  const OTHER_UNION = '33333333-3333-4333-8333-333333333333';

  it.each([
    null,
    {},
    [null],
    [{ union_id: null, union_name: 'Midway Union' }],
    [{ union_id: 'not-a-uuid', union_name: 'Midway Union' }],
    [{ union_id: UNION_ID, union_name: null }],
    [{ union_id: UNION_ID, union_name: '' }],
    [{ union_id: UNION_ID, union_name: '   ' }],
    [
      { union_id: UNION_ID, union_name: 'Midway Union' },
      { union_id: UNION_ID, union_name: 'Midway Union Again' },
    ],
  ])('rejects a null, malformed or duplicate authorized list', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(UnionOpsService.getOverseerUnionOptions()).rejects.toThrow(
      'Authorized Union List Could Not Be Verified'
    );
  });

  it('returns the exact server-authorized order and shape', async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        { union_id: OTHER_UNION, union_name: 'Alpha Union' },
        { union_id: UNION_ID, union_name: 'Midway Union' },
      ],
      error: null,
    });
    await expect(UnionOpsService.getOverseerUnionOptions()).resolves.toEqual([
      { id: OTHER_UNION, name: 'Alpha Union' },
      { id: UNION_ID, name: 'Midway Union' },
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_union_overseer_options');
  });

  it('preserves an authorization/list transport failure instead of returning empty', async () => {
    const error = { code: '42501', message: 'permission denied' };
    mocks.rpc.mockResolvedValue({ data: null, error });
    await expect(UnionOpsService.getOverseerUnionOptions()).rejects.toBe(error);
  });
});

describe('union operations reads fail closed on malformed success payloads', () => {
  it('preserves a structurally and arithmetically verified hierarchy coverage result', async () => {
    const data = coverage();
    mocks.rpc.mockResolvedValue({ data, error: null });

    await expect(UnionOpsService.getCoverageStrict(UNION_ID)).resolves.toEqual(data);
  });

  it('accepts the producer contract for an empty union as one hundred percent coverage', async () => {
    const data = {
      ...coverage(),
      players_total: 0,
      players_with_agent: 0,
      players_without_agent: 0,
      player_coverage_pct: 100,
      player_rakeback_deals: 0,
      player_rakeback_gap_breaches: 0,
    };
    mocks.rpc.mockResolvedValue({ data, error: null });

    await expect(UnionOpsService.getCoverageStrict(UNION_ID)).resolves.toEqual(data);
  });

  it.each([
    null,
    [],
    { ...coverage(), require_agent_for_players: 'true' },
    { ...coverage(), players_total: Number.NaN },
    { ...coverage(), players_with_agent: Number.POSITIVE_INFINITY },
    { ...coverage(), players_without_agent: 2 },
    { ...coverage(), player_coverage_pct: 74.9 },
    { ...coverage(), agents_under_a_super_agent: 3 },
    { ...coverage(), agents_orphaned: 0 },
    { ...coverage(), sub_agents_orphaned: 1 },
    { ...coverage(), agents_that_have_sub_agents: 3 },
    { ...coverage(), commission_rates_out_of_policy: 5 },
    { ...coverage(), player_rakeback_deals: 4 },
    { ...coverage(), player_rakeback_gap_breaches: 3 },
    { ...coverage(), policy_band: { min: Number.NEGATIVE_INFINITY, max: 0.7 } },
    { ...coverage(), policy_band: { min: 0.8, max: 0.7 } },
    { ...coverage(), policy_band: { min: 0.2, max: 1.1 } },
  ])('rejects malformed or contradictory hierarchy coverage truth %#', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });

    await expect(UnionOpsService.getCoverageStrict(UNION_ID)).rejects.toThrow(
      'Union Hierarchy Coverage Could Not Be Verified'
    );
  });

  it.each([
    null,
    {},
    [null],
    [{ ...riskRow(), rake_generated: '12.34' }],
    [{ ...riskRow(), commission_accrued: Number.NaN }],
    [{ ...riskRow(), players: '3' }],
  ])(
    'rejects an unverifiable agent-risk payload %# instead of showing no activity',
    async (data) => {
      mocks.rpc.mockResolvedValue({ data, error: null });

      await expect(UnionOpsService.getAgentRisk(UNION_ID)).rejects.toThrow(
        'Union Agent Risk Reading Could Not Be Verified'
      );
    }
  );

  it('preserves verified signed risk money without coercion', async () => {
    const row = riskRow();
    mocks.rpc.mockResolvedValue({ data: [row], error: null });

    await expect(UnionOpsService.getAgentRisk(UNION_ID)).resolves.toEqual([row]);
  });

  it.each([
    null,
    {},
    [null],
    [{ ...settlementRound(), amount: '12.34' }],
    [{ ...settlementRound(), amount: Number.NaN }],
    [{ ...settlementRound(), executed_at: 'not-a-time' }],
  ])('rejects unverifiable settlement-round rows %# instead of showing no runs', async (data) => {
    mockSettlementRoundRead(data);

    await expect(UnionOpsService.getSettlementRounds(UNION_ID)).rejects.toThrow(
      'Settlement Round Records Could Not Be Verified'
    );
  });

  it('preserves a verified settlement amount without converting or rounding it', async () => {
    const row = settlementRound();
    mockSettlementRoundRead([row]);

    await expect(UnionOpsService.getSettlementRounds(UNION_ID)).resolves.toEqual([row]);
  });
});

/* These methods used to default a missing union id to Midway's, so a
   surface that had not resolved its union read or swept one hardcoded
   union instead. A missing id is now refused before the database is asked. */
describe('a union-scoped call names its union', () => {
  const calls: Array<[string, (id: unknown) => Promise<unknown>]> = [
    ['getSettlementPreview', (id) => UnionOpsService.getSettlementPreview(id as string)],
    ['runIntegritySweep', (id) => UnionOpsService.runIntegritySweep(id as string)],
    ['getCoverageStrict', (id) => UnionOpsService.getCoverageStrict(id as string)],
    ['getCoverage', (id) => UnionOpsService.getCoverage(id as string)],
    ['getAgentRisk', (id) => UnionOpsService.getAgentRisk(id as string)],
    ['getAllAgentStatements', (id) => UnionOpsService.getAllAgentStatements(id as string)],
    ['getDistributionCheck', (id) => UnionOpsService.getDistributionCheck(id as string)],
    ['getSettlementRounds', (id) => UnionOpsService.getSettlementRounds(id as string)],
    ['getClubExitBlockers', (id) => UnionOpsService.getClubExitBlockers(id as string, 'club-1')],
    ['expelClub', (id) => UnionOpsService.expelClub(id as string, 'club-1')],
  ];

  it.each(calls)('%s refuses a missing union id without asking the database', async (_, call) => {
    for (const id of [undefined, null, '', '   ']) {
      await expect(call(id)).rejects.toThrow('No Union Selected');
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('union oversight reads preserve database failure', () => {
  const timeout = { code: '57014', message: 'canceling statement due to statement timeout' };

  it.each([
    ['getAgentRisk', () => UnionOpsService.getAgentRisk(UNION_ID)],
    ['getDistributionCheck', () => UnionOpsService.getDistributionCheck(UNION_ID)],
    ['getLawSelfTest', () => UnionOpsService.getLawSelfTest()],
  ])('%s never turns a statement timeout into empty success', async (_, read) => {
    mocks.rpc.mockResolvedValue({ data: null, error: timeout });
    await expect(read()).rejects.toBe(timeout);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('getSettlementRounds never turns a table timeout into empty success', async () => {
    mockSettlementRoundRead(null, timeout);

    await expect(UnionOpsService.getSettlementRounds(UNION_ID)).rejects.toBe(timeout);
    expect(mocks.from).toHaveBeenCalledWith('union_settlement_rounds');
  });

  it('reads the persisted law status instead of executing the global self-test', async () => {
    const status = lawStatus();
    mocks.rpc.mockResolvedValue({ data: status, error: null });
    await expect(UnionOpsService.getLawSelfTest()).resolves.toEqual(status);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_union_law_selftest_status');
    expect(mocks.rpc).not.toHaveBeenCalledWith('fn_union_law_selftest');
  });
});
