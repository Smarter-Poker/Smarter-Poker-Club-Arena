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

describe('deterministic settlement refusals retain serialized outcome ownership', () => {
  const refusal = {
    code: 'P0404',
    message: `tournament ${TOURNAMENT_ID} rake attribution incomplete: tournament_fee_sources_require_reconciliation`,
  };
  const writeName = 'fn_settle_satellite_tournament';
  const resolverName = 'fn_resolve_satellite_settlement_outcome';

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.verify.mockReturnValue(RECEIPT);
  });

  it.each([
    refusal,
    {
      code: 'P0404',
      message: `satellite ${TOURNAMENT_ID} has no complete durable elimination sequence (2/2 of 3)`,
    },
  ])(
    'resolves a known database refusal after one write without backoff: $message',
    async (error) => {
      const wait = vi.fn(async (_delayMs: number): Promise<void> => undefined);
      mocks.rpc.mockImplementation(async (name) =>
        name === writeName ? { data: null, error } : resolvedOutcome(false, 'RUNNING')
      );

      await expect(
        requestSatelliteSettlementReceipt(TOURNAMENT_ID, WINNER_ID, { wait })
      ).rejects.toBeInstanceOf(SatelliteSettlementRefusedError);
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
    ['P0404', `satellite ${TOURNAMENT_ID} has no complete durable elimination sequence (unknown)`],
  ])('keeps the existing retry budget for other/ambiguous errors: %s %s', async (code, message) => {
    const wait = vi.fn(async (_delayMs: number): Promise<void> => undefined);
    mocks.rpc.mockImplementation(async (name) =>
      name === writeName
        ? { data: null, error: { code, message } }
        : resolvedOutcome(false, 'RUNNING')
    );

    await expect(
      requestSatelliteSettlementReceipt(TOURNAMENT_ID, WINNER_ID, { wait })
    ).rejects.toBeInstanceOf(SatelliteSettlementRefusedError);
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
      return resolvedOutcome(false, 'RUNNING');
    });
    await expect(
      requestSatelliteSettlementReceipt(TOURNAMENT_ID, WINNER_ID, { wait })
    ).rejects.toBeInstanceOf(SatelliteSettlementRefusedError);
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
    const result = requestSatelliteSettlementReceipt(TOURNAMENT_ID, WINNER_ID, { wait }).then(
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
    resolveOutcome(resolvedOutcome(false, 'RUNNING'));
    expect(await result).toBeInstanceOf(SatelliteSettlementRefusedError);
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
          ? resolvedOutcome(true, 'COMPLETED')
          : resolvedOutcome(false, 'RUNNING');
      });
      const result = requestSatelliteSettlementReceipt(TOURNAMENT_ID, WINNER_ID, { wait });
      if (outcome === 'committed') await expect(result).resolves.toBe(RECEIPT);
      else
        await expect(result).rejects.toBeInstanceOf(
          outcome === 'refused'
            ? SatelliteSettlementRefusedError
            : SatelliteSettlementOutcomeUnknownError
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
    const wrongIdentity = resolvedOutcome(false, 'RUNNING');
    wrongIdentity.data.tournament_id = WINNER_ID;
    mocks.rpc.mockImplementation(async (name) =>
      name === writeName ? { data: null, error: refusal } : wrongIdentity
    );
    await expect(
      requestSatelliteSettlementReceipt(TOURNAMENT_ID, WINNER_ID, { wait })
    ).rejects.toBeInstanceOf(SatelliteSettlementOutcomeUnknownError);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(wait).not.toHaveBeenCalled();
  });

  it('keeps an unverified committed receipt unknown after a known refusal', async () => {
    const wait = vi.fn(async (_delayMs: number): Promise<void> => undefined);
    mocks.verify.mockReturnValue(null);
    mocks.rpc.mockImplementation(async (name) =>
      name === writeName ? { data: null, error: refusal } : resolvedOutcome(true, 'COMPLETED')
    );
    await expect(
      requestSatelliteSettlementReceipt(TOURNAMENT_ID, WINNER_ID, { wait })
    ).rejects.toBeInstanceOf(SatelliteSettlementOutcomeUnknownError);
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
      requestSatelliteSettlementReceipt(TOURNAMENT_ID, WINNER_ID, { wait })
    ).rejects.toThrow('unknown after 1 identical attempt(s)');
  });
});
