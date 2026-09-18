import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: { getSession: getSessionMock },
  },
}));

import { callClubArenaApi } from '../../src/services/clubArenaApi';

describe('Club Arena API response boundary', () => {
  beforeEach(() => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'test-token' } },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('rejects a success-shaped body delivered with a non-success HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ success: true, purchaseId: 'not-authoritative' }),
      })
    );

    await expect(
      callClubArenaApi('marketplace-purchase', {}, { idempotencyKey: 'request-key-123' })
    ).rejects.toMatchObject({ status: 503, definitive: false });
  });

  it.each([{ reason: 'reference_conflict' }, { code: 'IDEMPOTENCY_CONFLICT' }])(
    'keeps a reference conflict ambiguous because it does not prove no write: %#',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          json: async () => ({ success: false, error: 'Reference Conflict', ...body }),
        })
      );

      await expect(
        callClubArenaApi('marketplace-purchase', {}, { idempotencyKey: 'request-key-123' })
      ).rejects.toMatchObject({
        status: 409,
        definitive: false,
        data: expect.objectContaining(body),
      });
    }
  );

  it('keeps an ordinary 409 ambiguous so a retry reuses its original key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ success: false, error: 'Conflict', reason: 'settlement_locked' }),
      })
    );

    await expect(
      callClubArenaApi('marketplace-purchase', {}, { idempotencyKey: 'request-key-123' })
    ).rejects.toMatchObject({ status: 409, definitive: false });
  });

  it('refuses to send an old confirmation through a replacement account session', async () => {
    getSessionMock.mockResolvedValueOnce({
      data: {
        session: {
          access_token: 'replacement-token',
          user: { id: 'replacement-account' },
        },
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callClubArenaApi(
        'marketplace-purchase',
        {},
        { idempotencyKey: 'request-key-123', expectedUserId: 'original-account' }
      )
    ).rejects.toThrow('The Signed-In Player Changed Before This Request Started.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
