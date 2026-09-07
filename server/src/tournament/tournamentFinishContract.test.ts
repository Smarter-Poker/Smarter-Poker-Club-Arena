import { describe, expect, it, vi } from 'vitest';
import {
  CERTIFY_TOURNAMENT_FINISH_RPC,
  CLAIM_TOURNAMENT_FINISH_RPC,
  certifyTournamentFinish,
  claimTournamentFinish,
  type TournamentFinishRpcClient,
} from './tournamentFinishContract.js';

const TOURNAMENT = '11111111-1111-4111-8111-111111111111';
const WINNER = '22222222-2222-4222-8222-222222222222';
const noDelay = { retryDelayMs: () => 0 };

function client(
  responses: Array<{ data: unknown; error: { message: string; code?: string } | null }>
): TournamentFinishRpcClient & { rpc: ReturnType<typeof vi.fn> } {
  return {
    rpc: vi.fn(async () => responses.shift() ?? { data: null, error: { message: 'empty' } }),
  };
}

describe('the canonical winner is persisted at the claim boundary', () => {
  it('accepts only an exact COMPLETING claim receipt', async () => {
    const c = client([
      {
        error: null,
        data: {
          ok: true,
          winner_user_id: WINNER,
          finish_kind: 'normal',
          status: 'COMPLETING',
        },
      },
    ]);
    const result = await claimTournamentFinish(c, TOURNAMENT, WINNER, 'test', noDelay);
    expect(result.ok).toBe(true);
    expect(result.winnerUserId).toBe(WINNER);
    expect(c.rpc).toHaveBeenCalledWith(CLAIM_TOURNAMENT_FINISH_RPC, {
      p_tournament_id: TOURNAMENT,
      p_winner_user_id: WINNER,
      p_source: 'test',
    });
  });

  it('retries an unanswered idempotent claim but never retries a database refusal', async () => {
    const ambiguous = client([
      { data: null, error: { message: 'socket closed after request' } },
      {
        error: null,
        data: { ok: true, winner_user_id: WINNER, finish_kind: 'normal', status: 'COMPLETING' },
      },
    ]);
    expect((await claimTournamentFinish(ambiguous, TOURNAMENT, WINNER, 'test', noDelay)).ok).toBe(
      true
    );
    expect(ambiguous.rpc).toHaveBeenCalledTimes(2);

    const refused = client([
      { error: null, data: { ok: false, reason: 'canonical_winner_conflict' } },
      { error: null, data: { ok: true } },
    ]);
    const result = await claimTournamentFinish(refused, TOURNAMENT, WINNER, 'test', noDelay);
    expect(result).toMatchObject({ ok: false, reason: 'canonical_winner_conflict' });
    expect(refused.rpc).toHaveBeenCalledTimes(1);
  });
});

describe('COMPLETED is an exact database certificate', () => {
  it('accepts the matching certificate written by the atomic domain transaction', async () => {
    const c = client([
      {
        error: null,
        data: {
          ok: true,
          certified: true,
          winner_user_id: WINNER,
          finish_kind: 'normal',
          status: 'COMPLETED',
          rows_updated: 0,
          already_completed: true,
        },
      },
    ]);
    const result = await certifyTournamentFinish(c, TOURNAMENT, WINNER, 'test', noDelay);
    expect(result).toMatchObject({
      ok: true,
      certified: true,
      rowsUpdated: 0,
      alreadyCompleted: true,
    });
    expect(c.rpc).toHaveBeenCalledWith(CERTIFY_TOURNAMENT_FINISH_RPC, {
      p_tournament_id: TOURNAMENT,
      p_winner_user_id: WINNER,
      p_source: 'test',
    });
  });

  it('rejects a legacy response claiming that the certificate RPC changed status', async () => {
    const c = client([
      {
        error: null,
        data: {
          ok: true,
          certified: true,
          winner_user_id: WINNER,
          finish_kind: 'normal',
          status: 'COMPLETED',
          rows_updated: 1,
        },
      },
    ]);
    await expect(
      certifyTournamentFinish(c, TOURNAMENT, WINNER, 'test', noDelay)
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_completion_certificate' });
  });

  it('never treats an unproved zero-row CAS as success', async () => {
    const c = client([
      {
        error: null,
        data: {
          ok: true,
          certified: true,
          winner_user_id: WINNER,
          status: 'COMPLETED',
          rows_updated: 0,
        },
      },
    ]);
    await expect(
      certifyTournamentFinish(c, TOURNAMENT, WINNER, 'test', noDelay)
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_completion_certificate' });
  });

  it('accepts zero rows only as an exact persisted-certificate replay', async () => {
    const c = client([
      {
        error: null,
        data: {
          ok: true,
          certified: true,
          winner_user_id: WINNER,
          finish_kind: 'final_table_deal',
          status: 'COMPLETED',
          rows_updated: 0,
          already_completed: true,
        },
      },
    ]);
    await expect(
      certifyTournamentFinish(c, TOURNAMENT, WINNER, 'test', noDelay)
    ).resolves.toMatchObject({ ok: true, alreadyCompleted: true, rowsUpdated: 0 });
  });

  it('returns a semantic certification refusal immediately', async () => {
    const c = client([
      {
        error: null,
        data: { ok: false, certified: false, reason: 'rake_not_settled', status: 'COMPLETING' },
      },
      { error: null, data: { ok: true } },
    ]);
    await expect(
      certifyTournamentFinish(c, TOURNAMENT, WINNER, 'test', noDelay)
    ).resolves.toMatchObject({ ok: false, reason: 'rake_not_settled', status: 'COMPLETING' });
    expect(c.rpc).toHaveBeenCalledTimes(1);
  });

  it('retries only transport ambiguity and leaves a durable refusal on exhaustion', async () => {
    const c = client([
      { data: null, error: { message: 'gateway timeout' } },
      { data: null, error: { message: 'connection reset' } },
      { data: null, error: { message: 'database unavailable' } },
    ]);
    await expect(
      certifyTournamentFinish(c, TOURNAMENT, WINNER, 'test', noDelay)
    ).resolves.toMatchObject({
      ok: false,
      reason: 'transport',
      transportError: 'database unavailable',
    });
    expect(c.rpc).toHaveBeenCalledTimes(3);
  });
});
