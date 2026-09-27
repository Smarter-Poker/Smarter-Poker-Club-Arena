import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupProductionE2EAccount,
  cleanupStaleProductionE2EAccounts,
  createProductionE2EAccount,
  prepareProductionE2EStaffMembership,
  retireProductionCreateClubFixtures,
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
    VITE_SUPABASE_ANON_KEY: 'sb_publishable_certification',
    RUNNER_TEMP: directory,
    GITHUB_ENV: join(directory, 'github-env'),
  };
}

describe('post-deploy production account', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retires a ledger actor through Auth and verifies the retained identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-retirement-'));
    const env = environment(directory);
    const record = {
      id: USER_ID,
      email: 'ca-customization-cert-postdeploy-ledger@example.invalid',
    };
    const calls: string[] = [];
    let prepared = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method || 'GET'} ${url}`);
      if (url.endsWith('/rpc/cleanup_reserved_certification_account')) {
        if (!prepared) {
          prepared = true;
          return Response.json({
            success: false,
            reason: 'auth_soft_delete_required',
            user_id: USER_ID,
            email: record.email,
          });
        }
        return Response.json({
          success: true,
          disposition: 'retained_ledger_actor',
          user_id: USER_ID,
        });
      }
      if (init?.method === 'DELETE') {
        expect(JSON.parse(String(init.body))).toEqual({ should_soft_delete: true });
        return Response.json({ id: USER_ID, deleted_at: '2026-09-27T01:00:00Z' });
      }
      return Response.json({ id: USER_ID, deleted_at: '2026-09-27T01:00:00Z' });
    });
    await expect(
      cleanupProductionE2EAccount({ environment: env, fetchImpl: fetchMock, record })
    ).resolves.toBe(true);
    expect(calls.map((call) => call.split(' ')[0])).toEqual(['POST', 'DELETE', 'POST', 'GET']);
  });

  it('retains the record after an unknown Auth response and recovers by reading its outcome', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-retirement-unknown-'));
    const env = environment(directory);
    const record = {
      id: USER_ID,
      email: 'ca-customization-cert-postdeploy-ledger@example.invalid',
    };
    const path = join(directory, 'club-arena-production-e2e-account.json');
    writeFileSync(path, JSON.stringify(record));
    let retired = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/rpc/cleanup_reserved_certification_account')) {
        return Response.json(
          retired
            ? { success: true, disposition: 'retained_ledger_actor', user_id: USER_ID }
            : {
                success: false,
                reason: 'auth_soft_delete_required',
                user_id: USER_ID,
                email: record.email,
              }
        );
      }
      if (init?.method === 'DELETE') {
        retired = true;
        throw new Error('lost acknowledgment');
      }
      return Response.json({ id: USER_ID, deleted_at: '2026-09-27T01:00:00Z' });
    });
    await expect(
      cleanupProductionE2EAccount({ environment: env, fetchImpl: fetchMock })
    ).rejects.toThrow('lost acknowledgment');
    expect(existsSync(path)).toBe(true);
    await expect(
      cleanupProductionE2EAccount({ environment: env, fetchImpl: fetchMock })
    ).resolves.toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  });

  it.each(['identity', 'unfinished', 'auth-readback'])(
    'refuses %s retirement evidence without deleting its local record',
    async (failure) => {
      const directory = mkdtempSync(join(tmpdir(), 'production-e2e-retirement-refusal-'));
      const env = environment(directory);
      const record = {
        id: USER_ID,
        email: 'ca-customization-cert-postdeploy-ledger@example.invalid',
      };
      const path = join(directory, 'club-arena-production-e2e-account.json');
      writeFileSync(path, JSON.stringify(record));
      let prepared = false;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/rpc/cleanup_reserved_certification_account')) {
          if (!prepared) {
            prepared = true;
            return Response.json({
              success: false,
              reason: 'auth_soft_delete_required',
              user_id: USER_ID,
              email: failure === 'identity' ? 'person@example.com' : record.email,
            });
          }
          return Response.json(
            failure === 'unfinished'
              ? { success: false, reason: 'custody_changed' }
              : { success: true, disposition: 'retained_ledger_actor' }
          );
        }
        return Response.json({
          id: USER_ID,
          ...(failure === 'auth-readback' && init?.method !== 'DELETE'
            ? {}
            : { deleted_at: '2026-09-27T01:00:00Z' }),
        });
      });
      await expect(
        cleanupProductionE2EAccount({ environment: env, fetchImpl: fetchMock })
      ).rejects.toThrow(/retirement/i);
      expect(existsSync(path)).toBe(true);
      if (failure === 'identity')
        expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(
          0
        );
    }
  );

  it('keeps the stale-account limit and refuses a too-young fixture from its inventory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-stale-bounds-'));
    const env = environment(directory);
    const row = {
      id: USER_ID,
      email: 'ca-customization-cert-postdeploy-ledger@example.invalid',
      created_at: '2026-09-27T01:00:00Z',
    };
    const tooMany = vi.fn(async () => Response.json(Array.from({ length: 21 }, () => row)));
    await expect(
      cleanupStaleProductionE2EAccounts({ environment: env, fetchImpl: tooMany })
    ).rejects.toThrow('more than 20');
    expect(tooMany).toHaveBeenCalledTimes(1);
    const young = vi.fn(async () => Response.json([row]));
    await expect(
      cleanupStaleProductionE2EAccounts({
        environment: env,
        fetchImpl: young,
        now: Date.parse(row.created_at),
      })
    ).rejects.toThrow('invalid stale');
    expect(young).toHaveBeenCalledTimes(1);
  });

  it('creates one normalized reserved identity, exports it, then proves hard deletion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-'));
    const env = environment(directory);
    writeFileSync(env.GITHUB_ENV, '');
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/v1/admin/users') && init?.method === 'POST') {
        return Response.json({ id: USER_ID });
      }
      if (url.includes('/rest/v1/rpc/fn_ca_stale_certification_accounts')) {
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

  it('refuses staff preparation for any non-certification identity without a request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-real-staff-'));
    const env = environment(directory);
    writeFileSync(
      join(directory, 'club-arena-production-e2e-account.json'),
      JSON.stringify({ id: USER_ID, email: 'real-player@example.com', password: 'unused' })
    );
    const fetchMock = vi.fn();

    await expect(
      prepareProductionE2EStaffMembership({ environment: env, fetchImpl: fetchMock })
    ).rejects.toThrow('outside the reserved post-deploy namespace');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retires only the reserved account own prefixed Create Club fixture and verifies absence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-create-club-'));
    const env = environment(directory);
    const clubId = '11111111-1111-4111-8111-111111111111';
    writeFileSync(
      join(directory, 'club-arena-production-e2e-account.json'),
      JSON.stringify({
        id: USER_ID,
        email: 'ca-customization-cert-postdeploy-create@example.invalid',
      })
    );
    let clubReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/clubs?')) {
        clubReads += 1;
        return Response.json(
          clubReads === 1 ? [{ id: clubId, name: 'Crest Cert 123456789', owner_id: USER_ID }] : []
        );
      }
      if (url.includes('/rest/v1/rpc/fn_ca_retire_certification_club')) {
        return Response.json({ success: true, chips_retired: 100000 });
      }
      return new Response('unexpected request', { status: 500 });
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      retireProductionCreateClubFixtures({ environment: env, fetchImpl: fetchMock })
    ).resolves.toBe(1);
    const retirement = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/rest/v1/rpc/fn_ca_retire_certification_club')
    );
    expect(JSON.parse(String(retirement?.[1]?.body))).toEqual({
      p_club_id: clubId,
      p_reason: 'ui-cert-cleanup',
    });
  });

  it('refuses to retire an owned club outside the exact certificate prefix', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-create-refusal-'));
    const env = environment(directory);
    writeFileSync(
      join(directory, 'club-arena-production-e2e-account.json'),
      JSON.stringify({
        id: USER_ID,
        email: 'ca-customization-cert-postdeploy-create-refusal@example.invalid',
      })
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json([{ id: 'real-club', name: 'Real Player Club', owner_id: USER_ID }])
      );

    await expect(
      retireProductionCreateClubFixtures({ environment: env, fetchImpl: fetchMock })
    ).rejects.toThrow('Refusing to retire unrecognized club real-club');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers only bounded post-deploy accounts older than the job timeout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-stale-'));
    const env = environment(directory);
    const email = 'ca-customization-cert-postdeploy-orphan@example.invalid';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/rpc/fn_ca_stale_certification_accounts')) {
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
    expect(query).toContain('/rpc/fn_ca_stale_certification_accounts');
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request[1]?.body))).toEqual({ p_before: '2026-09-04T23:20:00.000Z' });
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
