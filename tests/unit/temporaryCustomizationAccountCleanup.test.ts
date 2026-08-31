import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupTemporaryCustomizationAccount,
  type CustomizationCertificationEnvironment,
  type TemporaryCustomizationAccount,
} from '../e2e/support/temporaryCustomizationAccount';

const environment: CustomizationCertificationEnvironment = {
  supabaseUrl: 'https://certification.supabase.invalid',
  serviceRoleKey: 'sb_secret_certification',
  publishableKey: 'sb_publishable_certification',
};

function account(email = 'ca-customization-cert-buyer-test@example.invalid') {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    email,
    password: 'unused',
    client: {
      auth: { signOut: vi.fn().mockResolvedValue(undefined) },
    },
  } as unknown as TemporaryCustomizationAccount;
}

describe('temporary customization account cleanup', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries a transient PostgREST schema-cache outage and still proves hard deletion', async () => {
    let firstCleanup = true;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rest/v1/rpc/cleanup_reserved_certification_account') && firstCleanup) {
        firstCleanup = false;
        return new Response(
          JSON.stringify({ code: 'PGRST002', message: 'Could not query the database. Retrying.' }),
          { status: 503 }
        );
      }
      if (url.includes('/auth/v1/admin/users/') && (!init?.method || init.method === 'GET')) {
        return new Response(null, { status: 404 });
      }
      if (url.includes('/rest/v1/') && (!init?.method || init.method === 'GET')) {
        return Response.json([]);
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await cleanupTemporaryCustomizationAccount(environment, account());

    const cleanupCalls = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input).includes('/rest/v1/rpc/cleanup_reserved_certification_account') &&
        init?.method === 'POST'
    );
    expect(cleanupCalls).toHaveLength(2);
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('/auth/v1/admin/users/'))
    ).toBe(true);
  });

  it('refuses to delete any account outside the reserved certification namespace', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      cleanupTemporaryCustomizationAccount(environment, account('real-player@example.com'))
    ).rejects.toThrow('Refusing to clean non-certification account');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
