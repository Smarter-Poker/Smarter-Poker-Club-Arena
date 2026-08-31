import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupStaleTemporaryCustomizationAccounts,
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
  it('cleans only aged reserved fixtures before a new commerce certification', async () => {
    const reservedId = '00000000-0000-4000-8000-000000000002';
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/auth/v1/admin/users?page=')) {
        return Response.json({
          users: [
            {
              id: reservedId,
              email: 'ca-customization-cert-orphan@example.invalid',
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              id: '00000000-0000-4000-8000-000000000003',
              email: 'real-player@example.com',
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              id: '00000000-0000-4000-8000-000000000004',
              email: 'ca-customization-cert-active@example.invalid',
              created_at: '2999-01-01T00:00:00.000Z',
            },
          ],
        });
      }
      if (url.includes(`/auth/v1/admin/users/${reservedId}`)) {
        return new Response(null, { status: 404 });
      }
      if (url.includes('/rest/v1/rpc/cleanup_reserved_certification_account')) {
        return Response.json({ success: true });
      }
      return new Response(null, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(cleanupStaleTemporaryCustomizationAccounts(environment, 0)).resolves.toBe(1);

    const cleanupCalls = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input).includes('/rest/v1/rpc/cleanup_reserved_certification_account') &&
        init?.method === 'POST'
    );
    expect(cleanupCalls).toHaveLength(1);
    expect(String(cleanupCalls[0]?.[1]?.body)).toContain(reservedId);
    expect(String(cleanupCalls[0]?.[1]?.body)).not.toContain(
      '00000000-0000-4000-8000-000000000003'
    );
    expect(String(cleanupCalls[0]?.[1]?.body)).not.toContain(
      '00000000-0000-4000-8000-000000000004'
    );
  });

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
