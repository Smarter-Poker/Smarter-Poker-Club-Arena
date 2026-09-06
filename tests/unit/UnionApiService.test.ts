import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession } },
}));

import { unionApi } from '../../src/services/UnionApiService';

const OP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('UnionApiService idempotency identity', () => {
  beforeEach(() => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'test-token' } } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        json: () => Promise.resolve({ success: true }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('forwards a caller-owned key on a union bank send', async () => {
    await unionApi.sendToClub('union-id', 'club-id', 250, 'note', OP_ID);

    expect(fetch).toHaveBeenCalledWith(
      '/api/club-arena/union-wallet',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Idempotency-Key': OP_ID }),
      })
    );
  });

  it('forwards the same caller-owned key on a promo wallet send', async () => {
    await unionApi.promoSend('union-id', 500, 'club', 'club-id', 'note', OP_ID);

    expect(fetch).toHaveBeenCalledWith(
      '/api/club-arena/union-wallet',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Idempotency-Key': OP_ID }),
      })
    );
  });

  it('distinguishes a definitive refusal from an ambiguous server failure', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        status: 422,
        json: () => Promise.resolve({ success: false, error: 'Insufficient balance' }),
      } as Response)
      .mockResolvedValueOnce({
        status: 503,
        json: () => Promise.resolve({ success: false, error: 'Service unavailable' }),
      } as Response);

    await expect(
      unionApi.sendToClub('union-id', 'club-id', 250, 'note', OP_ID)
    ).rejects.toMatchObject({ definitive: true, status: 422 });
    await expect(
      unionApi.sendToClub('union-id', 'club-id', 250, 'note', OP_ID)
    ).rejects.toMatchObject({ definitive: false, status: 503 });
  });

  it.each([408, 409, 425, 429])(
    'keeps the operation key recoverable for ambiguous HTTP %s responses',
    async (status) => {
      vi.mocked(fetch).mockResolvedValueOnce({
        status,
        json: () => Promise.resolve({ success: false, error: 'Retry later' }),
      } as Response);

      await expect(
        unionApi.sendToClub('union-id', 'club-id', 250, 'note', OP_ID)
      ).rejects.toMatchObject({ definitive: false, status });
    }
  );
});
