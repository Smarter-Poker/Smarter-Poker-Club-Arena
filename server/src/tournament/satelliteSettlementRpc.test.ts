import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('../services/supabase.js', () => ({
  supabase: { rpc: mocks.rpc },
}));

vi.mock('./satelliteSettlementReceipt.js', () => ({
  verifySatelliteSettlementReceipt: mocks.verify,
}));

import {
  requestSatelliteSettlementReceipt,
  SatelliteSettlementOutcomeUnknownError,
  SatelliteSettlementRefusedError,
} from './satelliteSettlementRpc.js';

const TOURNAMENT_ID = '00000000-0000-4000-8000-000000000001';
const WINNER_ID = '00000000-0000-4000-8000-000000000002';
const RECEIPT = { tournamentId: TOURNAMENT_ID, winnerId: WINNER_ID } as any;
const noWait = async (): Promise<void> => undefined;

function resolvedOutcome(
  committed: boolean,
  status: 'RUNNING' | 'COMPLETING' | 'COMPLETED'
): { data: Record<string, unknown>; error: null } {
  return {
    data: {
      ok: true,
      satellite_committed: committed,
      definitively_not_committed: !committed,
      status,
      tournament_id: TOURNAMENT_ID,
      winner_id: WINNER_ID,
      receipt: committed ? { stored: true } : null,
    },
    error: null,
  };
}

describe('satellite settlement response recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockReturnValue(RECEIPT);
  });

  it('replays the identical request after commit then transport failure', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost after commit' } })
      .mockResolvedValueOnce({ data: { stored: true }, error: null });

    await expect(
      requestSatelliteSettlementReceipt(TOURNAMENT_ID, WINNER_ID, {
        attempts: 2,
        wait: noWait,
      })
    ).resolves.toBe(RECEIPT);

    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls[0]).toEqual(mocks.rpc.mock.calls[1]);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_settle_satellite_tournament', {
      p_tournament_id: TOURNAMENT_ID,
      p_observed_winner_id: WINNER_ID,
    });
  });

  it('returns refusal only after the serialized resolver proves no receipt', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'transaction refused' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'transaction refused' } })
      .mockResolvedValueOnce(resolvedOutcome(false, 'RUNNING'));

    await expect(
      requestSatelliteSettlementReceipt(TOURNAMENT_ID, WINNER_ID, {
        attempts: 2,
        wait: noWait,
      })
    ).rejects.toBeInstanceOf(SatelliteSettlementRefusedError);
  });

  it('consumes the serialized receipt after an ambiguous call commits', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } })
      .mockResolvedValueOnce(resolvedOutcome(true, 'COMPLETED'));

    await expect(
      requestSatelliteSettlementReceipt(TOURNAMENT_ID, WINNER_ID, {
        attempts: 2,
        wait: noWait,
      })
    ).resolves.toBe(RECEIPT);
    expect(mocks.rpc).toHaveBeenLastCalledWith('fn_resolve_satellite_settlement_outcome', {
      p_tournament_id: TOURNAMENT_ID,
      p_observed_winner_id: WINNER_ID,
    });
  });

  it('keeps an unreadable resolver outcome fail closed', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'response unavailable' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'response unavailable' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'resolver unavailable' } });

    await expect(
      requestSatelliteSettlementReceipt(TOURNAMENT_ID, WINNER_ID, {
        attempts: 2,
        wait: noWait,
      })
    ).rejects.toBeInstanceOf(SatelliteSettlementOutcomeUnknownError);
  });

  it('rejects a resolver response for a different winner identity', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'response unavailable' } })
      .mockResolvedValueOnce({
        data: { ...resolvedOutcome(true, 'COMPLETED').data, winner_id: TOURNAMENT_ID },
        error: null,
      });

    await expect(
      requestSatelliteSettlementReceipt(TOURNAMENT_ID, WINNER_ID, {
        attempts: 1,
        wait: noWait,
      })
    ).rejects.toBeInstanceOf(SatelliteSettlementOutcomeUnknownError);
  });
});
