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

  it('reads capacity without writing financial state', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => overview(500_000),
    })) as unknown as typeof fetch;

    await expect(
      checkClubCreateCapacity({
        environment: {
          SUPABASE_URL: 'https://example.invalid',
          SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
          CLUB_CREATE_CERT_REQUIRED_GRANTS: '3',
        },
        fetchImpl,
      })
    ).resolves.toMatchObject({ ok: true, required: 300_000 });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.invalid/rest/v1/rpc/fn_ca_mint_overview',
      expect.objectContaining({ method: 'POST', body: '{}' })
    );
  });

  it('fails closed when headroom is unavailable', () => {
    expect(() => readCapacity({ ok: false }, 3)).toThrow('Capacity Is Unknown');
  });
});
