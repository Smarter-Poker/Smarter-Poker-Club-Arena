import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ direct: vi.fn(), rpc: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { rpc: mocks.rpc },
  DB_TIMEOUT_MS: 15_000,
}));
vi.mock('../services/lightningFoldSession.js', () => ({ lightningFoldSessionCall: mocks.direct }));
const { createSupabaseLightningHandBackend } = await import('./LightningHandBackend.js');
beforeEach(() => {
  mocks.direct.mockReset();
  mocks.rpc.mockReset();
});
const hand = '027ab7d1-b13c-4a9d-a7c3-4616f3d39e29';
const player = '121f80d2-5290-42e5-a32b-4d3a702e2772';
const request = 'b13cc1cf-8efc-4147-a262-cb2c640bf701';
describe('original Lightning fold backend transport selection', () => {
  it('uses the original HTTP call exactly once only when the lane proves no dispatch', async () => {
    mocks.direct.mockResolvedValue(null);
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    expect(
      await createSupabaseLightningHandBackend().fastFold(hand, player, request, 'normal', 1.235)
    ).toEqual({ ok: true, value: null });
    const args = {
      p_hand_id: hand,
      p_player_id: player,
      p_request_id: request,
      p_fold_type: 'normal',
      p_committed: 1.24,
    };
    expect(mocks.direct).toHaveBeenCalledTimes(1);
    expect(mocks.direct).toHaveBeenCalledWith(args);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_lightning_fast_fold', args);
  });
  it('never sends HTTP or permits host retry after a dispatched result becomes unknown', async () => {
    mocks.direct.mockResolvedValue({
      data: null,
      error: { message: 'lightning_fold_outcome_unknown', code: 'LIGHTNING_FOLD_UNKNOWN' },
    });
    expect(
      await createSupabaseLightningHandBackend().fastFold(hand, player, request, 'fast', 2.5)
    ).toEqual({
      ok: false,
      reason: 'lightning_fold_outcome_unknown',
      transport: true,
      retryable: false,
    });
    expect(mocks.direct).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { ok: true },
    { ok: false, reason: 'instance_not_dealing' },
    { ok: false, reason: 'conservation', frozen: true },
  ])('preserves the committed original domain result %j without HTTP replay', async (data) => {
    mocks.direct.mockResolvedValue({ data, error: null });
    const result = await createSupabaseLightningHandBackend().fastFold(
      hand,
      player,
      request,
      'fold_watch',
      0
    );
    if (data.ok) expect(result).toEqual({ ok: true, value: null });
    else
      expect(result).toMatchObject({
        ok: false,
        reason: data.reason,
        ...('frozen' in data ? { frozen: true } : {}),
      });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.direct).toHaveBeenCalledTimes(1);
  });
});
