import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: mocks }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { UnionOpsService, MIDWAY_UNION_ID } from '../../src/services/UnionOpsService';

const receipt = () => ({
  success: true,
  union_id: MIDWAY_UNION_ID,
  round2_club_to_agents: { amount: 123.45, shortfalls: 0 },
  round3_agents_to_players: { amount: 67.89, shortfalls: 0 },
});

beforeEach(() => vi.resetAllMocks());

describe('union settlement completion receipt', () => {
  it.each([
    'before_settlement_floor',
    'round1_failed: insufficient_funds',
    'round2_contract_violated_or_failed: unknown',
    'round3_contract_violated_or_failed: unknown',
    'recipient_shortfalls_remaining',
    'round4_invoices_failed: invoice_error',
  ])('refuses an HTTP-successful database refusal: %s', async (error) => {
    mocks.rpc.mockResolvedValue({ data: { ...receipt(), success: false, error }, error: null });
    await expect(UnionOpsService.runSettlementCascade(MIDWAY_UNION_ID)).rejects.toThrow(
      'Settlement did not complete'
    );
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    [],
    {},
    { ...receipt(), success: 'true' },
    { ...receipt(), union_id: 'another-union' },
  ])('does not certify an absent, malformed or wrong-union receipt', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(UnionOpsService.runSettlementCascade(MIDWAY_UNION_ID)).rejects.toThrow(
      'could not be verified'
    );
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it.each(['round2_club_to_agents', 'round3_agents_to_players'] as const)(
    'refuses missing, malformed or unpaid %s without inventing zero',
    async (key) => {
      for (const round of [
        undefined,
        null,
        [],
        {},
        { amount: null, shortfalls: 0 },
        { amount: '12.50', shortfalls: 0 },
        { amount: NaN, shortfalls: 0 },
        { amount: Infinity, shortfalls: 0 },
        { amount: Number.MAX_SAFE_INTEGER, shortfalls: 0 },
        { amount: -1, shortfalls: 0 },
        { amount: 1 },
        { amount: 1, shortfalls: null },
        { amount: 1, shortfalls: '0' },
        { amount: 1, shortfalls: 1 },
        { amount: 1, shortfalls: 0, success: false },
      ]) {
        mocks.rpc.mockResolvedValueOnce({ data: { ...receipt(), [key]: round }, error: null });
        await expect(UnionOpsService.runSettlementCascade(MIDWAY_UNION_ID)).rejects.toThrow(
          'could not be verified'
        );
      }
      expect(mocks.rpc).toHaveBeenCalledTimes(15);
    }
  );

  it('returns exact reported amounts after explicit matching completion', async () => {
    mocks.rpc.mockResolvedValue({ data: receipt(), error: null });
    await expect(UnionOpsService.runSettlementCascade(MIDWAY_UNION_ID)).resolves.toEqual(receipt());
    expect(mocks.rpc).toHaveBeenCalledWith('fn_union_settlement_cascade', {
      p_union_id: MIDWAY_UNION_ID,
      p_period_start: null,
      p_period_end: null,
    });
  });

  it('allows an explicitly completed zero-amount retry and preserves requested period', async () => {
    const data = {
      ...receipt(),
      union_id: 'requested-union',
      round2_club_to_agents: { amount: 0, shortfalls: 0 },
      round3_agents_to_players: { amount: 0, shortfalls: 0 },
    };
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(
      UnionOpsService.runSettlementCascade('requested-union', '2026-09-01', '2026-09-08')
    ).resolves.toEqual(data);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_union_settlement_cascade', {
      p_union_id: 'requested-union',
      p_period_start: '2026-09-01',
      p_period_end: '2026-09-08',
    });
  });

  it('preserves transport failure and never retries an uncertain mutation', async () => {
    const error = new Error('connection lost');
    mocks.rpc.mockResolvedValue({ data: receipt(), error });
    await expect(UnionOpsService.runSettlementCascade(MIDWAY_UNION_ID)).rejects.toBe(error);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});

/* These methods used to default a missing union id to MIDWAY_UNION_ID, so a
   surface that had not resolved its union read, swept or settled one hardcoded
   union instead. A missing id is now refused before the database is asked. */
describe('a union-scoped call names its union', () => {
  const calls: Array<[string, (id: unknown) => Promise<unknown>]> = [
    ['runSettlementCascade', (id) => UnionOpsService.runSettlementCascade(id as string)],
    ['getSettlementPreview', (id) => UnionOpsService.getSettlementPreview(id as string)],
    ['runIntegritySweep', (id) => UnionOpsService.runIntegritySweep(id as string)],
    ['getCoverageStrict', (id) => UnionOpsService.getCoverageStrict(id as string)],
    ['getCoverage', (id) => UnionOpsService.getCoverage(id as string)],
    ['getAgentRisk', (id) => UnionOpsService.getAgentRisk(id as string)],
    ['getAllAgentStatements', (id) => UnionOpsService.getAllAgentStatements(id as string)],
    ['getDistributionCheck', (id) => UnionOpsService.getDistributionCheck(id as string)],
    ['getSettlementRounds', (id) => UnionOpsService.getSettlementRounds(id as string)],
  ];

  it.each(calls)('%s refuses a missing union id without asking the database', async (_, call) => {
    for (const id of [undefined, null, '', '   ']) {
      await expect(call(id)).rejects.toThrow('No Union Selected');
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
