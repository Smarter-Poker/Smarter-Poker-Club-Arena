/**
 * A PURCHASE MAY FAIL. IT MAY NEVER SAY IT SUCCEEDED WHEN IT DID NOT.
 *
 * `buyStreakFreeze` spends 5,000 diamonds. The RPC it calls did not exist in
 * the database, and the catch block recognised that BY NAME and returned
 * success anyway "for UX testing":
 *
 *     if (err.message?.includes('buy_streak_freeze')) {
 *       return { success: true };
 *     }
 *
 * So a player pressed Buy, was told it worked, was charged nothing and got
 * nothing — and their streak broke on the next missed day exactly as if they
 * had never bought protection. No error surfaced, no row was written, nothing
 * went red. Of the 200 RPCs this codebase calls it was the only one missing
 * from the live schema, and it was the one handling currency.
 *
 * The RPC now exists (migration 20260823_buy_streak_freeze). These pin the
 * client half: every refusal must be reported as a refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

const { dailyChallengeService } = await import('../src/services/DailyChallengeService');

const USER = '11111111-1111-4111-8111-111111111111';

beforeEach(() => rpc.mockReset());

describe('buyStreakFreeze', () => {
  it('reports success only when the RPC actually granted the freeze', async () => {
    rpc.mockResolvedValue({
      data: {
        success: true,
        alreadyPurchased: false,
        freezesAvailable: 2,
        diamondsSpent: 5000,
        diamondBalance: 45000,
      },
      error: null,
    });
    await expect(dailyChallengeService.buyStreakFreeze(USER)).resolves.toMatchObject({
      success: true,
      alreadyPurchased: false,
      freezesAvailable: 2,
      diamondBalance: 45000,
    });
    expect(rpc).toHaveBeenCalledWith('buy_streak_freeze', {
      p_user_id: USER,
      p_cost: 5000,
      p_request_id: expect.any(String),
    });
  });

  it('does NOT claim success when the RPC is missing — the original bug', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'function buy_streak_freeze does not exist' },
    });
    const out = await dailyChallengeService.buyStreakFreeze(USER);
    expect(out.success).toBe(false);
    expect(out.error).toBeTruthy();
  });

  it('reuses one request id across a transient retry', async () => {
    // PostgREST resolves fetch failures as an `{ error }` object. The service
    // must turn that into an Error so retryAsync recognizes it as transient.
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'network fetch failed' } })
      .mockResolvedValueOnce({
        data: {
          success: true,
          alreadyPurchased: true,
          freezesAvailable: 2,
          diamondsSpent: 0,
          diamondBalance: 45000,
        },
        error: null,
      });

    const out = await dailyChallengeService.buyStreakFreeze(USER);
    expect(out).toMatchObject({ success: true, alreadyPurchased: true });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1].p_request_id).toBe(rpc.mock.calls[1][1].p_request_id);
  });

  it('surfaces the cap refusal instead of swallowing it', async () => {
    // The RPC reports refusals in its PAYLOAD, not as a Postgres error, so a
    // client that only checks `error` would call this a successful purchase.
    rpc.mockResolvedValue({
      data: { success: false, error: 'You already hold the maximum of 3 streak freezes' },
      error: null,
    });
    const out = await dailyChallengeService.buyStreakFreeze(USER);
    expect(out.success).toBe(false);
    expect(out.error).toContain('maximum of 3');
  });

  it('surfaces "not enough diamonds" rather than confirming a free purchase', async () => {
    rpc.mockResolvedValue({ data: { success: false, error: 'not enough diamonds' }, error: null });
    const out = await dailyChallengeService.buyStreakFreeze(USER);
    expect(out.success).toBe(false);
    expect(out.error).toBe('not enough diamonds');
  });

  it('treats an empty payload as a failure, never as a silent success', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(dailyChallengeService.buyStreakFreeze(USER)).resolves.toMatchObject({
      success: false,
    });
  });
});
