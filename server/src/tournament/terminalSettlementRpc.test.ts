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
const PROPOSAL = { proposalId: '00000000-0000-4000-8000-000000000003', revision: 'a'.repeat(64) };
const proposalFields = { proposal_id: PROPOSAL.proposalId, revision: PROPOSAL.revision };

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
        .mockResolvedValueOnce({
          data: { stored: true, ...(mode === 'final_table_deal' ? proposalFields : {}) },
          error: null,
        });

      await expect(
        requestTournamentTerminalReceipt(TOURNAMENT_ID, mode, winnerId, {
          attempts: 2,
          wait: noWait,
          dealProposal: mode === 'final_table_deal' ? PROPOSAL : undefined,
        })
      ).resolves.toBe(RECEIPT);

      expect(mocks.rpc).toHaveBeenCalledTimes(2);
      expect(mocks.rpc.mock.calls[0]).toEqual(mocks.rpc.mock.calls[1]);
      expect(mocks.rpc).toHaveBeenCalledWith(
        mode === 'final_table_deal'
          ? 'fn_complete_tournament_terminal_proposal'
          : 'fn_complete_tournament_terminal',
        {
          p_tournament_id: TOURNAMENT_ID,
          p_observed_winner_id: winnerId,
          p_settlement_mode: mode,
          ...(mode === 'final_table_deal'
            ? { p_proposal_id: PROPOSAL.proposalId, p_revision: PROPOSAL.revision }
            : {}),
        }
      );
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
  it.each([
    undefined,
    { proposalId: 'old', revision: PROPOSAL.revision },
    { proposalId: PROPOSAL.proposalId, revision: 'not-a-revision' },
  ])(
    'refuses final-deal requests without an exact proposal before any RPC',
    async (dealProposal) => {
      await expect(
        requestTournamentTerminalReceipt(TOURNAMENT_ID, 'final_table_deal', null, {
          attempts: 1,
          wait: noWait,
          dealProposal,
        })
      ).rejects.toBeInstanceOf(TerminalSettlementRefusedError);
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  );

  it('uses the same proposal-bound resolver for a lost committed response', async () => {
    const outcome = resolvedOutcome('final_table_deal', true, 'COMPLETED');
    Object.assign(outcome.data, proposalFields, { receipt: { stored: true, ...proposalFields } });
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } })
      .mockResolvedValueOnce(outcome);
    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'final_table_deal', null, {
        attempts: 1,
        wait: noWait,
        dealProposal: PROPOSAL,
      })
    ).resolves.toBe(RECEIPT);
    expect(mocks.rpc).toHaveBeenLastCalledWith('fn_resolve_tournament_terminal_proposal_outcome', {
      p_tournament_id: TOURNAMENT_ID,
      p_observed_winner_id: null,
      p_settlement_mode: 'final_table_deal',
      p_proposal_id: PROPOSAL.proposalId,
      p_revision: PROPOSAL.revision,
    });
  });

  it.each(['proposal_id', 'revision'])(
    'does not accept a direct receipt with a different %s',
    async (key) => {
      mocks.rpc
        .mockResolvedValueOnce({
          data: { stored: true, ...proposalFields, [key]: 'different' },
          error: null,
        })
        .mockResolvedValueOnce({ data: null, error: { message: 'resolver unavailable' } });
      await expect(
        requestTournamentTerminalReceipt(TOURNAMENT_ID, 'final_table_deal', null, {
          attempts: 1,
          wait: noWait,
          dealProposal: PROPOSAL,
        })
      ).rejects.toBeInstanceOf(TerminalSettlementOutcomeUnknownError);
    }
  );

  it.each(['envelope', 'receipt'])(
    'keeps a mismatched committed %s outcome unknown',
    async (target) => {
      const outcome = resolvedOutcome('final_table_deal', true, 'COMPLETED');
      Object.assign(outcome.data, proposalFields, { receipt: { stored: true, ...proposalFields } });
      if (target === 'envelope') outcome.data.revision = 'b'.repeat(64);
      else (outcome.data.receipt as Record<string, unknown>).proposal_id = WINNER_ID;
      mocks.rpc
        .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } })
        .mockResolvedValueOnce(outcome);
      await expect(
        requestTournamentTerminalReceipt(TOURNAMENT_ID, 'final_table_deal', null, {
          attempts: 1,
          wait: noWait,
          dealProposal: PROPOSAL,
        })
      ).rejects.toBeInstanceOf(TerminalSettlementOutcomeUnknownError);
    }
  );

  it.each([true, false])(
    'requires proposal identity on a proved miss (matching=%s)',
    async (matching) => {
      const outcome = resolvedOutcome('final_table_deal', false, 'RUNNING');
      Object.assign(outcome.data, proposalFields, {
        revision: matching ? PROPOSAL.revision : 'b'.repeat(64),
      });
      mocks.rpc
        .mockResolvedValueOnce({ data: null, error: { message: 'proposal changed' } })
        .mockResolvedValueOnce(outcome);
      await expect(
        requestTournamentTerminalReceipt(TOURNAMENT_ID, 'final_table_deal', null, {
          attempts: 1,
          wait: noWait,
          dealProposal: PROPOSAL,
        })
      ).rejects.toBeInstanceOf(
        matching ? TerminalSettlementRefusedError : TerminalSettlementOutcomeUnknownError
      );
    }
  );

  it('keeps retry proposal identity immutable when caller options change during transport', async () => {
    const dealProposal = { ...PROPOSAL };
    mocks.rpc
      .mockImplementationOnce(async () => {
        dealProposal.revision = 'b'.repeat(64);
        return { data: null, error: { message: 'response lost' } };
      })
      .mockResolvedValueOnce({ data: { stored: true, ...proposalFields }, error: null });
    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'final_table_deal', null, {
        attempts: 2,
        wait: noWait,
        dealProposal,
      })
    ).resolves.toBe(RECEIPT);
    expect(mocks.rpc.mock.calls[0]).toEqual(mocks.rpc.mock.calls[1]);
    expect(mocks.rpc.mock.calls[1][1].p_revision).toBe(PROPOSAL.revision);
  });
});
