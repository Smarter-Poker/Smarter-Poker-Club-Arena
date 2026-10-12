import { describe, expect, it, vi } from 'vitest';
import {
  checkClubCreateCapacity,
  describeCapacity,
  readCapacity,
} from '../../scripts/ci/check-club-create-capacity.mjs';

const overview = (headroom: number) => ({
  ok: true,
  issuance: { issued_24h: 24_700_000 },
  policy: { headroom_24h_chips: headroom, rolling_24h_cap_chips: 25_000_000 },
});

describe('Club Create certification capacity', () => {
  it('requires enough headroom for every planned 100,000-chip opening grant', () => {
    expect(readCapacity(overview(300_000), 3)).toMatchObject({ ok: true, required: 300_000 });
    expect(readCapacity(overview(299_999.99), 3)).toMatchObject({
      ok: false,
      required: 300_000,
    });
  });

  it('names the audited policy action without changing or bypassing it', () => {
    const message = describeCapacity(readCapacity(overview(100_000), 3));
    expect(message).toContain('Club Create Capacity Refused');
    expect(message).toContain('Adjust The Audited Mint Policy With A Recorded Reason');
    expect(message).not.toMatch(/bypass|disable|ignore/i);
  });

  const environment = {
    SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    CLUB_CREATE_CERT_REQUIRED_GRANTS: '3',
  };
  const responses = (issued: unknown, policy: unknown) =>
    vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => issued })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => policy });

  it('reads only rolling issuance and the policy without requesting lifetime reconciliation', async () => {
    const fetchImpl = responses('24700000', [{ rolling_24h_cap_chips: '25000000' }]);
    await expect(checkClubCreateCapacity({ environment, fetchImpl })).resolves.toMatchObject({
      ok: true,
      required: 300_000,
      headroom: 300_000,
      issued: 24_700_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://example.invalid/rest/v1/rpc/fn_ca_mint_issued_24h',
      expect.objectContaining({ method: 'POST', body: '{"p_asset":"chips","p_except_leg":null}' })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://example.invalid/rest/v1/ca_mint_policy?id=eq.1&select=rolling_24h_cap_chips',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it.each([null, undefined, '', false, {}, -1, 'Infinity'])(
    'refuses unavailable issuance %j',
    async (issued) => {
      await expect(
        checkClubCreateCapacity({
          environment,
          fetchImpl: responses(issued, [{ rolling_24h_cap_chips: 25_000_000 }]),
        })
      ).rejects.toThrow('Capacity Is Unknown');
    }
  );

  it.each([
    [],
    [{}],
    [{ rolling_24h_cap_chips: null }],
    [{ rolling_24h_cap_chips: 1 }, { rolling_24h_cap_chips: 2 }],
  ])('refuses missing or ambiguous policy %j', async (policy) => {
    await expect(
      checkClubCreateCapacity({ environment, fetchImpl: responses(0, policy) })
    ).rejects.toThrow('Capacity Is Unknown');
  });

  it('retains exact insufficient capacity refusal', async () => {
    await expect(
      checkClubCreateCapacity({
        environment,
        fetchImpl: responses(24_700_000.01, [{ rolling_24h_cap_chips: 25_000_000 }]),
      })
    ).rejects.toMatchObject({ code: 'CLUB_CREATE_CAPACITY_REFUSED' });
  });

  it('refuses either failed read without a fallback', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(checkClubCreateCapacity({ environment, fetchImpl })).rejects.toThrow(
      'Read Failed (500)'
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails closed when headroom is unavailable', () => {
    expect(() => readCapacity({ ok: false }, 3)).toThrow('Capacity Is Unknown');
  });
});
