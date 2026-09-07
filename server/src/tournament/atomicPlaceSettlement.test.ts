import { describe, expect, it, vi } from 'vitest';

import {
  PREPARE_TOURNAMENT_PLACES_RPC,
  SETTLE_TOURNAMENT_PLACES_RPC,
  settleTournamentPlacesAtomically,
  type AtomicPlaceSettlementClient,
} from './atomicPlaceSettlement.js';

type RpcAnswer = { data?: unknown; error?: { message: string; code?: string } | null } | Error;

const TOURNAMENT_ID = '11111111-2222-3333-4444-555555555555';
const SOURCE = 'engine.finishTournament';
const NO_DELAY = { retryDelayMs: () => 0 };

function client(answers: RpcAnswer[]) {
  const rpc = vi.fn(async () => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('test RPC script was exhausted');
    return { data: next.data ?? null, error: next.error ?? null };
  });
  return { rpc } as unknown as AtomicPlaceSettlementClient & {
    rpc: ReturnType<typeof vi.fn>;
  };
}

describe('atomic tournament place settlement client', () => {
  it('accepts settlement success only with an explicit COMPLETED receipt', async () => {
    const c = client([
      { data: { ok: true, places: 2 } },
      { data: { ok: true, paid: 75, places: 2, completed: false } },
    ]);

    const result = await settleTournamentPlacesAtomically(c, TOURNAMENT_ID, SOURCE, NO_DELAY);

    expect(result).toMatchObject({
      ok: false,
      completed: false,
      reason: 'completion_not_proven',
      retryable: false,
    });
    expect(c.rpc).toHaveBeenCalledTimes(2);
  });

  it('prepares the durable obligations before asking the database to settle them', async () => {
    const c = client([
      { data: { ok: true, places: 3, amount_owed: 100 } },
      { data: { ok: true, paid: 100, places: 3, completed: true } },
    ]);

    const result = await settleTournamentPlacesAtomically(c, TOURNAMENT_ID, SOURCE, NO_DELAY);

    expect(result).toMatchObject({
      ok: true,
      paid: 100,
      places: 3,
      completed: true,
      retryable: false,
    });
    expect(c.rpc.mock.calls).toEqual([
      [PREPARE_TOURNAMENT_PLACES_RPC, { p_tournament_id: TOURNAMENT_ID, p_source: SOURCE }],
      [SETTLE_TOURNAMENT_PLACES_RPC, { p_tournament_id: TOURNAMENT_ID, p_source: SOURCE }],
    ]);
  });

  it('does not attempt settlement when preparation is refused', async () => {
    const c = client([
      {
        data: {
          ok: false,
          reason: 'recorded_prizes_do_not_equal_pool',
          detail: '99.99 recorded against a 100.00 pool',
          retryable: false,
        },
      },
    ]);

    const result = await settleTournamentPlacesAtomically(c, TOURNAMENT_ID, SOURCE, NO_DELAY);

    expect(result).toMatchObject({
      ok: false,
      reason: 'recorded_prizes_do_not_equal_pool',
      retryable: false,
    });
    expect(c.rpc).toHaveBeenCalledTimes(1);
    expect(c.rpc).toHaveBeenCalledWith(PREPARE_TOURNAMENT_PLACES_RPC, {
      p_tournament_id: TOURNAMENT_ID,
      p_source: SOURCE,
    });
    expect(c.rpc).not.toHaveBeenCalledWith(SETTLE_TOURNAMENT_PLACES_RPC, expect.anything());
  });

  it('retries a retryable prepare before moving on to settlement', async () => {
    const c = client([
      { data: { ok: false, reason: 'lock_busy', retryable: true } },
      { data: { ok: true, places: 2 } },
      { data: { ok: true, paid: 75, places: 2, completed: true } },
    ]);

    const result = await settleTournamentPlacesAtomically(c, TOURNAMENT_ID, SOURCE, NO_DELAY);

    expect(result).toMatchObject({ ok: true, paid: 75, completed: true });
    expect(c.rpc.mock.calls.map(([rpc]) => rpc)).toEqual([
      PREPARE_TOURNAMENT_PLACES_RPC,
      PREPARE_TOURNAMENT_PLACES_RPC,
      SETTLE_TOURNAMENT_PLACES_RPC,
    ]);
  });

  it('retries a retryable settlement without preparing a second time', async () => {
    const c = client([
      { data: { ok: true, places: 2 } },
      { data: { ok: false, reason: 'atomic_settlement_aborted', retryable: true } },
      { data: { ok: true, paid: 75, places: 2, completed: true } },
    ]);

    const result = await settleTournamentPlacesAtomically(c, TOURNAMENT_ID, SOURCE, NO_DELAY);

    expect(result).toMatchObject({ ok: true, paid: 75, completed: true });
    expect(c.rpc.mock.calls.map(([rpc]) => rpc)).toEqual([
      PREPARE_TOURNAMENT_PLACES_RPC,
      SETTLE_TOURNAMENT_PLACES_RPC,
      SETTLE_TOURNAMENT_PLACES_RPC,
    ]);
  });

  it('returns a nonretryable settlement refusal after one attempt', async () => {
    const c = client([
      { data: { ok: true, places: 2 } },
      {
        data: {
          ok: false,
          reason: 'obligations_not_prepared_exactly',
          retryable: false,
        },
      },
    ]);

    const result = await settleTournamentPlacesAtomically(c, TOURNAMENT_ID, SOURCE, NO_DELAY);

    expect(result).toMatchObject({
      ok: false,
      reason: 'obligations_not_prepared_exactly',
      retryable: false,
    });
    expect(c.rpc.mock.calls.map(([rpc]) => rpc)).toEqual([
      PREPARE_TOURNAMENT_PLACES_RPC,
      SETTLE_TOURNAMENT_PLACES_RPC,
    ]);
  });

  it('replays settlement after a lost response and accepts the already-completed receipt', async () => {
    const c = client([
      { data: { ok: true, places: 3 } },
      { error: { message: 'connection closed after commit' } },
      {
        data: JSON.stringify({
          ok: true,
          paid: 0,
          places: 3,
          already_completed: true,
          retryable: false,
        }),
      },
    ]);

    const result = await settleTournamentPlacesAtomically(c, TOURNAMENT_ID, SOURCE, NO_DELAY);

    expect(result).toMatchObject({
      ok: true,
      paid: 0,
      places: 3,
      completed: true,
      retryable: false,
    });
    expect(c.rpc.mock.calls.map(([rpc]) => rpc)).toEqual([
      PREPARE_TOURNAMENT_PLACES_RPC,
      SETTLE_TOURNAMENT_PLACES_RPC,
      SETTLE_TOURNAMENT_PLACES_RPC,
    ]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'uses the bounded production retry count for an invalid maxAttempts override (%s)',
    async (maxAttempts) => {
      const c = client([
        { data: { ok: false, reason: 'lock_busy', retryable: true } },
        { data: { ok: false, reason: 'lock_busy', retryable: true } },
        { data: { ok: false, reason: 'lock_busy', retryable: true } },
      ]);

      const result = await settleTournamentPlacesAtomically(c, TOURNAMENT_ID, SOURCE, {
        maxAttempts,
        retryDelayMs: () => 0,
      });

      expect(result).toMatchObject({ ok: false, reason: 'lock_busy' });
      expect(c.rpc).toHaveBeenCalledTimes(3);
    }
  );
});
