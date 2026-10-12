import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_FREEZE_POLL_MS } from '../../scripts/ci/platform-freeze-window.mjs';

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
      if (url.includes('/rest/v1/profiles?')) {
        return Response.json([
          {
            id: reservedId,
            email: 'ca-customization-cert-orphan@example.invalid',
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ]);
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

    const profileQuery = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/rest/v1/profiles?')
    );
    expect(decodeURIComponent(String(profileQuery?.[0]))).toContain(
      'email.not.like.ca-customization-cert-postdeploy-*@example.invalid'
    );

    const cleanupCalls = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input).includes('/rest/v1/rpc/cleanup_reserved_certification_account') &&
        init?.method === 'POST'
    );
    expect(cleanupCalls).toHaveLength(1);
    expect(String(cleanupCalls[0]?.[1]?.body)).toContain(reservedId);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/auth/v1/admin/users?page='),
      expect.anything()
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

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
      if (url.includes('/rest/v1/rpc/cleanup_reserved_certification_account')) {
        return Response.json({ success: true });
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

  it('waits on the freeze to END, not on a tick count, then proves hard deletion', async () => {
    vi.useFakeTimers();
    let cleanupCalls = 0;
    let freezeReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rest/v1/rpc/cleanup_reserved_certification_account')) {
        cleanupCalls += 1;
        return Response.json(
          cleanupCalls === 1 ? { success: false, reason: 'platform_is_frozen' } : { success: true }
        );
      }
      if (url.includes('/rest/v1/engine_maintenance_break')) {
        return Response.json([
          {
            phase: 'counting_down',
            break_started_at: new Date(Date.now() - 60_000).toISOString(),
            break_ends_at: new Date(Date.now() + 240_000).toISOString(),
            enforce_freeze: true,
          },
        ]);
      }
      if (url.includes('/rest/v1/rpc/fn_platform_frozen')) {
        freezeReads += 1;
        return Response.json(freezeReads === 1);
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

    const cleanup = cleanupTemporaryCustomizationAccount(environment, account());
    // One poll interval is all the freeze needs here. The old loop could only
    // ever tick 37 times at ten seconds, and no measured break was that short.
    await vi.advanceTimersByTimeAsync(PLATFORM_FREEZE_POLL_MS * 2);
    await expect(cleanup).resolves.toBeUndefined();
    expect(cleanupCalls).toBe(2);
    expect(freezeReads).toBe(2);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/rest/v1/engine_maintenance_break')
      )
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('/auth/v1/admin/users/'))
    ).toBe(true);
    vi.useRealTimers();
  });

  it('fails closed when guarded cleanup refuses for a non-freeze reason', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rest/v1/rpc/cleanup_reserved_certification_account')) {
        return Response.json({ success: false, reason: 'email_not_reserved' });
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

    await expect(cleanupTemporaryCustomizationAccount(environment, account())).rejects.toThrow(
      'Guarded certification cleanup refused'
    );
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
