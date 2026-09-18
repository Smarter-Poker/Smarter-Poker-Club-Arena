import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the real SDK and shared application clients. Intercept the transport
// before import so the regression is safe even against the old production URL.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('unit database isolation', () => {
  it('directs every real service client to an inert endpoint with a test-only key', async () => {
    const requests: Request[] = [];
    vi.stubGlobal('fetch', async (input: string | Request | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { supabase, maintenanceSupabase, seedingSupabase } =
      await import('../services/supabase/client.js');

    for (const client of [supabase, maintenanceSupabase, seedingSupabase]) {
      const result = await client.from('unit_test_fixture').select('id');
      expect(result.error).toBeNull();
    }

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(new URL(request.url).origin).toBe('https://supabase.invalid');
      expect(request.headers.get('apikey')).toBe('unit-test-placeholder-key');
      expect(request.headers.get('authorization')).toBe('Bearer unit-test-placeholder-key');
    }
  });

  it('keeps transport failure visible instead of fabricating database success', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('isolated database has no network transport');
    });
    vi.stubGlobal('fetch', fetcher);
    const { supabase } = await import('../services/supabase/client.js');
    const result = await supabase.from('unit_test_fixture').select('id');
    expect(result.data).toBeNull();
    expect(result.error?.message).toContain('isolated database has no network transport');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
