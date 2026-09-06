import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupProductionE2EAccount,
  cleanupStaleProductionE2EAccounts,
  createProductionE2EAccount,
} from '../../scripts/ci/production-e2e-account.mjs';

const USER_ID = '00000000-0000-4000-8000-000000000099';
const AVATAR = '/avatars/table/free_samurai@2x.webp';
const CLEANUP_MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260906015012_reserved_certification_cleanup_tracks_current_schema.sql'
  ),
  'utf8'
);

function environment(directory: string) {
  return {
    SUPABASE_URL: 'https://certification.supabase.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_certification',
    RUNNER_TEMP: directory,
    GITHUB_ENV: join(directory, 'github-env'),
  };
}

describe('post-deploy production account', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates one normalized reserved identity, exports it, then proves hard deletion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-'));
    const env = environment(directory);
    writeFileSync(env.GITHUB_ENV, '');
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/v1/admin/users') && init?.method === 'POST') {
        return Response.json({ id: USER_ID });
      }
      if (url.includes('/rest/v1/profiles?select=id%2Cemail%2Ccreated_at')) {
        return Response.json([]);
      }
      if (url.includes('/rest/v1/profiles?select=id,arena_avatar_url')) {
        return Response.json([{ id: USER_ID, arena_avatar_url: AVATAR }]);
      }
      if (url.includes('/rest/v1/profiles?select=id')) {
        return Response.json([{ id: USER_ID }]);
      }
      if (url.includes('/rest/v1/profiles?id=eq.') && init?.method === 'PATCH') {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/rest/v1/rpc/cleanup_reserved_certification_account')) {
        return Response.json({ success: true });
      }
      if (url.includes(`/auth/v1/admin/users/${USER_ID}`)) {
        return new Response(null, { status: 404 });
      }
      return new Response('unexpected request', { status: 500 });
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const account = await createProductionE2EAccount({
      environment: env,
      fetchImpl: fetchMock,
      wait: async () => undefined,
    });

    expect(account.id).toBe(USER_ID);
    expect(account.email).toMatch(/^ca-customization-cert-postdeploy-.+@example\.invalid$/);
    const exported = readFileSync(env.GITHUB_ENV, 'utf8');
    expect(exported).toContain(`SP_EMAIL=${account.email}`);
    expect(exported).toContain(`SP_PASS=${account.password}`);
    const recordPath = join(directory, 'club-arena-production-e2e-account.json');
    expect(existsSync(recordPath)).toBe(true);

    await expect(
      cleanupProductionE2EAccount({ environment: env, fetchImpl: fetchMock })
    ).resolves.toBe(true);
    expect(existsSync(recordPath)).toBe(false);
    const cleanupCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/rest/v1/rpc/cleanup_reserved_certification_account')
    );
    expect(String(cleanupCall?.[1]?.body)).toContain(USER_ID);
  });

  it('refuses cleanup outside its exact reserved namespace without a request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-refusal-'));
    const env = environment(directory);
    writeFileSync(
      join(directory, 'club-arena-production-e2e-account.json'),
      JSON.stringify({ id: USER_ID, email: 'real-player@example.com', password: 'unused' })
    );
    const fetchMock = vi.fn();

    await expect(
      cleanupProductionE2EAccount({ environment: env, fetchImpl: fetchMock })
    ).rejects.toThrow('outside the reserved post-deploy namespace');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recovers only bounded post-deploy accounts older than the job timeout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-stale-'));
    const env = environment(directory);
    const email = 'ca-customization-cert-postdeploy-orphan@example.invalid';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/profiles?')) {
        return Response.json([{ id: USER_ID, email, created_at: '2026-01-01T00:00:00.000Z' }]);
      }
      if (url.includes('/rest/v1/rpc/cleanup_reserved_certification_account')) {
        return Response.json({ success: true });
      }
      if (url.includes(`/auth/v1/admin/users/${USER_ID}`)) {
        return new Response(null, { status: 404 });
      }
      return new Response('unexpected request', { status: 500 });
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      cleanupStaleProductionE2EAccounts({
        environment: env,
        fetchImpl: fetchMock,
        now: Date.parse('2026-09-05T00:00:00.000Z'),
      })
    ).resolves.toBe(1);
    const query = decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]));
    expect(query).toContain('email=like.ca-customization-cert-postdeploy-*');
    expect(query).toContain('created_at=lte.');
  });

  it('waits out the maintenance freeze instead of abandoning the fixture', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-freeze-'));
    const env = environment(directory);
    const record = {
      id: USER_ID,
      email: 'ca-customization-cert-postdeploy-freeze@example.invalid',
    };
    let sweepAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/rpc/cleanup_reserved_certification_account')) {
        sweepAttempts += 1;
        return Response.json(
          sweepAttempts === 1 ? { success: false, reason: 'platform_is_frozen' } : { success: true }
        );
      }
      if (url.includes(`/auth/v1/admin/users/${USER_ID}`)) {
        return new Response(null, { status: 404 });
      }
      return new Response('unexpected request', { status: 500 });
    });
    const wait = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      cleanupProductionE2EAccount({ environment: env, fetchImpl: fetchMock, wait, record })
    ).resolves.toBe(true);
    expect(sweepAttempts).toBe(2);
    expect(wait).toHaveBeenCalledWith(10_000);
  });

  it('uses the locked reserved cleanup with current trigger and rate-limit ordering', () => {
    expect(CLEANUP_MIGRATION).toContain(
      "v_email NOT LIKE 'ca-customization-cert-%@example.invalid'"
    );
    expect(CLEANUP_MIGRATION).toContain("'app.game_management_retention', 'on', true");
    expect(CLEANUP_MIGRATION).toContain('DELETE FROM public.rate_limits WHERE user_id = p_user_id');
    expect(CLEANUP_MIGRATION.indexOf('DELETE FROM public.user_daily_challenges')).toBeLessThan(
      CLEANUP_MIGRATION.indexOf('DELETE FROM public.users')
    );
    expect(CLEANUP_MIGRATION.indexOf('DELETE FROM public.club_members')).toBeLessThan(
      CLEANUP_MIGRATION.indexOf('DELETE FROM public.users')
    );
    expect(CLEANUP_MIGRATION).toContain(
      'REVOKE ALL ON FUNCTION public.cleanup_reserved_certification_account(uuid)'
    );
    expect(CLEANUP_MIGRATION).toContain(
      'GRANT EXECUTE ON FUNCTION public.cleanup_reserved_certification_account(uuid) TO service_role'
    );
  });
});
