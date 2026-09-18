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
  isTerminalReplayDisagreement,
  requestTournamentTerminalReceipt,
  TerminalSettlementDisagreementError,
  TerminalSettlementOutcomeUnknownError,
  TerminalSettlementRefusedError,
} from './terminalSettlementRpc.js';

const TOURNAMENT_ID = '00000000-0000-4000-8000-000000000001';
const WINNER_ID = '00000000-0000-4000-8000-000000000002';
const RUNNER_UP_ID = '00000000-0000-4000-8000-000000000003';
const DISAGREE = {
  code: '40001',
  message: `terminal replay parameters disagree with stored receipt for ${TOURNAMENT_ID}`,
};

/** The engine's read of tournament_terminal_settlements, one row or none. */
function storedReceiptRow(row: Record<string, unknown> | null, error: unknown = null): void {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  mocks.from.mockReturnValue({ select });
}
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

/**
 * 2026-09-10 05:40-06:23 UTC: fn_complete_tournament_terminal raised 40001
 * 'terminal replay parameters disagree with stored receipt' 5,575 times across
 * three finished events (2,236 / 1,621 / 1,718), up to 100 a second, because
 * the engine replayed the refused parameters as if the response had been lost.
 * The receipt is the witness that was there: it is adopted, not argued with.
 */
describe('terminal replay disagreement is not retried forever', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockReturnValue(RECEIPT);
  });

  it('recognises only the database replay-disagreement refusal', () => {
    expect(isTerminalReplayDisagreement(DISAGREE)).toBe(true);
    expect(
      isTerminalReplayDisagreement({
        message: 'terminal outcome parameters disagree with stored receipt for x',
      })
    ).toBe(true);
    expect(isTerminalReplayDisagreement(new Error('deadlock detected'))).toBe(false);
    expect(
      isTerminalReplayDisagreement({ code: '40001', message: 'lost its terminal lifecycle claim' })
    ).toBe(false);
  });

  it('adopts the stored receipt instead of replaying the refused parameters', async () => {
    const stored = {
      tournamentId: TOURNAMENT_ID,
      winnerId: WINNER_ID,
      settlementMode: 'places',
    } as any;
    storedReceiptRow({ settlement_mode: 'places', winner_id: WINNER_ID });
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: DISAGREE })
      .mockResolvedValueOnce({ data: { stored: true }, error: null });
    mocks.verify.mockReturnValue(stored);

    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', RUNNER_UP_ID, {
        attempts: 5,
        wait: noWait,
      })
    ).resolves.toBe(stored);

    // One refused call, then exactly one replay carrying the receipt's own
    // parameters. Never a second identical attempt, never the resolver.
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls[0]).toEqual([
      'fn_complete_tournament_terminal',
      {
        p_tournament_id: TOURNAMENT_ID,
        p_observed_winner_id: RUNNER_UP_ID,
        p_settlement_mode: 'places',
      },
    ]);
    expect(mocks.rpc.mock.calls[1]).toEqual([
      'fn_complete_tournament_terminal',
      {
        p_tournament_id: TOURNAMENT_ID,
        p_observed_winner_id: WINNER_ID,
        p_settlement_mode: 'places',
      },
    ]);
    expect(mocks.verify).toHaveBeenLastCalledWith(
      { stored: true },
      TOURNAMENT_ID,
      'places',
      WINNER_ID
    );
  });

  it('adopts a final-table-deal receipt when a places finish is refused against it', async () => {
    storedReceiptRow({ settlement_mode: 'final_table_deal', winner_id: WINNER_ID });
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: DISAGREE })
      .mockResolvedValueOnce({ data: { stored: true }, error: null });

    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', WINNER_ID, { wait: noWait })
    ).resolves.toBe(RECEIPT);
    expect(mocks.rpc).toHaveBeenLastCalledWith('fn_complete_tournament_terminal', {
      p_tournament_id: TOURNAMENT_ID,
      p_observed_winner_id: WINNER_ID,
      p_settlement_mode: 'final_table_deal',
    });
  });

  it('stops after bounded receipt reads when the database refuses but shows no receipt', async () => {
    storedReceiptRow(null);
    mocks.rpc.mockResolvedValue({ data: null, error: DISAGREE });

    const failure = await requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', RUNNER_UP_ID, {
      attempts: 8,
      receiptReadAttempts: 3,
      wait: noWait,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TerminalSettlementDisagreementError);
    const disagreement = failure as TerminalSettlementDisagreementError;
    expect(disagreement.tournamentId).toBe(TOURNAMENT_ID);
    expect(disagreement.observed).toEqual({ settlementMode: 'places', winnerId: RUNNER_UP_ID });
    expect(disagreement.stored).toBeNull();
    expect(disagreement.message).toContain(TOURNAMENT_ID);
    expect(disagreement.message).toContain('no stored receipt row');
    // The refused request is sent once. The eight identical attempts the
    // caller allowed are not spent on a deterministic refusal.
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledTimes(3);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      'fn_resolve_tournament_terminal_outcome',
      expect.anything()
    );
  });

  it('stops with one disagreement when even the stored parameters are refused', async () => {
    storedReceiptRow({ settlement_mode: 'places', winner_id: WINNER_ID });
    mocks.rpc.mockResolvedValue({ data: null, error: DISAGREE });

    const failure = await requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', RUNNER_UP_ID, {
      receiptReadAttempts: 2,
      wait: noWait,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TerminalSettlementDisagreementError);
    expect((failure as TerminalSettlementDisagreementError).stored).toEqual({
      settlementMode: 'places',
      winnerId: WINNER_ID,
    });
    // 1 refused observation + 2 bounded replays with the stored parameters.
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });

  it('adopts the receipt when only the serialized resolver reports the disagreement', async () => {
    storedReceiptRow({ settlement_mode: 'places', winner_id: WINNER_ID });
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: '40001',
          message: `terminal outcome parameters disagree with stored receipt for ${TOURNAMENT_ID}`,
        },
      })
      .mockResolvedValueOnce({ data: { stored: true }, error: null });

    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', RUNNER_UP_ID, {
        attempts: 2,
        wait: noWait,
      })
    ).resolves.toBe(RECEIPT);
    expect(mocks.rpc).toHaveBeenCalledTimes(4);
    expect(mocks.rpc.mock.calls[3][1]).toEqual({
      p_tournament_id: TOURNAMENT_ID,
      p_observed_winner_id: WINNER_ID,
      p_settlement_mode: 'places',
    });
  });
});

describe('Legacy terminal admission requires explicit inactive authority', () => {
  const inactive = { data: { ok: false, reason: 'proposal_authority_not_active' }, error: null };
  const options = {
    legacyDealAuthority: 'proposal_authority_not_active' as const,
    attempts: 2,
    wait: noWait,
  };
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.verify.mockReturnValue(RECEIPT);
  });
  it('rechecks the live authority before sending the existing terminal contract', async () => {
    mocks.rpc
      .mockResolvedValueOnce(inactive)
      .mockResolvedValueOnce({ data: { stored: true }, error: null });
    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'final_table_deal', null, options)
    ).resolves.toBe(RECEIPT);
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      'fn_get_tournament_deal_consensus',
      'fn_complete_tournament_terminal',
    ]);
  });
  it.each([
    { data: { ok: true, ready: false }, error: null },
    { data: inactive.data, error: { message: 'timeout' } },
    { data: { ok: false, reason: 'review_stale' }, error: null },
    { data: null, error: null },
  ])('never sends legacy money on active, invalid or uncertain capability', async (result) => {
    mocks.rpc.mockResolvedValue(result);
    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'final_table_deal', null, options)
    ).rejects.toBeInstanceOf(TerminalSettlementRefusedError);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it('serializes the resolver after activation rejects an already-attempted legacy settlement', async () => {
    mocks.rpc
      .mockResolvedValueOnce(inactive)
      .mockResolvedValueOnce({
        data: null,
        error: { code: '23514', message: 'exact proposal required' },
      })
      .mockResolvedValueOnce({ data: { ok: true, ready: false }, error: null })
      .mockResolvedValueOnce(resolvedOutcome('final_table_deal', false, 'RUNNING'));
    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'final_table_deal', null, options)
    ).rejects.toBeInstanceOf(TerminalSettlementRefusedError);
    expect(
      mocks.rpc.mock.calls.filter(([name]) => name === 'fn_complete_tournament_terminal')
    ).toHaveLength(1);
    expect(mocks.rpc).toHaveBeenLastCalledWith('fn_resolve_tournament_terminal_outcome', {
      p_tournament_id: TOURNAMENT_ID,
      p_observed_winner_id: null,
      p_settlement_mode: 'final_table_deal',
    });
  });
  it('adopts a committed legacy receipt after a lost response and subsequent activation', async () => {
    mocks.rpc
      .mockResolvedValueOnce(inactive)
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } })
      .mockResolvedValueOnce({ data: { ok: true, ready: false }, error: null })
      .mockResolvedValueOnce(resolvedOutcome('final_table_deal', true, 'COMPLETED'));
    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'final_table_deal', null, options)
    ).resolves.toBe(RECEIPT);
  });
  it('never treats an unavailable post-activation resolver as a failed transaction', async () => {
    mocks.rpc
      .mockResolvedValueOnce(inactive)
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } })
      .mockResolvedValueOnce({ data: { ok: true, ready: false }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'resolver unavailable' } });
    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'final_table_deal', null, options)
    ).rejects.toBeInstanceOf(TerminalSettlementOutcomeUnknownError);
  });
  it('never accepts legacy opt-in together with an exact proposal', async () => {
    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'final_table_deal', null, {
        ...options,
        dealProposal: PROPOSAL,
      })
    ).rejects.toBeInstanceOf(TerminalSettlementRefusedError);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('deterministic settlement refusals retain serialized outcome ownership', () => {
  const refusal = {
    code: 'P0404',
    message: `tournament ${TOURNAMENT_ID} rake attribution incomplete: tournament_fee_sources_require_reconciliation`,
  };
  const writeName = 'fn_complete_tournament_terminal';
  const resolverName = 'fn_resolve_tournament_terminal_outcome';

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.verify.mockReturnValue(RECEIPT);
  });

  it.each([
    refusal,
    {
      code: 'P0404',
      message: `tournament ${TOURNAMENT_ID} has no complete durable elimination sequence (2/2 of 3)`,
    },
  ])(
    'resolves a known database refusal after one write without backoff: $message',
    async (error) => {
      const wait = vi.fn(async (_delayMs: number): Promise<void> => undefined);
      mocks.rpc.mockImplementation(async (name) =>
        name === writeName ? { data: null, error } : resolvedOutcome('places', false, 'RUNNING')
      );

      await expect(
        requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', WINNER_ID, { wait })
      ).rejects.toBeInstanceOf(TerminalSettlementRefusedError);
      expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([writeName, resolverName]);
      expect(mocks.rpc.mock.calls[1][1]).toEqual(mocks.rpc.mock.calls[0][1]);
      expect(wait).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['40001', refusal.message],
    ['40P01', 'deadlock detected'],
    ['55P03', 'canceling statement due to lock timeout'],
    ['57014', 'canceling statement due to statement timeout'],
    ['503', 'service unavailable'],
    [undefined, refusal.message],
    ['55000', 'tournament_fee_sources_require_reconciliation'],
    ['P0404', refusal.message.replace(TOURNAMENT_ID, WINNER_ID)],
    ['P0404', `${refusal.message} extra context`],
    ['P0404', `tournament ${TOURNAMENT_ID} rake attribution incomplete: new_unknown_reason`],
    ['P0404', `tournament ${TOURNAMENT_ID} has no complete durable elimination sequence (unknown)`],
  ])('keeps the existing retry budget for other/ambiguous errors: %s %s', async (code, message) => {
    const wait = vi.fn(async (_delayMs: number): Promise<void> => undefined);
    mocks.rpc.mockImplementation(async (name) =>
      name === writeName
        ? { data: null, error: { code, message } }
        : resolvedOutcome('places', false, 'RUNNING')
    );

    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', WINNER_ID, { wait })
    ).rejects.toBeInstanceOf(TerminalSettlementRefusedError);
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      writeName,
      writeName,
      writeName,
      writeName,
      writeName,
      resolverName,
    ]);
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([200, 400, 800, 1600]);
    const requests = mocks.rpc.mock.calls.slice(0, 5).map(([, request]) => request);
    expect(requests.every((request) => request === requests[0])).toBe(true);
  });

  it('does not classify a thrown transport error by its database-looking fields', async () => {
    const wait = vi.fn(async (_delayMs: number): Promise<void> => undefined);
    mocks.rpc.mockImplementation(async (name) => {
      if (name === writeName)
        throw Object.assign(new Error(refusal.message), { code: refusal.code });
      return resolvedOutcome('places', false, 'RUNNING');
    });
    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', WINNER_ID, { wait })
    ).rejects.toBeInstanceOf(TerminalSettlementRefusedError);
    expect(mocks.rpc.mock.calls.filter(([name]) => name === writeName)).toHaveLength(5);
    expect(wait).toHaveBeenCalledTimes(4);
  });

  it('keeps the caller pending until the serialized resolver owns a definitive outcome', async () => {
    const wait = vi.fn(async (_delayMs: number): Promise<void> => undefined);
    let resolveOutcome!: (value: ReturnType<typeof resolvedOutcome>) => void;
    const held = new Promise<ReturnType<typeof resolvedOutcome>>((resolve) => {
      resolveOutcome = resolve;
    });
    let resolverStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolverStarted = resolve;
    });
    mocks.rpc.mockImplementation(async (name) => {
      if (name === writeName) return { data: null, error: refusal };
      resolverStarted();
      return held;
    });
    let settled = false;
    const result = requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', WINNER_ID, {
      wait,
    }).then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        return error;
      }
    );
    await started;
    expect(settled).toBe(false);
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([writeName, resolverName]);
    resolveOutcome(resolvedOutcome('places', false, 'RUNNING'));
    expect(await result).toBeInstanceOf(TerminalSettlementRefusedError);
  });

  it.each(['committed', 'refused', 'unknown'] as const)(
    'resolves an earlier ambiguous write before treating the later refusal as %s',
    async (outcome) => {
      const wait = vi.fn(async (_delayMs: number): Promise<void> => undefined);
      let writes = 0;
      mocks.rpc.mockImplementation(async (name) => {
        if (name === writeName) {
          writes++;
          return {
            data: null,
            error: writes === 1 ? { message: 'response lost after commit' } : refusal,
          };
        }
        if (outcome === 'unknown')
          return { data: null, error: { message: 'resolver unavailable' } };
        return outcome === 'committed'
          ? resolvedOutcome('places', true, 'COMPLETED')
          : resolvedOutcome('places', false, 'RUNNING');
      });
      const result = requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', WINNER_ID, { wait });
      if (outcome === 'committed') await expect(result).resolves.toBe(RECEIPT);
      else
        await expect(result).rejects.toBeInstanceOf(
          outcome === 'refused'
            ? TerminalSettlementRefusedError
            : TerminalSettlementOutcomeUnknownError
        );
      expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
        writeName,
        writeName,
        resolverName,
      ]);
      expect(
        mocks.rpc.mock.calls.every(([, request]) => request === mocks.rpc.mock.calls[0][1])
      ).toBe(true);
      expect(wait.mock.calls.map(([ms]) => ms)).toEqual([200]);
    }
  );

  it('keeps a mismatched resolver identity unknown after the deterministic refusal', async () => {
    const wait = vi.fn(async (_delayMs: number): Promise<void> => undefined);
    const wrongIdentity = resolvedOutcome('places', false, 'RUNNING');
    wrongIdentity.data.tournament_id = WINNER_ID;
    mocks.rpc.mockImplementation(async (name) =>
      name === writeName ? { data: null, error: refusal } : wrongIdentity
    );
    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', WINNER_ID, { wait })
    ).rejects.toBeInstanceOf(TerminalSettlementOutcomeUnknownError);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(wait).not.toHaveBeenCalled();
  });

  it('keeps an unverified committed receipt unknown after a known refusal', async () => {
    const wait = vi.fn(async (_delayMs: number): Promise<void> => undefined);
    mocks.verify.mockReturnValue(null);
    mocks.rpc.mockImplementation(async (name) =>
      name === writeName
        ? { data: null, error: refusal }
        : resolvedOutcome('places', true, 'COMPLETED')
    );
    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', WINNER_ID, { wait })
    ).rejects.toBeInstanceOf(TerminalSettlementOutcomeUnknownError);
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(wait).not.toHaveBeenCalled();
  });

  it('reports the actual attempted write count when the resolver remains unknown', async () => {
    const wait = vi.fn(async (_delayMs: number): Promise<void> => undefined);
    mocks.rpc.mockImplementation(async (name) =>
      name === writeName
        ? { data: null, error: refusal }
        : { data: null, error: { message: 'resolver unavailable' } }
    );
    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', WINNER_ID, { wait })
    ).rejects.toThrow('unknown after 1 identical attempt(s)');
  });

  it.each([true, false])(
    'retains exact proposal identity at early resolution: %s',
    async (exact) => {
      const wait = vi.fn(async (_delayMs: number): Promise<void> => undefined);
      const outcome = resolvedOutcome('final_table_deal', false, 'RUNNING');
      Object.assign(outcome.data, proposalFields, {
        revision: exact ? PROPOSAL.revision : 'b'.repeat(64),
      });
      mocks.rpc.mockImplementation(async (name) =>
        name === 'fn_complete_tournament_terminal_proposal'
          ? { data: null, error: refusal }
          : outcome
      );
      await expect(
        requestTournamentTerminalReceipt(TOURNAMENT_ID, 'final_table_deal', null, {
          wait,
          dealProposal: PROPOSAL,
        })
      ).rejects.toBeInstanceOf(
        exact ? TerminalSettlementRefusedError : TerminalSettlementOutcomeUnknownError
      );
      expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
        'fn_complete_tournament_terminal_proposal',
        'fn_resolve_tournament_terminal_proposal_outcome',
      ]);
      expect(mocks.rpc.mock.calls[1][1]).toBe(mocks.rpc.mock.calls[0][1]);
      expect(mocks.rpc.mock.calls[1][1]).toMatchObject({
        p_tournament_id: TOURNAMENT_ID,
        p_observed_winner_id: null,
        p_settlement_mode: 'final_table_deal',
        p_proposal_id: PROPOSAL.proposalId,
        p_revision: PROPOSAL.revision,
      });
      expect(wait).not.toHaveBeenCalled();
    }
  );
});
