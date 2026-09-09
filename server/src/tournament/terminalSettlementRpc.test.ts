import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('../services/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
}));

vi.mock('./completionSettlementReceipt.js', () => ({
  verifyTournamentCompletionReceipt: mocks.verify,
}));

import {
  requestTournamentTerminalReceipt,
  TerminalSettlementOutcomeUnknownError,
  TerminalSettlementRefusedError,
} from './terminalSettlementRpc.js';

const TOURNAMENT_ID = '00000000-0000-4000-8000-000000000001';
const WINNER_ID = '00000000-0000-4000-8000-000000000002';
const RECEIPT = { tournamentId: TOURNAMENT_ID, winnerId: WINNER_ID } as any;
const noWait = async (): Promise<void> => undefined;

function resolvedOutcome(
  mode: 'places' | 'final_table_deal',
  committed: boolean,
  status: 'RUNNING' | 'COMPLETING' | 'COMPLETED'
): { data: Record<string, unknown>; error: null } {
  return {
    data: {
      ok: true,
      terminal_committed: committed,
      definitively_not_committed: !committed,
      status,
      mode,
      tournament_id: TOURNAMENT_ID,
      receipt: committed ? { stored: true } : null,
    },
    error: null,
  };
}

describe('terminal settlement response recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockReturnValue(RECEIPT);
  });

  it.each([
    ['places', WINNER_ID],
    ['final_table_deal', null],
  ] as const)(
    'replays the identical %s request after commit-then-transport-error',
    async (mode, winnerId) => {
      mocks.rpc
        .mockResolvedValueOnce({ data: null, error: { message: 'response lost after commit' } })
        .mockResolvedValueOnce({ data: { stored: true }, error: null });

      await expect(
        requestTournamentTerminalReceipt(TOURNAMENT_ID, mode, winnerId, {
          attempts: 2,
          wait: noWait,
        })
      ).resolves.toBe(RECEIPT);

      expect(mocks.rpc).toHaveBeenCalledTimes(2);
      expect(mocks.rpc.mock.calls[0]).toEqual(mocks.rpc.mock.calls[1]);
      expect(mocks.rpc).toHaveBeenCalledWith('fn_complete_tournament_terminal', {
        p_tournament_id: TOURNAMENT_ID,
        p_observed_winner_id: winnerId,
        p_settlement_mode: mode,
      });
      expect(mocks.rpc).not.toHaveBeenCalledWith(
        'fn_resolve_tournament_terminal_outcome',
        expect.anything()
      );
    }
  );

  it('releases only after the database proves the tournament is still RUNNING', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'transaction refused' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'transaction refused' } })
      .mockResolvedValueOnce(resolvedOutcome('places', false, 'RUNNING'));

    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', WINNER_ID, {
        attempts: 2,
        wait: noWait,
      })
    ).rejects.toBeInstanceOf(TerminalSettlementRefusedError);
  });

  it('keeps a completed or unreadable outcome fail-closed', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'response unavailable' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'response unavailable' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'resolver unavailable' } });

    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', WINNER_ID, {
        attempts: 2,
        wait: noWait,
      })
    ).rejects.toBeInstanceOf(TerminalSettlementOutcomeUnknownError);
  });

  it('waits behind an ambiguous call and consumes the resolver receipt after commit', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } })
      .mockResolvedValueOnce(resolvedOutcome('places', true, 'COMPLETED'));

    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', WINNER_ID, {
        attempts: 2,
        wait: noWait,
      })
    ).resolves.toBe(RECEIPT);
    expect(mocks.rpc).toHaveBeenLastCalledWith('fn_resolve_tournament_terminal_outcome', {
      p_tournament_id: TOURNAMENT_ID,
      p_observed_winner_id: WINNER_ID,
      p_settlement_mode: 'places',
    });
  });
});
