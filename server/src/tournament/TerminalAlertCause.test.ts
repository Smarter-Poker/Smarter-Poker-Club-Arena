import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  terminal: vi.fn(),
  rpc: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { rpc: fixture.rpc },
  maintenanceSupabase: { rpc: fixture.rpc },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: fixture.reportError }));
vi.mock('../maintenance/freezeState.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../maintenance/freezeState.js')>()),
  isMaintenanceFrozen: () => false,
}));
vi.mock('./terminalSettlementRpc.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./terminalSettlementRpc.js')>()),
  requestTournamentTerminalReceipt: fixture.terminal,
}));

const { TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js');
const { TerminalSettlementRefusedError, TerminalSettlementOutcomeUnknownError } =
  await import('./terminalSettlementRpc.js');
const TOURNAMENT = '808ef798-0942-4ce0-9ae1-eeefaaf4b0a9';
const WINNER = '66417bd4-c8e5-4666-af6f-3d85a43593d9';
const REFUSAL = `tournament ${TOURNAMENT} has no complete durable elimination sequence (1/1 of 2)`;

function manager() {
  return Object.assign(Object.create(TournamentManagerEliminations.prototype), {
    tournamentId: TOURNAMENT,
    tournamentCache: { variant: 'plo4', tournament_type: 'SPIN' },
    tournamentFinished: false,
    requestUrgentEliminationSweepAfter: vi.fn(),
    fenceUnknownTerminalOutcome: vi.fn(),
  });
}

describe('terminal exceptions survive the durable financial alert boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.rpc.mockResolvedValue({ data: '00000000-0000-4000-8000-000000000001', error: null });
  });

  it.each([
    ['refused', (): Error => new TerminalSettlementRefusedError(REFUSAL), true],
    [
      'outcome_unknown',
      (): Error => new TerminalSettlementOutcomeUnknownError('serialized outcome read failed'),
      false,
    ],
    ['outcome_unknown', (): Error => new Error('transport unavailable'), false],
    ['outcome_unknown', (): string => 'transport rejected with a string', false],
  ] as const)(
    'persists the actual %s cause and preserves its certainty',
    async (suffix, create, refused) => {
      const failure = create();
      fixture.terminal.mockRejectedValueOnce(failure);
      const owner = manager();
      await owner.finishTournament(WINNER);
      expect(fixture.rpc).toHaveBeenCalledOnce();
      expect(fixture.rpc).toHaveBeenCalledWith(
        'fn_raise_server_financial_alert',
        expect.objectContaining({
          p_source: `Tournament.atomic_finish_${suffix}`,
          p_context: expect.objectContaining({
            tournament_id: TOURNAMENT,
            winner_id: WINNER,
            error: failure instanceof Error ? failure.message : failure,
            error_name: failure instanceof Error ? failure.name : 'string',
            proven_refusal: refused,
            outcome_unknown: !refused,
          }),
        })
      );
      expect(owner.tournamentFinished).toBe(!refused);
      expect(owner.requestUrgentEliminationSweepAfter).toHaveBeenCalledTimes(refused ? 1 : 0);
      expect(owner.fenceUnknownTerminalOutcome).toHaveBeenCalledTimes(refused ? 0 : 1);
    }
  );

  it('awaits the original durable alert request before releasing the refusal guard', async () => {
    let acknowledge!: (value: unknown) => void;
    fixture.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        })
    );
    fixture.terminal.mockRejectedValueOnce(new TerminalSettlementRefusedError(REFUSAL));
    const owner = manager();
    const finish = owner.finishTournament(WINNER);
    await vi.waitFor(() => expect(fixture.rpc).toHaveBeenCalledOnce());
    expect(owner.tournamentFinished).toBe(true);
    expect(owner.requestUrgentEliminationSweepAfter).not.toHaveBeenCalled();
    acknowledge({ data: '00000000-0000-4000-8000-000000000001', error: null });
    await finish;
    expect(owner.tournamentFinished).toBe(false);
    expect(owner.requestUrgentEliminationSweepAfter).toHaveBeenCalledOnce();
  });

  it('retains unknown outcome fencing if the alert database request fails', async () => {
    fixture.terminal.mockRejectedValueOnce(
      new TerminalSettlementOutcomeUnknownError('receipt timeout')
    );
    fixture.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'alert storage unavailable' },
    });
    const owner = manager();
    await owner.finishTournament(WINNER);
    expect(owner.tournamentFinished).toBe(true);
    expect(owner.requestUrgentEliminationSweepAfter).not.toHaveBeenCalled();
    expect(owner.fenceUnknownTerminalOutcome).toHaveBeenCalledOnce();
    expect(fixture.reportError).toHaveBeenCalledWith(
      { message: 'alert storage unavailable' },
      'financialAlerts.rpc_failed.Tournament.atomic_finish_outcome_unknown',
      expect.any(Object)
    );
  });
});
