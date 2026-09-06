import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupProductionE2EAccount,
  cleanupStaleProductionE2EAccounts,
  createProductionE2EAccount,
  prepareProductionE2EStaffMembership,
} from '../../scripts/ci/production-e2e-account.mjs';

const USER_ID = '00000000-0000-4000-8000-000000000099';
const AVATAR = '/avatars/table/free_samurai@2x.webp';

function environment(directory: string) {
  return {
    SUPABASE_URL: 'https://certification.supabase.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_certification',
    VITE_SUPABASE_ANON_KEY: 'sb_publishable_certification',
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
      if (url.includes('/rest/v1/rpc/fn_sweep_test_account')) {
        return Response.json({ swept: true });
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
      String(input).includes('/rest/v1/rpc/fn_sweep_test_account')
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

  it('creates staff access only for a new reserved zero-balance membership', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-staff-'));
    const env = environment(directory);
    const email = 'ca-customization-cert-postdeploy-staff@example.invalid';
    writeFileSync(
      join(directory, 'club-arena-production-e2e-account.json'),
      JSON.stringify({ id: USER_ID, email, password: 'unused' })
    );
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/auth/v1/token?grant_type=password')) {
        return Response.json({ access_token: 'temporary-user-token' });
      }
      if (url.includes('/rest/v1/rpc/fn_join_club')) {
        return Response.json({ club_id: 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4' });
      }
      if (url.includes('/rest/v1/club_members?') && init?.method !== 'PATCH') {
        const membershipReads = fetchMock.mock.calls.filter(([called]) =>
          String(called).includes('/rest/v1/club_members?')
        ).length;
        if (membershipReads === 1) return Response.json([]);
        return Response.json([
          {
            club_id: 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
            user_id: USER_ID,
            role: 'player',
            status: 'active',
            chip_balance: 0,
          },
        ]);
      }
      if (url.includes('/rest/v1/club_members?') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        return Response.json([
          {
            club_id: 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
            user_id: USER_ID,
            role: body.role,
            status: body.status,
            chip_balance: 0,
          },
        ]);
      }
      return new Response('unexpected request', { status: 500 });
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      prepareProductionE2EStaffMembership({ environment: env, fetchImpl: fetchMock })
    ).resolves.toMatchObject({ role: 'admin', status: 'active', chip_balance: 0 });
    const roleUpdate = fetchMock.mock.calls.find(
      ([input, init]) => String(input).includes('/club_members?') && init?.method === 'PATCH'
    );
    expect(JSON.parse(String(roleUpdate?.[1]?.body))).toMatchObject({
      role: 'admin',
      status: 'active',
    });
  });

  it('refuses to overwrite an existing reserved membership', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-existing-staff-'));
    const env = environment(directory);
    writeFileSync(
      join(directory, 'club-arena-production-e2e-account.json'),
      JSON.stringify({
        id: USER_ID,
        email: 'ca-customization-cert-postdeploy-existing@example.invalid',
      })
    );
    const fetchMock = vi.fn().mockResolvedValue(Response.json([{ role: 'player' }]));

    await expect(
      prepareProductionE2EStaffMembership({ environment: env, fetchImpl: fetchMock })
    ).rejects.toThrow('Refusing to change an existing Club Arena membership');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      if (url.includes('/rest/v1/rpc/fn_sweep_test_account')) {
        return Response.json({ swept: true });
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
      if (url.includes('/rest/v1/rpc/fn_sweep_test_account')) {
        sweepAttempts += 1;
        return Response.json(
          sweepAttempts === 1 ? { swept: false, reason: 'platform_is_frozen' } : { swept: true }
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
});
