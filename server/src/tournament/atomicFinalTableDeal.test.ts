import { describe, expect, it, vi } from 'vitest';
import {
  SETTLE_FINAL_TABLE_DEAL_ATOMIC_RPC,
  settleFinalTableDealAtomically,
} from './atomicFinalTableDeal.js';

const tournamentId = '00000000-0000-4000-8000-000000000001';

describe('settleFinalTableDealAtomically', () => {
  it('accepts only an ok response that also proves COMPLETED', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ok: true, completed: false, retryable: false },
      error: null,
    });

    const result = await settleFinalTableDealAtomically({ rpc }, tournamentId, {
      retryDelayMs: () => 0,
    });

    expect(result.ok).toBe(false);
    expect(result.completed).toBe(false);
    expect(result.reason).toBe('completion_not_proven');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('replays safely after a lost commit response', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'gateway timeout' } })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          completed: true,
          already_completed: true,
          paid: 0,
          players: 2,
          deal_table_id: '00000000-0000-4000-8000-000000000099',
          bubble_contract_required: true,
          chip_leader: '00000000-0000-4000-8000-000000000011',
          payouts: [
            {
              user_id: '00000000-0000-4000-8000-000000000011',
              amount: 60,
              rank: 1,
            },
          ],
        },
        error: null,
      });

    const result = await settleFinalTableDealAtomically({ rpc }, tournamentId, {
      retryDelayMs: () => 0,
    });

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, SETTLE_FINAL_TABLE_DEAL_ATOMIC_RPC, {
      p_tournament_id: tournamentId,
    });
    expect(result).toMatchObject({
      ok: true,
      completed: true,
      already_completed: true,
      paid: 0,
      players: 2,
      deal_table_id: '00000000-0000-4000-8000-000000000099',
      bubble_contract_required: true,
    });
    expect(result.payouts).toHaveLength(1);
  });

  it('never retries a durable refusal', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        ok: false,
        completed: false,
        reason: 'earned_place_evidence_conflicts_with_plan',
        retryable: false,
      },
      error: null,
    });

    const result = await settleFinalTableDealAtomically({ rpc }, tournamentId, {
      retryDelayMs: () => 0,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe('earned_place_evidence_conflicts_with_plan');
  });

  it('bounds retries for retryable PostgreSQL conflicts', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        ok: false,
        completed: false,
        reason: 'atomic_deal_aborted',
        retryable: true,
      },
      error: null,
    });

    const result = await settleFinalTableDealAtomically({ rpc }, tournamentId, {
      maxAttempts: 3,
      retryDelayMs: () => 0,
    });

    expect(rpc).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
  });

  it('parses string RPC payloads and filters malformed payout rows', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: JSON.stringify({
        ok: true,
        completed: true,
        chip_leader: '00000000-0000-4000-8000-000000000011',
        payouts: [
          {
            user_id: '00000000-0000-4000-8000-000000000011',
            amount: '60.25',
            rank: 1,
          },
          { user_id: '', amount: 20, rank: 2 },
        ],
      }),
      error: null,
    });

    const result = await settleFinalTableDealAtomically({ rpc }, tournamentId);

    expect(result.payouts).toEqual([
      {
        user_id: '00000000-0000-4000-8000-000000000011',
        amount: 60.25,
        rank: 1,
      },
    ]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'uses the bounded production retry count for an invalid maxAttempts override (%s)',
    async (maxAttempts) => {
      const rpc = vi.fn().mockResolvedValue({
        data: {
          ok: false,
          completed: false,
          reason: 'atomic_deal_aborted',
          retryable: true,
        },
        error: null,
      });

      const result = await settleFinalTableDealAtomically({ rpc }, tournamentId, {
        maxAttempts,
        retryDelayMs: () => 0,
      });

      expect(result).toMatchObject({ ok: false, reason: 'atomic_deal_aborted' });
      expect(rpc).toHaveBeenCalledTimes(3);
    }
  );
});
