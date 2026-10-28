import { workflowJobBudget } from '../productionJobBudget';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_FREEZE_POLL_MS } from '../../scripts/ci/platform-freeze-window.mjs';

import {
  cleanupProductionE2EAccount,
  cleanupStaleProductionE2EAccounts,
  createProductionE2EAccount,
  prepareProductionE2EStaffMembership,
  prepareProductionE2ESpectatorMembership,
  prepareProductionE2ETemplateMembership,
  prepareProductionE2ELightningMembership,
  prepareProductionE2ETemplateFixture,
  DEFAULT_E2E_LIGHTNING_CLUB_ID,
  DEFAULT_E2E_TEMPLATE_CLUB_ID,
  STALE_ACCOUNT_AGE_MS,
  retireCertificationClubWithRetry,
  retireProductionCreateClubFixtures,
  RETIREMENT_REFUSAL_CLUB_HAS_HISTORY,
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
const POST_DEPLOY_WORKFLOW = readFileSync(
  resolve(process.cwd(), '.github/workflows/post-deploy-e2e.yml'),
  'utf8'
);
const CLUB_CREATE_WORKFLOW = readFileSync(
  resolve(process.cwd(), '.github/workflows/club-create-certification.yml'),
  'utf8'
);

function workflowJobTimeoutMinutes(source: string, job: string) {
  const budget = workflowJobBudget(source, job);
  return Math.max(budget.ordinary, budget.optIn);
}

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

  it.each([
    { ageMinutes: 44, setupFails: false },
    { ageMinutes: 80, setupFails: false },
    { ageMinutes: 1440, setupFails: false },
    { ageMinutes: 44, setupFails: true },
  ])(
    'preserves another run at age $ageMinutes minutes (setupFails=$setupFails)',
    async ({ ageMinutes, setupFails }) => {
      const directory = mkdtempSync(join(tmpdir(), 'production-e2e-overlap-'));
      const env = environment(directory);
      writeFileSync(env.GITHUB_ENV, '');
      const otherId = '00000000-0000-4000-8000-000000000088';
      const retired: string[] = [];
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/rpc/fn_ca_stale_certification_accounts')) {
          return Response.json([
            {
              id: otherId,
              email: 'ca-customization-cert-postdeploy-other-run@example.invalid',
              created_at: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
            },
          ]);
        }
        if (url.includes('/rest/v1/clubs?')) return Response.json([]);
        if (url.endsWith('/rpc/cleanup_reserved_certification_account')) {
          retired.push(JSON.parse(String(init?.body)).p_user_id);
          return Response.json({ success: true });
        }
        if (url.endsWith('/auth/v1/admin/users') && init?.method === 'POST') {
          return Response.json({ id: USER_ID });
        }
        if (url.includes('/auth/v1/admin/users/')) return new Response(null, { status: 404 });
        if (url.includes('/rest/v1/profiles?select=id,arena_avatar_url')) {
          return Response.json([{ id: USER_ID, arena_avatar_url: AVATAR }]);
        }
        if (url.includes('/rest/v1/profiles?select=id')) {
          return Response.json(setupFails ? [] : [{ id: USER_ID }]);
        }
        if (url.includes('/rest/v1/profiles?id=eq.') && init?.method === 'PATCH') {
          return new Response(null, { status: 204 });
        }
        throw new Error('Unexpected fixture request: ' + url);
      });
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const creation = createProductionE2EAccount({
        environment: env,
        fetchImpl: fetchMock,
        wait: async () => undefined,
      });
      if (setupFails) {
        await expect(creation).rejects.toThrow('never received a profile row');
      } else {
        await expect(creation).resolves.toMatchObject({ id: USER_ID });
        await cleanupProductionE2EAccount({ environment: env, fetchImpl: fetchMock });
      }
      // A reserved, zero-custody identity may still belong to a running or
      // overdue lane. Only the identity created by this invocation is ours.
      expect(retired).toEqual([USER_ID]);
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes('fn_ca_stale_certification_accounts')
        )
      ).toBe(false);
    }
  );

  it('concurrent observer lanes create distinct principals and clean up only their own record', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(Date, 'now').mockReturnValue(1792160000000);
    const lanes = [1, 2].map((n) => {
      const id = `00000000-0000-4000-8000-00000000009${n}`;
      const directory = mkdtempSync(join(tmpdir(), 'production-e2e-observer-'));
      const env = environment(directory);
      writeFileSync(env.GITHUB_ENV, '');
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/auth/v1/admin/users') && init?.method === 'POST')
          return Response.json({ id });
        if (url.includes('/rest/v1/profiles?select=id,arena_avatar_url'))
          return Response.json([{ id, arena_avatar_url: AVATAR }]);
        if (url.includes('/rest/v1/profiles?select=id')) return Response.json([{ id }]);
        if (url.includes('/rest/v1/profiles?id=eq.') && init?.method === 'PATCH')
          return new Response(null, { status: 204 });
        if (url.includes('/rpc/cleanup_reserved_certification_account')) {
          expect(String(init?.body)).toContain(id);
          return Response.json({ success: true });
        }
        if (url.includes(`/auth/v1/admin/users/${id}`)) return new Response(null, { status: 404 });
        throw new Error(`Unexpected observer request ${url}`);
      });
      return { id, env, fetchMock, directory };
    });
    const accounts = await Promise.all(
      lanes.map((lane) =>
        createProductionE2EAccount({
          environment: lane.env,
          fetchImpl: lane.fetchMock,
          wait: async () => undefined,
        })
      )
    );
    expect(accounts[0].id).not.toBe(accounts[1].id);
    expect(accounts[0].email).not.toBe(accounts[1].email);
    expect(accounts[0].password).not.toBe(accounts[1].password);
    await cleanupProductionE2EAccount({ environment: lanes[0].env, fetchImpl: lanes[0].fetchMock });
    expect(existsSync(join(lanes[1].directory, 'club-arena-production-e2e-account.json'))).toBe(
      true
    );
    await cleanupProductionE2EAccount({ environment: lanes[1].env, fetchImpl: lanes[1].fetchMock });
    for (const lane of lanes)
      expect(
        lane.fetchMock.mock.calls.some(([url]) =>
          String(url).includes('fn_ca_stale_certification_accounts')
        )
      ).toBe(false);
  });

  it('retains the known reserved identity when normalization and immediate cleanup both fail', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-recoverable-'));
    const env = environment(directory);
    const path = join(directory, 'club-arena-production-e2e-account.json');
    writeFileSync(env.GITHUB_ENV, '');
    let recovering = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/v1/admin/users') && init?.method === 'POST')
        return Response.json({ id: USER_ID });
      if (url.includes('/rest/v1/profiles?select=id')) return Response.json([{ id: USER_ID }]);
      if (url.includes('/rest/v1/profiles?id=eq.') && init?.method === 'PATCH')
        return Response.json({ message: 'normalization refused' }, { status: 400 });
      if (url.endsWith('/rpc/cleanup_reserved_certification_account')) {
        expect(JSON.parse(String(init?.body))).toEqual({ p_user_id: USER_ID });
        return recovering
          ? Response.json({ success: true })
          : Response.json({ message: 'cleanup refused' }, { status: 400 });
      }
      if (url.endsWith(`/auth/v1/admin/users/${USER_ID}`) && recovering)
        return new Response(null, { status: 404 });
      throw new Error('Unexpected recovery request');
    });
    try {
      await expect(
        createProductionE2EAccount({
          environment: env,
          fetchImpl: fetchMock,
          wait: async () => undefined,
        })
      ).rejects.toThrow('setup failed and cleanup was incomplete');
      expect(existsSync(path)).toBe(true);
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      expect(saved).toMatchObject({ id: USER_ID });
      expect(saved.email).toMatch(/^ca-customization-cert-postdeploy-.*@example\.invalid$/);
      expect(typeof saved.password).toBe('string');
      expect(typeof saved.createdAt).toBe('string');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      // The workflow's existing always() cleanup can recover from the durable
      // record even though creation never returned or exported credentials.
      expect(readFileSync(env.GITHUB_ENV, 'utf8')).toBe('');
      recovering = true;
      await expect(
        cleanupProductionE2EAccount({ environment: env, fetchImpl: fetchMock })
      ).resolves.toBe(true);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it('joins the live-table spectator to one union club as an ordinary zero-balance player', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-spectator-'));
    const env = { ...environment(directory), E2E_CLUB_ID: '002c2d27-9584-4e52-835a-bb2be148fc81' };
    writeFileSync(
      join(directory, 'club-arena-production-e2e-account.json'),
      JSON.stringify({
        id: USER_ID,
        email: 'ca-customization-cert-postdeploy-spectator@example.invalid',
        password: 'unused',
      })
    );
    const SHARK = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/auth/v1/token?grant_type=password')) {
        return Response.json({ access_token: 'temporary-user-token' });
      }
      if (url.includes('/rest/v1/rpc/fn_join_club')) {
        expect(JSON.parse(String(init?.body))).toEqual({ p_club_id: SHARK });
        return Response.json({ club_id: SHARK });
      }
      if (url.includes('/rest/v1/club_members?') && init?.method !== 'PATCH') {
        expect(url).toContain(`club_id=eq.${SHARK}`);
        const reads = fetchMock.mock.calls.filter(([called]) =>
          String(called).includes('/rest/v1/club_members?')
        ).length;
        if (reads === 1) return Response.json([]);
        return Response.json([
          { club_id: SHARK, user_id: USER_ID, role: 'player', status: 'active', chip_balance: 0 },
        ]);
      }
      if (url.includes('/rest/v1/club_members?') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        return Response.json([
          {
            club_id: SHARK,
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
      prepareProductionE2ESpectatorMembership({ environment: env, fetchImpl: fetchMock })
    ).resolves.toMatchObject({ club_id: SHARK, role: 'player', status: 'active', chip_balance: 0 });
    const roleUpdate = fetchMock.mock.calls.find(
      ([input, init]) => String(input).includes('/club_members?') && init?.method === 'PATCH'
    );
    expect(JSON.parse(String(roleUpdate?.[1]?.body))).toMatchObject({ role: 'player' });
    expect(String(roleUpdate?.[1]?.body)).not.toContain('admin');
  });

  it.each([
    [],
    [{ id: DEFAULT_E2E_TEMPLATE_CLUB_ID, union_id: 'union', status: 'active' }],
    [{ id: DEFAULT_E2E_TEMPLATE_CLUB_ID, union_id: null, status: 'closed' }],
    [{ id: 'wrong', union_id: null, status: 'active' }],
    null,
  ])('refuses invalid standalone scope before any membership write: %j', async (rows) => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-template-invalid-'));
    const env = environment(directory);
    writeFileSync(
      join(directory, 'club-arena-production-e2e-account.json'),
      JSON.stringify({
        id: USER_ID,
        email: 'ca-customization-cert-postdeploy-template@example.invalid',
        password: 'unused',
      })
    );
    const fetchMock = vi.fn().mockResolvedValue(Response.json(rows));
    await expect(
      prepareProductionE2ETemplateMembership({ environment: env, fetchImpl: fetchMock })
    ).rejects.toThrow('requires one active standalone club');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `/clubs?id=eq.${DEFAULT_E2E_TEMPLATE_CLUB_ID}`
    );
  });

  it('gives only the reserved zero-balance account standalone template access through public join', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-template-'));
    const env = environment(directory);
    writeFileSync(
      join(directory, 'club-arena-production-e2e-account.json'),
      JSON.stringify({
        id: USER_ID,
        email: 'ca-customization-cert-postdeploy-template@example.invalid',
        password: 'unused',
      })
    );
    let memberReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/clubs?'))
        return Response.json([
          { id: DEFAULT_E2E_TEMPLATE_CLUB_ID, union_id: null, status: 'active' },
        ]);
      if (url.includes('/auth/v1/token?')) return Response.json({ access_token: 'test-token' });
      if (url.includes('/rpc/fn_join_club')) {
        expect(JSON.parse(String(init?.body))).toEqual({ p_club_id: DEFAULT_E2E_TEMPLATE_CLUB_ID });
        return Response.json({ success: true });
      }
      if (url.includes('/club_members?')) {
        expect(url).toContain(`club_id=eq.${DEFAULT_E2E_TEMPLATE_CLUB_ID}`);
        if (init?.method !== 'PATCH' && ++memberReads === 1) return Response.json([]);
        return Response.json([
          {
            club_id: DEFAULT_E2E_TEMPLATE_CLUB_ID,
            user_id: USER_ID,
            role: init?.method === 'PATCH' ? 'admin' : 'player',
            status: 'active',
            chip_balance: 0,
          },
        ]);
      }
      throw new Error('Unexpected request ' + url);
    });
    await expect(
      prepareProductionE2ETemplateMembership({ environment: env, fetchImpl: fetchMock })
    ).resolves.toMatchObject({ club_id: DEFAULT_E2E_TEMPLATE_CLUB_ID, chip_balance: 0 });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });

  it.each([
    'created',
    'unknown',
    'probe-refused',
    'rollback-refused',
    'recovered',
    'schedule-missing',
    'schedule-foreign',
    'schedule-refused',
    'schedule-active',
    'recovered-active',
  ])(
    'owns a standalone template request through %s without touching a player club',
    async (mode) => {
      const directory = mkdtempSync(join(tmpdir(), 'production-e2e-owned-template-'));
      const env = {
        ...environment(directory),
        DATABASE_URL: 'postgres://qualified-test',
        GITHUB_ENV: join(directory, 'github-env'),
      };
      const requestId = '00000000-0000-4000-8000-000000000088';
      const clubId = '00000000-0000-4000-8000-000000000077';
      const accountPath = join(directory, 'club-arena-production-e2e-account.json');
      writeFileSync(
        accountPath,
        JSON.stringify({
          id: USER_ID,
          email: 'ca-customization-cert-postdeploy-template@example.invalid',
          password: 'unused',
          templateFixtureRequest: { requestId },
        })
      );
      const club = {
        id: clubId,
        owner_id: USER_ID,
        name: 'Crest Cert Template 00000000',
        status: 'active',
        union_id: null,
        is_public: false,
        requires_approval: true,
      };
      const member = { role: 'owner', status: 'active', chip_balance: 0 };
      const schedule = {
        id: '00000000-0000-4000-8000-000000000099',
        club_id: clubId,
        union_id: null,
        active: false,
      };
      const operations: string[] = [];
      const claims = { sub: USER_ID, role: 'authenticated' };
      const token = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
      const client = {
        connect: vi.fn(),
        end: vi.fn(),
        query: vi.fn(async (sql: string, parameters?: unknown[]) => {
          operations.push(sql);
          if (sql === 'COMMIT' && mode === 'unknown')
            throw new Error('transport acknowledgement unknown');
          if (sql === 'ROLLBACK' && mode === 'rollback-refused')
            throw new Error('rollback refused');
          if (sql.includes('fn_create_club_atomic')) {
            const record = JSON.parse(readFileSync(accountPath, 'utf8'));
            expect(record.templateFixtureRequest.requestId).toBe(requestId);
            expect(parameters).toEqual([
              requestId,
              club.name,
              'Disposable post-deploy standalone template certificate',
              'royal-blue',
              false,
              true,
              null,
            ]);
            if (mode === 'probe-refused') throw new Error('probe refused');
            return { rows: [{ club }] };
          }
          if (sql.includes('FROM public.club_members')) return { rows: [member] };
          if (sql.includes('FROM public.club_welcome_package_items'))
            return {
              rows:
                mode === 'schedule-missing'
                  ? []
                  : [
                      {
                        ...schedule,
                        club_id: mode === 'schedule-foreign' ? 'foreign-club' : clubId,
                      },
                    ],
            };
          if (sql.includes('fn_delete_tournament_schedule'))
            return {
              rows: [
                {
                  result:
                    mode === 'schedule-refused'
                      ? { error: 'not_authorised' }
                      : { ok: true, schedule_id: schedule.id },
                },
              ],
            };
          if (sql.includes('FROM public.tournament_schedules'))
            return { rows: [{ ...schedule, active: mode === 'schedule-active' }] };
          return { rows: [] };
        }),
      };
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/auth/v1/token')) return Response.json({ access_token: token });
        if (url.includes('/auth/v1/user')) return Response.json({ id: USER_ID });
        if (url.includes('/club_creation_requests?'))
          return Response.json(mode.startsWith('recovered') ? [{ club_id: clubId }] : []);
        if (url.includes('/rpc/fn_create_club_atomic'))
          throw new Error('Non-atomic HTTP create forbidden');
        if (url.includes('/club_welcome_package_items?'))
          return Response.json([{ entity_id: schedule.id }]);
        if (url.includes('/tournament_schedules?'))
          return Response.json([{ ...schedule, active: mode === 'recovered-active' }]);
        if (url.includes('/clubs?')) return Response.json([club]);
        if (url.includes('/club_members?')) return Response.json([member]);
        throw new Error('Unexpected request ' + url);
      });
      const operation = prepareProductionE2ETemplateFixture({
        environment: env,
        fetchImpl: fetchMock,
        databaseClientFactory: async () => client,
      });
      const refusals: Record<string, string> = {
        unknown: 'acknowledgement unknown',
        'probe-refused': 'probe refused',
        'rollback-refused': 'rollback refused',
        'schedule-missing': 'welcome schedule lineage was not exact',
        'schedule-foreign': 'welcome schedule lineage was not exact',
        'schedule-refused': 'welcome schedule isolation was refused',
        'schedule-active': 'welcome schedule remained active',
        'recovered-active': 'welcome schedule isolation was not verified',
      };
      const refusal = refusals[mode];
      if (refusal) {
        await expect(operation).rejects.toThrow(refusal);
        expect(existsSync(env.GITHUB_ENV)).toBe(false);
        expect(JSON.parse(readFileSync(accountPath, 'utf8')).templateFixtureRequest.requestId).toBe(
          requestId
        );
      } else {
        await expect(operation).resolves.toMatchObject(club);
        expect(readFileSync(env.GITHUB_ENV, 'utf8')).toBe(`E2E_TEMPLATE_CLUB_ID=${clubId}\n`);
      }
      if (mode.startsWith('recovered')) {
        expect(operations).toEqual([]);
        expect(client.connect).not.toHaveBeenCalled();
      } else {
        expect(operations[0]).toBe('BEGIN');
        expect(operations).toContain('SET LOCAL ROLE authenticated');
        expect(operations).toContain('ROLLBACK');
        expect(client.end).toHaveBeenCalled();
        if (mode === 'created' || mode === 'unknown') {
          const commitIndex = operations.indexOf('COMMIT');
          const disableIndexes = operations.flatMap((sql, index) =>
            sql.includes('fn_delete_tournament_schedule') ? [index] : []
          );
          expect(disableIndexes).toHaveLength(2);
          expect(operations.indexOf('ROLLBACK')).toBeLessThan(disableIndexes[1]);
          expect(disableIndexes[1]).toBeLessThan(commitIndex);
          expect(client.end).toHaveBeenCalledTimes(2);
        } else expect(operations).not.toContain('COMMIT');
      }
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/fn_create_club_atomic'))
      ).toBe(false);
    }
  );

  it('waits out the hourly platform freeze instead of failing template creation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-template-freeze-'));
    const env = {
      ...environment(directory),
      DATABASE_URL: 'postgres://qualified-test',
      GITHUB_ENV: join(directory, 'github-env'),
    };
    const requestId = '00000000-0000-4000-8000-000000000066';
    const clubId = '00000000-0000-4000-8000-000000000055';
    writeFileSync(
      join(directory, 'club-arena-production-e2e-account.json'),
      JSON.stringify({
        id: USER_ID,
        email: 'ca-customization-cert-postdeploy-template@example.invalid',
        password: 'unused',
        templateFixtureRequest: { requestId },
      })
    );
    const club = {
      id: clubId,
      owner_id: USER_ID,
      name: 'Crest Cert Template 00000000',
      status: 'active',
      union_id: null,
      is_public: false,
      requires_approval: true,
    };
    const claims = { sub: USER_ID, role: 'authenticated' };
    const token = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
    let qualifications = 0;
    const client = {
      connect: vi.fn(),
      end: vi.fn(),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('fn_create_club_atomic')) {
          if (++qualifications === 1)
            throw new Error(
              'PLATFORM_FROZEN: the platform is on a scheduled maintenance break. ' +
                'INSERT on chip_transactions was refused; it will succeed when play resumes.'
            );
          return { rows: [{ club }] };
        }
        if (
          sql.includes('FROM public.club_welcome_package_items') ||
          sql.includes('FROM public.tournament_schedules')
        )
          return { rows: [{ id: 'schedule', club_id: clubId, union_id: null, active: false }] };
        if (sql.includes('fn_delete_tournament_schedule'))
          return { rows: [{ result: { ok: true, schedule_id: 'schedule' } }] };
        if (sql.includes('FROM public.club_members'))
          return { rows: [{ role: 'owner', status: 'active', chip_balance: 0 }] };
        return { rows: [] };
      }),
    };
    let frozenReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/auth/v1/token')) return Response.json({ access_token: token });
      if (url.includes('/auth/v1/user')) return Response.json({ id: USER_ID });
      if (url.includes('/club_creation_requests?')) return Response.json([]);
      if (url.includes('/engine_maintenance_break')) return Response.json([]);
      if (url.includes('/rpc/fn_platform_frozen')) return Response.json(++frozenReads < 2);
      if (url.includes('/rpc/fn_create_club_atomic')) return Response.json(club);
      if (url.includes('/club_welcome_package_items?'))
        return Response.json([{ entity_id: 'schedule' }]);
      if (url.includes('/tournament_schedules?'))
        return Response.json([{ id: 'schedule', club_id: clubId, union_id: null, active: false }]);
      if (url.includes('/clubs?')) return Response.json([club]);
      if (url.includes('/club_members?'))
        return Response.json([{ role: 'owner', status: 'active', chip_balance: 0 }]);
      throw new Error('Unexpected request ' + url);
    });
    const wait = vi.fn(async () => undefined);
    await expect(
      prepareProductionE2ETemplateFixture({
        environment: env,
        fetchImpl: fetchMock,
        databaseClientFactory: async () => client,
        wait,
      })
    ).resolves.toMatchObject({ id: clubId });
    expect(qualifications).toBe(3);
    expect(wait).toHaveBeenCalled();
    expect(readFileSync(env.GITHUB_ENV, 'utf8')).toBe(`E2E_TEMPLATE_CLUB_ID=${clubId}\n`);
  });

  it('keeps the owned fixture record and account when template retirement refuses', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-template-cleanup-'));
    const env = environment(directory);
    const path = join(directory, 'club-arena-production-e2e-account.json');
    writeFileSync(
      path,
      JSON.stringify({
        id: USER_ID,
        email: 'ca-customization-cert-postdeploy-template@example.invalid',
        templateFixtureRequest: { requestId: '00000000-0000-4000-8000-000000000088' },
      })
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json([{ id: 'owned-club', owner_id: USER_ID, name: 'Unexpected Real Club' }])
      );
    await expect(
      cleanupProductionE2EAccount({ environment: env, fetchImpl: fetchMock })
    ).rejects.toThrow('Refusing to retire unrecognized club');
    expect(existsSync(path)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/clubs?');
  });

  const LIGHTNING_UNION = 'fade0000-0000-0000-0000-000000000001';
  const lightningAccount = (directory: string) =>
    writeFileSync(
      join(directory, 'club-arena-production-e2e-account.json'),
      JSON.stringify({
        id: USER_ID,
        email: 'ca-customization-cert-postdeploy-lightning@example.invalid',
        password: 'unused',
      })
    );
  const adminRow = (clubId: string) => ({
    club_id: clubId,
    user_id: USER_ID,
    role: 'admin',
    status: 'active',
    chip_balance: 0,
  });
  /** Membership reads answer per club; the club read answers the scope. */
  const lightningFetch = (unionId: string | null, rows: Record<string, unknown[]>) =>
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/clubs?'))
        return Response.json([
          { id: DEFAULT_E2E_LIGHTNING_CLUB_ID, union_id: unionId, status: 'active' },
        ]);
      const club = /club_id=eq\.([0-9a-f-]{36})/.exec(url)?.[1] ?? '';
      return Response.json(rows[club] ?? []);
    });

  it('prepares Lightning independently of an invalid standalone template scope', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-lightning-'));
    const env = { ...environment(directory), E2E_TEMPLATE_CLUB_ID: 'not-standalone' };
    lightningAccount(directory);
    const row = adminRow(DEFAULT_E2E_LIGHTNING_CLUB_ID);
    const fetchMock = lightningFetch(null, { [DEFAULT_E2E_LIGHTNING_CLUB_ID]: [row] });
    await expect(
      prepareProductionE2ELightningMembership({ environment: env, fetchImpl: fetchMock })
    ).resolves.toEqual(row);
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls[0]).toContain(`club_id=eq.${DEFAULT_E2E_LIGHTNING_CLUB_ID}`);
    expect(urls.some((url) => url.includes('not-standalone'))).toBe(false);
    // A standalone club owns its games: no second membership is read or made.
    expect(urls.filter((url) => url.includes('/club_members?'))).toHaveLength(1);
  });

  it('also holds the reserved admin membership on the union that owns the games (#7884)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-lightning-union-'));
    const env = environment(directory);
    lightningAccount(directory);
    const fetchMock = lightningFetch(LIGHTNING_UNION, {
      [DEFAULT_E2E_LIGHTNING_CLUB_ID]: [adminRow(DEFAULT_E2E_LIGHTNING_CLUB_ID)],
      [LIGHTNING_UNION]: [adminRow(LIGHTNING_UNION)],
    });
    await expect(
      prepareProductionE2ELightningMembership({ environment: env, fetchImpl: fetchMock })
    ).resolves.toEqual(adminRow(DEFAULT_E2E_LIGHTNING_CLUB_ID));
    const memberships = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes('/club_members?'));
    expect(memberships).toHaveLength(2);
    expect(memberships[1]).toContain(`club_id=eq.${LIGHTNING_UNION}`);
  });

  it.each([{ chip_balance: 1 }, { role: 'player' }, { status: 'inactive' }, { user_id: 'other' }])(
    'never reuses a Lightning membership outside the exact zero-balance reserved admin shape: %j',
    async (difference) => {
      const directory = mkdtempSync(join(tmpdir(), 'production-e2e-lightning-refused-'));
      const env = environment(directory);
      lightningAccount(directory);
      const row = { ...adminRow(DEFAULT_E2E_LIGHTNING_CLUB_ID), ...difference };
      const fetchMock = lightningFetch(LIGHTNING_UNION, { [DEFAULT_E2E_LIGHTNING_CLUB_ID]: [row] });
      await expect(
        prepareProductionE2ELightningMembership({ environment: env, fetchImpl: fetchMock })
      ).rejects.toThrow('Refusing to change an existing');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it.each([{ chip_balance: 1 }, { role: 'player' }, { status: 'inactive' }])(
    'never reuses a union-owner membership outside the reserved admin shape: %j',
    async (difference) => {
      const directory = mkdtempSync(join(tmpdir(), 'production-e2e-lightning-union-refused-'));
      const env = environment(directory);
      lightningAccount(directory);
      const fetchMock = lightningFetch(LIGHTNING_UNION, {
        [DEFAULT_E2E_LIGHTNING_CLUB_ID]: [adminRow(DEFAULT_E2E_LIGHTNING_CLUB_ID)],
        [LIGHTNING_UNION]: [{ ...adminRow(LIGHTNING_UNION), ...difference }],
      });
      await expect(
        prepareProductionE2ELightningMembership({ environment: env, fetchImpl: fetchMock })
      ).rejects.toThrow('Refusing to change an existing');
    }
  );

  it('refuses a malformed union owner instead of guessing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-lightning-malformed-'));
    const env = environment(directory);
    lightningAccount(directory);
    const fetchMock = lightningFetch('not-a-club', {
      [DEFAULT_E2E_LIGHTNING_CLUB_ID]: [adminRow(DEFAULT_E2E_LIGHTNING_CLUB_ID)],
    });
    await expect(
      prepareProductionE2ELightningMembership({ environment: env, fetchImpl: fetchMock })
    ).rejects.toThrow('union owner is malformed');
  });

  it.each([
    [{ code: '57014', message: 'canceling statement due to statement timeout' }, true],
    [{ code: 'P0001', message: 'guard refused' }, false],
  ])('retries a timed-out membership promotion, never a refusal: %j', async (failure, retried) => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-promotion-retry-'));
    const env = { ...environment(directory), E2E_CLUB_ID: DEFAULT_E2E_LIGHTNING_CLUB_ID };
    writeFileSync(
      join(directory, 'club-arena-production-e2e-account.json'),
      JSON.stringify({
        id: USER_ID,
        email: 'ca-customization-cert-postdeploy-promotion@example.invalid',
        password: 'unused',
      })
    );
    const pending = {
      club_id: DEFAULT_E2E_LIGHTNING_CLUB_ID,
      user_id: USER_ID,
      role: 'player',
      status: 'pending',
      chip_balance: 0,
    };
    const admin = { ...pending, role: 'admin', status: 'active' };
    let reads = 0;
    let patches = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/auth/v1/token')) return Response.json({ access_token: 'token' });
      if (url.includes('/rpc/fn_join_club')) return Response.json({ ok: true });
      if (init?.method === 'PATCH') {
        patches += 1;
        return patches === 1 ? Response.json(failure, { status: 500 }) : Response.json([admin]);
      }
      reads += 1;
      return Response.json(reads === 1 ? [] : [pending]);
    });
    const run = prepareProductionE2EStaffMembership({
      environment: env,
      fetchImpl: fetchMock,
      wait: async () => {},
    });
    if (retried) {
      await expect(run).resolves.toEqual(admin);
      expect(patches).toBe(2);
    } else {
      await expect(run).rejects.toThrow('guard refused');
      expect(patches).toBe(1);
    }
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
      if (url.includes('/rest/v1/rpc/fn_ca_retire_welcome_certification_club')) {
        return Response.json({ success: true, chips_retired: 100000 });
      }
      return new Response('unexpected request', { status: 500 });
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      retireProductionCreateClubFixtures({ environment: env, fetchImpl: fetchMock })
    ).resolves.toBe(1);
    const retirement = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/rest/v1/rpc/fn_ca_retire_welcome_certification_club')
    );
    expect(JSON.parse(String(retirement?.[1]?.body))).toEqual({
      p_club_id: clubId,
      p_reason: 'ui-cert-cleanup',
    });
  });

  it('treats retirement as a no-op when provisioning never created a fixture record', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-no-create-club-'));
    const env = environment(directory);
    const fetchMock = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      retireProductionCreateClubFixtures({ environment: env, fetchImpl: fetchMock })
    ).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
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
      if (url.includes('/rest/v1/clubs?')) return Response.json([]);
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
    expect(JSON.parse(String(request[1]?.body))).toEqual({ p_before: '2026-09-04T21:23:00.000Z' });
  });

  it('keeps the ordinary job ceiling and grants only explicit natural observations their extra time', () => {
    expect(workflowJobBudget(POST_DEPLOY_WORKFLOW, 'live-table-e2e')).toEqual({
      ordinary: 121,
      optIn: 143,
    });
  });

  it('cannot classify an account stale while any fixture-owning job may still run', () => {
    const longestOwningJobMinutes = Math.max(
      workflowJobTimeoutMinutes(POST_DEPLOY_WORKFLOW, 'production-e2e'),
      workflowJobTimeoutMinutes(POST_DEPLOY_WORKFLOW, 'live-table-e2e'),
      workflowJobTimeoutMinutes(CLUB_CREATE_WORKFLOW, 'certify')
    );
    expect(STALE_ACCOUNT_AGE_MS).toBeGreaterThanOrEqual((longestOwningJobMinutes + 10) * 60_000);
    const live = workflowJobTimeoutMinutes(POST_DEPLOY_WORKFLOW, 'live-table-e2e');
    expect(STALE_ACCOUNT_AGE_MS).toBeGreaterThanOrEqual((live + 14) * 60_000);
  });

  it('waits out the maintenance freeze instead of abandoning the fixture', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-freeze-'));
    const env = environment(directory);
    const record = {
      id: USER_ID,
      email: 'ca-customization-cert-postdeploy-freeze@example.invalid',
    };
    let sweepAttempts = 0;
    let freezeReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/rpc/cleanup_reserved_certification_account')) {
        sweepAttempts += 1;
        return Response.json(
          sweepAttempts === 1 ? { success: false, reason: 'platform_is_frozen' } : { success: true }
        );
      }
      if (url.includes('/rest/v1/engine_maintenance_break')) {
        // The break row sizes the wait: this freeze has five minutes left to run.
        return Response.json([
          {
            phase: 'counting_down',
            break_started_at: new Date(Date.now() - 60_000).toISOString(),
            break_ends_at: new Date(Date.now() + 300_000).toISOString(),
            enforce_freeze: true,
          },
        ]);
      }
      if (url.includes('/rest/v1/rpc/fn_platform_frozen')) {
        freezeReads += 1;
        return Response.json(freezeReads === 1);
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
    // The freeze's own end condition released it, not a tick count.
    expect(freezeReads).toBe(2);
    expect(wait).toHaveBeenCalledWith(PLATFORM_FREEZE_POLL_MS);
    expect(wait).not.toHaveBeenCalledWith(10_000);
  });

  it('asks the cleanup door again after a lock timeout instead of leaking the identity (run 38770284952)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-lock-timeout-'));
    const env = environment(directory);
    const record = {
      id: USER_ID,
      email: 'ca-customization-cert-postdeploy-lock-timeout@example.invalid',
    };
    let sweepAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/rpc/cleanup_reserved_certification_account')) {
        sweepAttempts += 1;
        return sweepAttempts === 1
          ? Response.json(
              {
                code: '55P03',
                details: null,
                hint: null,
                message: 'canceling statement due to lock timeout',
              },
              { status: 500 }
            )
          : Response.json({ success: true, already_removed: false, user_id: USER_ID });
      }
      if (url.includes(`/auth/v1/admin/users/${USER_ID}`)) {
        return new Response(null, { status: 404 });
      }
      return new Response('unexpected request', { status: 500 });
    });
    const wait = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      cleanupProductionE2EAccount({ environment: env, fetchImpl: fetchMock, wait, record })
    ).resolves.toBe(true);
    expect(sweepAttempts).toBe(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('never asks the cleanup door again after a guard refusal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-guard-refusal-'));
    const env = environment(directory);
    const record = {
      id: USER_ID,
      email: 'ca-customization-cert-postdeploy-guard@example.invalid',
    };
    let sweepAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/rpc/cleanup_reserved_certification_account')) {
        sweepAttempts += 1;
        return Response.json(
          { code: '55000', message: 'CERTIFICATION_RETIREMENT_HAS_AUTHORITY_OR_CUSTODY' },
          { status: 500 }
        );
      }
      return new Response('unexpected request', { status: 500 });
    });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      cleanupProductionE2EAccount({ environment: env, fetchImpl: fetchMock, wait, record })
    ).rejects.toThrow(/CERTIFICATION_RETIREMENT_HAS_AUTHORITY_OR_CUSTODY/);
    expect(sweepAttempts).toBe(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('waits out the raised form of the freeze refusal too (run 38148991448)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-raised-freeze-'));
    const env = environment(directory);
    const record = {
      id: USER_ID,
      email: 'ca-customization-cert-postdeploy-raised@example.invalid',
    };
    let sweepAttempts = 0;
    let freezeReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/rpc/cleanup_reserved_certification_account')) {
        sweepAttempts += 1;
        return sweepAttempts === 1
          ? Response.json(
              {
                code: 'P0001',
                message:
                  'PLATFORM_FROZEN: the platform is on a scheduled maintenance break. DELETE on chip_transactions was refused; it will succeed when play resumes.',
              },
              { status: 400 }
            )
          : Response.json({ success: true });
      }
      if (url.includes('/rest/v1/engine_maintenance_break')) {
        return Response.json([
          {
            phase: 'counting_down',
            break_started_at: new Date(Date.now() - 60_000).toISOString(),
            break_ends_at: new Date(Date.now() + 300_000).toISOString(),
            enforce_freeze: true,
          },
        ]);
      }
      if (url.includes('/rest/v1/rpc/fn_platform_frozen')) {
        freezeReads += 1;
        return Response.json(freezeReads === 1);
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
    expect(freezeReads).toBe(2);
  });

  it('refuses honestly when the freeze outlives the budget the break row gave it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-account-frozen-'));
    const env = environment(directory);
    const record = {
      id: USER_ID,
      email: 'ca-customization-cert-postdeploy-stuck@example.invalid',
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/rpc/cleanup_reserved_certification_account')) {
        return Response.json({ success: false, reason: 'platform_is_frozen' });
      }
      if (url.includes('/rest/v1/engine_maintenance_break')) {
        return Response.json([{ phase: 'counting_down', break_ends_at: null }]);
      }
      if (url.includes('/rest/v1/rpc/fn_platform_frozen')) return Response.json(true);
      return new Response('unexpected request', { status: 500 });
    });
    const wait = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      cleanupProductionE2EAccount({ environment: env, fetchImpl: fetchMock, wait, record })
    ).rejects.toThrow(/platform_is_frozen; the platform freeze was still enforced/);
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

describe('certification-club retirement transport contract', () => {
  afterEach(() => vi.restoreAllMocks());

  const configuration = {
    supabaseUrl: 'https://certification.supabase.invalid',
    serviceRoleKey: 'sb_secret_certification',
  };
  const clubId = '11111111-1111-4111-8111-111111111111';
  const reason = 'ui-cert-cleanup';

  it('waits out a raised freeze refusal, then retires the fixture club (run 38161401967)', async () => {
    const frozen = Object.assign(
      new Error(
        'PLATFORM_FROZEN: the platform is on a scheduled maintenance break. DELETE on chip_transactions was refused; it will succeed when play resumes.'
      ),
      { code: 'P0001' }
    );
    const result = { success: true, chips_retired: 100000 };
    let doorCalls = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT public.fn_ca_retire_welcome_certification_club')) {
        doorCalls += 1;
        if (doorCalls === 1) throw frozen;
        return { rows: [{ result }] };
      }
      return { rows: [] };
    });
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      query,
      end: vi.fn().mockResolvedValue(undefined),
    };
    let freezeReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/engine_maintenance_break')) {
        return Response.json([
          {
            phase: 'counting_down',
            break_started_at: new Date(Date.now() - 60_000).toISOString(),
            break_ends_at: new Date(Date.now() + 300_000).toISOString(),
            enforce_freeze: true,
          },
        ]);
      }
      if (url.includes('/rest/v1/rpc/fn_platform_frozen')) {
        freezeReads += 1;
        return Response.json(freezeReads === 1);
      }
      return new Response('unexpected request', { status: 500 });
    });
    const wait = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      retireCertificationClubWithRetry({
        configuration,
        clubId,
        reason,
        environment: { DATABASE_URL: 'postgresql://certification.invalid/club_arena' },
        databaseClientFactory: vi.fn().mockResolvedValue(client),
        fetchImpl: fetchMock,
        wait,
      })
    ).resolves.toEqual(result);
    expect(doorCalls).toBe(2);
    expect(freezeReads).toBe(2);
    expect(wait).toHaveBeenCalledWith(PLATFORM_FREEZE_POLL_MS);
    // The refused attempt rolled back; only the second one committed.
    expect(query.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(1);
  });

  it('never waits on a refusal that is not the freeze', async () => {
    const failure = Object.assign(new Error('WELCOME_CERTIFICATION_FIXTURE_IS_PROTECTED'), {
      code: '55000',
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT')) throw failure;
      return { rows: [] };
    });
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      query,
      end: vi.fn().mockResolvedValue(undefined),
    };
    const fetchMock = vi.fn();
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      retireCertificationClubWithRetry({
        configuration,
        clubId,
        reason,
        environment: { DATABASE_URL: 'postgresql://certification.invalid/club_arena' },
        databaseClientFactory: vi.fn().mockResolvedValue(client),
        fetchImpl: fetchMock,
        wait,
      })
    ).rejects.toBe(failure);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('fn_platform_frozen'),
      expect.anything()
    );
  });

  it('uses one direct transaction with separate local settings before the retirement SELECT', async () => {
    const result = { success: true, chips_retired: 100000 };
    const query = vi.fn(async (sql: string) =>
      sql.startsWith('SELECT') ? { rows: [{ result }] } : { rows: [] }
    );
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      query,
      end: vi.fn().mockResolvedValue(undefined),
    };
    const databaseClientFactory = vi.fn().mockResolvedValue(client);
    const fetchMock = vi.fn();

    await expect(
      retireCertificationClubWithRetry({
        configuration,
        clubId,
        reason,
        environment: { DATABASE_URL: 'postgresql://certification.invalid/club_arena' },
        databaseClientFactory,
        fetchImpl: fetchMock,
      })
    ).resolves.toEqual(result);

    expect(databaseClientFactory).toHaveBeenCalledTimes(1);
    expect(databaseClientFactory).toHaveBeenCalledWith(
      'postgresql://certification.invalid/club_arena'
    );
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(query.mock.calls).toEqual([
      ['BEGIN'],
      ["SET LOCAL statement_timeout = '120s'"],
      ["SET LOCAL lock_timeout = '15s'"],
      ["SET LOCAL request.jwt.claim.role = 'service_role'"],
      ["SET LOCAL app.club_retirement_maintenance = 'on'"],
      [
        'SELECT public.fn_ca_retire_welcome_certification_club($1::uuid,$2::text) AS result',
        [clubId, reason],
      ],
      ['COMMIT'],
    ]);
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rolls back and closes the direct client when the retirement SELECT fails', async () => {
    const failure = Object.assign(new Error('retirement guard refused'), { code: '55000' });
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT')) throw failure;
      return { rows: [] };
    });
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      query,
      end: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      retireCertificationClubWithRetry({
        configuration,
        clubId,
        reason,
        environment: { DATABASE_URL: 'postgresql://certification.invalid/club_arena' },
        databaseClientFactory: vi.fn().mockResolvedValue(client),
        fetchImpl: vi.fn(),
      })
    ).rejects.toBe(failure);

    expect(query.mock.calls).toEqual([
      ['BEGIN'],
      ["SET LOCAL statement_timeout = '120s'"],
      ["SET LOCAL lock_timeout = '15s'"],
      ["SET LOCAL request.jwt.claim.role = 'service_role'"],
      ["SET LOCAL app.club_retirement_maintenance = 'on'"],
      [
        'SELECT public.fn_ca_retire_welcome_certification_club($1::uuid,$2::text) AS result',
        [clubId, reason],
      ],
      ['ROLLBACK'],
    ]);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('closes an empty leased opening table through the owner door, then retries the cleanup door once', async () => {
    const result = { success: true, chips_retired: 100000 };
    const tableId = '22222222-2222-4222-8222-222222222222';
    const ownerId = '33333333-3333-4333-8333-333333333333';
    const activity = Object.assign(new Error('WELCOME_CERTIFICATION_FIXTURE_HAS_ACTIVITY'), {
      code: '55000',
    });
    let doorCalls = 0;
    let leaseReads = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('fn_ca_retire_welcome_certification_club')) {
        doorCalls += 1;
        if (doorCalls === 1) throw activity;
        return { rows: [{ result }] };
      }
      if (sql.includes('FROM public.engine_table_leases')) {
        leaseReads += 1;
        return { rows: leaseReads === 1 ? [{ table_id: tableId, status: 'waiting' }] : [] };
      }
      if (sql.includes('SELECT owner_id::text')) return { rows: [{ owner_id: ownerId }] };
      if (sql.includes('fn_close_managed_game')) return { rows: [{ result: { ok: true } }] };
      return { rows: [] };
    });
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      query,
      end: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      retireCertificationClubWithRetry({
        configuration,
        clubId,
        reason,
        environment: { DATABASE_URL: 'postgresql://certification.invalid/club_arena' },
        databaseClientFactory: vi.fn().mockResolvedValue(client),
        fetchImpl: vi.fn(),
        wait: vi.fn().mockResolvedValue(undefined),
      })
    ).resolves.toEqual(result);

    const statements = query.mock.calls.map(([sql]) => String(sql));
    const firstDoor = statements.findIndex((sql) =>
      sql.includes('fn_ca_retire_welcome_certification_club')
    );
    const rollback = statements.indexOf('ROLLBACK', firstDoor);
    const close = statements.findIndex((sql) => sql.includes('fn_close_managed_game'));
    const claims = statements.findIndex((sql) => sql.includes("set_config('request.jwt.claims'"));
    const secondDoor = statements.findIndex(
      (sql, index) => index > close && sql.includes('fn_ca_retire_welcome_certification_club')
    );
    expect(firstDoor).toBeGreaterThan(-1);
    expect(rollback).toBeGreaterThan(firstDoor);
    expect(claims).toBeGreaterThan(rollback);
    expect(close).toBeGreaterThan(claims);
    expect(secondDoor).toBeGreaterThan(close);
    expect(
      query.mock.calls.find(([sql]) => String(sql).includes('fn_close_managed_game'))?.[1]
    ).toEqual([tableId]);
    expect(
      query.mock.calls.find(([sql]) => String(sql).includes("set_config('request.jwt.claims'"))?.[1]
    ).toEqual([JSON.stringify({ sub: ownerId, role: 'authenticated' }), ownerId]);
    expect(doorCalls).toBe(2);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('keeps the PostgREST retirement path when DATABASE_URL is absent', async () => {
    const result = { success: true, already_gone: true };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(result));
    const databaseClientFactory = vi.fn();

    await expect(
      retireCertificationClubWithRetry({
        configuration,
        clubId,
        reason,
        environment: {},
        databaseClientFactory,
        fetchImpl: fetchMock,
      })
    ).resolves.toEqual(result);

    expect(databaseClientFactory).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://certification.supabase.invalid/rest/v1/rpc/fn_ca_retire_welcome_certification_club',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ p_club_id: clubId, p_reason: reason }),
      })
    );
  });

  it('retries only after proving the package schedule has a fresh unmaterialized claim', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-03T06:00:00.000Z'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = { success: true, chips_retired: 100000 };
    const refusal = Object.assign(new Error('WELCOME_CERTIFICATION_TOURNAMENT_LINEAGE_REFUSED'), {
      code: '55000',
    });
    const client = (failure?: Error) => ({
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('fn_ca_retire_welcome_certification_club')) {
          if (failure) throw failure;
          return { rows: [{ result }] };
        }
        return { rows: [] };
      }),
      end: vi.fn().mockResolvedValue(undefined),
    });
    const firstClient = client(refusal);
    const secondClient = client();
    const databaseClientFactory = vi
      .fn()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/club_welcome_package_items?')) {
        expect(init?.method).toBeUndefined();
        expect(init?.body).toBeUndefined();
        return Response.json([{ entity_id: 'schedule-1' }]);
      }
      if (url.includes('/tournament_schedule_spawns?')) {
        expect(init?.method).toBeUndefined();
        expect(init?.body).toBeUndefined();
        return Response.json([{ id: 1, created_at: '2026-10-03T05:59:00.000Z' }]);
      }
      return new Response('unexpected request', { status: 500 });
    });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      retireCertificationClubWithRetry({
        configuration,
        clubId,
        reason,
        environment: { DATABASE_URL: 'postgresql://certification.invalid/club_arena' },
        databaseClientFactory,
        fetchImpl: fetchMock,
        wait,
      })
    ).resolves.toEqual(result);

    expect(databaseClientFactory).toHaveBeenCalledTimes(2);
    expect(firstClient.end).toHaveBeenCalledTimes(1);
    expect(secondClient.end).toHaveBeenCalledTimes(1);
    expect(wait.mock.calls).toEqual([[2_000]]);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes(
          'retired_at=is.null&entity_kind=eq.tournament_schedule&select=entity_id'
        )
      )
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes(
          'schedule_id=in.(schedule-1)&tournament_id=is.null&select=id,created_at'
        )
      )
    ).toBe(true);
  });

  it.each([
    ['55000', 'SOME_OTHER_55000'],
    ['23514', 'WELCOME_CERTIFICATION_TOURNAMENT_LINEAGE_REFUSED'],
  ])(
    'does not retry a retirement refusal unless both code and message match (%s)',
    async (code, message) => {
      const failure = Object.assign(new Error(message), { code });
      const query = vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT')) throw failure;
        return { rows: [] };
      });
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        query,
        end: vi.fn().mockResolvedValue(undefined),
      };
      const databaseClientFactory = vi.fn().mockResolvedValue(client);
      const fetchMock = vi.fn();
      const wait = vi.fn();

      await expect(
        retireCertificationClubWithRetry({
          configuration,
          clubId,
          reason,
          environment: { DATABASE_URL: 'postgresql://certification.invalid/club_arena' },
          databaseClientFactory,
          fetchImpl: fetchMock,
          wait,
        })
      ).rejects.toBe(failure);

      expect(databaseClientFactory).toHaveBeenCalledTimes(1);
      expect(wait).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('diagnoses a direct PostgreSQL lineage refusal without retrying when no fresh claim exists', async () => {
    const failure = Object.assign(new Error('WELCOME_CERTIFICATION_TOURNAMENT_LINEAGE_REFUSED'), {
      code: '55000',
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT')) throw failure;
      return { rows: [] };
    });
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      query,
      end: vi.fn().mockResolvedValue(undefined),
    };
    const databaseClientFactory = vi.fn().mockResolvedValue(client);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (
        url.includes('/club_welcome_package_items?') &&
        url.includes('entity_kind=eq.tournament_schedule')
      ) {
        return Response.json([{ entity_id: 'schedule-1' }]);
      }
      if (url.includes('/tournament_schedule_spawns?') && url.includes('tournament_id=is.null')) {
        return Response.json([]);
      }
      return Response.json([]);
    });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const wait = vi.fn();

    await expect(
      retireCertificationClubWithRetry({
        configuration,
        clubId,
        reason,
        environment: { DATABASE_URL: 'postgresql://certification.invalid/club_arena' },
        databaseClientFactory,
        fetchImpl: fetchMock,
        wait,
      })
    ).rejects.toBe(failure);

    expect(databaseClientFactory).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining('reserved fixture graph diagnostic')
    );
  });

  it('retries a lineage refusal while the fixture is still inside its seeding window, even with every spawn materialized (run 37791369175)', async () => {
    const createdAt = Date.parse('2026-10-08T14:20:38.660Z');
    vi.spyOn(Date, 'now').mockReturnValue(createdAt + 13_000);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = { success: true, chips_retired: 100000 };
    const refusal = Object.assign(new Error('WELCOME_CERTIFICATION_TOURNAMENT_LINEAGE_REFUSED'), {
      code: '55000',
    });
    const client = (failure?: Error) => ({
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('fn_ca_retire_welcome_certification_club')) {
          if (failure) throw failure;
          return { rows: [{ result }] };
        }
        return { rows: [] };
      }),
      end: vi.fn().mockResolvedValue(undefined),
    });
    const databaseClientFactory = vi
      .fn()
      .mockResolvedValueOnce(client(refusal))
      .mockResolvedValueOnce(client());
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/club_welcome_package_items?')) {
        return Response.json([{ entity_id: 'schedule-1' }]);
      }
      if (url.includes('/tournament_schedule_spawns?')) return Response.json([]);
      if (url.includes('/rest/v1/clubs?') && url.includes('select=created_at')) {
        return Response.json([{ created_at: new Date(createdAt).toISOString() }]);
      }
      return new Response('unexpected request', { status: 500 });
    });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      retireCertificationClubWithRetry({
        configuration,
        clubId,
        reason,
        environment: { DATABASE_URL: 'postgresql://certification.invalid/club_arena' },
        databaseClientFactory,
        fetchImpl: fetchMock,
        wait,
      })
    ).resolves.toEqual(result);
    expect(databaseClientFactory).toHaveBeenCalledTimes(2);
    expect(wait.mock.calls).toEqual([[2_000]]);
  });

  it('takes a lineage refusal as final once the fixture is past its seeding window', async () => {
    const createdAt = Date.parse('2026-10-08T14:20:38.660Z');
    vi.spyOn(Date, 'now').mockReturnValue(createdAt + 11 * 60_000);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refusal = Object.assign(new Error('WELCOME_CERTIFICATION_TOURNAMENT_LINEAGE_REFUSED'), {
      code: '55000',
    });
    const databaseClientFactory = vi.fn().mockResolvedValue({
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('fn_ca_retire_welcome_certification_club')) throw refusal;
        return { rows: [] };
      }),
      end: vi.fn().mockResolvedValue(undefined),
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/clubs?') && url.includes('select=created_at')) {
        return Response.json([{ created_at: new Date(createdAt).toISOString() }]);
      }
      return Response.json([]);
    });
    const wait = vi.fn();
    await expect(
      retireCertificationClubWithRetry({
        configuration,
        clubId,
        reason,
        environment: { DATABASE_URL: 'postgresql://certification.invalid/club_arena' },
        databaseClientFactory,
        fetchImpl: fetchMock,
        wait,
      })
    ).rejects.toBe(refusal);
    expect(wait).not.toHaveBeenCalled();
  });
});

describe('a certification fixture that leaked must not wedge the next certificate (2026-09-28)', () => {
  afterEach(() => vi.restoreAllMocks());

  const STALE_EMAIL = 'ca-customization-cert-postdeploy-direct-stale@example.invalid';
  const STALE = { id: USER_ID, email: STALE_EMAIL, created_at: '2026-01-01T00:00:00.000Z' };
  const NOW = Date.parse('2026-09-05T00:00:00.000Z');
  const STATEMENT_TIMEOUT = {
    code: '57014',
    message: 'canceling statement due to statement timeout',
  };
  // The real refusal: PostgREST answers 500 for the guard's RAISE (SQLSTATE 55000).
  const HAS_CUSTODY = {
    code: '55000',
    message: 'CERTIFICATION_RETIREMENT_HAS_AUTHORITY_OR_CUSTODY',
  };

  /**
   * A model of production: the stale sweep refuses while the identity still
   * owns a club, the retire door retires a club (or replays as already_gone),
   * and every request is recorded in order.
   */
  function world(
    clubs: Array<{ id: string; name: string }>,
    retireBehaviour: (call: number, clubId: string) => Response = () =>
      Response.json({ success: true, chips_retired: 100000 })
  ) {
    const owned = new Map(clubs.map((club) => [club.id, club]));
    const calls: string[] = [];
    const retireBodies: unknown[] = [];
    let retireCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rpc/fn_ca_stale_certification_accounts')) {
        calls.push('stale-inventory');
        return Response.json([STALE]);
      }
      if (url.includes('/rest/v1/clubs?')) {
        calls.push('clubs-read');
        return Response.json([...owned.values()].map((club) => ({ ...club, owner_id: USER_ID })));
      }
      if (url.includes('/rpc/fn_ca_retire_welcome_certification_club')) {
        calls.push('retire');
        const body = JSON.parse(String(init?.body));
        retireBodies.push(body);
        retireCalls += 1;
        const response = retireBehaviour(retireCalls, body.p_club_id);
        if (response.ok) {
          const parsed = await response.clone().json();
          if (parsed?.success === true) owned.delete(body.p_club_id);
        }
        return response;
      }
      if (url.includes('/rpc/cleanup_reserved_certification_account')) {
        calls.push('account-sweep');
        return owned.size
          ? Response.json(HAS_CUSTODY, { status: 500 })
          : Response.json({ success: true });
      }
      if (url.includes(`/auth/v1/admin/users/${USER_ID}`))
        return new Response(null, { status: 404 });
      return new Response('unexpected request ' + url, { status: 500 });
    });
    return { fetchImpl, calls, retireBodies, retireCallCount: () => retireCalls };
  }

  function stale(fetchImpl: unknown, wait = vi.fn().mockResolvedValue(undefined)) {
    return {
      wait,
      run: () =>
        cleanupStaleProductionE2EAccounts({
          environment: environment(mkdtempSync(join(tmpdir(), 'production-e2e-leaked-'))),
          fetchImpl: fetchImpl as typeof fetch,
          now: NOW,
          wait,
        }),
    };
  }

  it.each(['Crest Cert 1790000000000-abc', 'Preset Crest Cert 1790000000000'])(
    'recovers a stale identity that still owns the certification club %s, retiring it before the sweep',
    async (name) => {
      const model = world([{ id: '11111111-1111-4111-8111-111111111111', name }]);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await expect(stale(model.fetchImpl).run()).resolves.toBe(1);

      expect(model.calls).toEqual([
        'stale-inventory',
        'clubs-read',
        'retire',
        'clubs-read',
        'account-sweep',
      ]);
      expect(model.retireBodies).toEqual([
        { p_club_id: '11111111-1111-4111-8111-111111111111', p_reason: 'stale-cert-recovery' },
      ]);
    }
  );

  it('recovers both fixture clubs of a run that died between creating and retiring them', async () => {
    const model = world([
      { id: '11111111-1111-4111-8111-111111111111', name: 'Crest Cert 1790000000000-abc' },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Preset Crest Cert 1790000000000' },
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(stale(model.fetchImpl).run()).resolves.toBe(1);
    expect(model.retireCallCount()).toBe(2);
    expect(model.calls.at(-1)).toBe('account-sweep');
  });

  it('still refuses a stale identity that owns a club outside the fixture prefixes, and retires nothing', async () => {
    const model = world([
      { id: '11111111-1111-4111-8111-111111111111', name: 'Crest Cert 1790000000000-abc' },
      { id: '33333333-3333-4333-8333-333333333333', name: 'Real Player Club' },
    ]);

    await expect(stale(model.fetchImpl).run()).rejects.toThrow(
      'Refusing to retire unrecognized club 33333333-3333-4333-8333-333333333333'
    );

    // Neither the recognized club nor the identity was touched: the whole batch
    // is validated before the first retirement, and the sweep never ran.
    expect(model.calls).toEqual(['stale-inventory', 'clubs-read']);
    expect(model.retireCallCount()).toBe(0);
  });

  it('refuses a name that merely contains the prefix', async () => {
    const model = world([
      { id: '44444444-4444-4444-8444-444444444444', name: 'My Crest Cert Club' },
    ]);
    await expect(stale(model.fetchImpl).run()).rejects.toThrow('unrecognized club');
    expect(model.retireCallCount()).toBe(0);
  });

  it('retries a statement timeout with backoff and then succeeds', async () => {
    const model = world(
      [{ id: '11111111-1111-4111-8111-111111111111', name: 'Crest Cert 1790000000000-abc' }],
      (call) =>
        call <= 2
          ? Response.json(STATEMENT_TIMEOUT, { status: 500 })
          : Response.json({ success: true, chips_retired: 100000 })
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const run = stale(model.fetchImpl);

    await expect(run.run()).resolves.toBe(1);

    expect(model.retireCallCount()).toBe(3);
    expect(run.wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([2_000, 4_000]);
    expect(model.calls.at(-1)).toBe('account-sweep');
  });

  it('gives up loudly after the bounded attempts, never passing on a database that keeps timing out', async () => {
    const model = world(
      [{ id: '11111111-1111-4111-8111-111111111111', name: 'Crest Cert 1790000000000-abc' }],
      () => Response.json(STATEMENT_TIMEOUT, { status: 500 })
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(stale(model.fetchImpl).run()).rejects.toThrow(/statement timeout/);
    expect(model.retireCallCount()).toBe(5);
    expect(model.calls).not.toContain('account-sweep');
  });

  it('does not retry a definitive refusal from the door', async () => {
    const model = world(
      [{ id: '11111111-1111-4111-8111-111111111111', name: 'Crest Cert 1790000000000-abc' }],
      () => Response.json({ success: false, error: 'this club has played: it is not a fixture' })
    );
    const run = stale(model.fetchImpl);

    await expect(run.run()).rejects.toThrow('retirement was refused: this club has played');
    expect(model.retireCallCount()).toBe(1);
    expect(run.wait).not.toHaveBeenCalled();
    expect(model.calls).not.toContain('account-sweep');
  });

  it('does not retry a guard that speaks through an HTTP 500 with an application SQLSTATE', async () => {
    const model = world(
      [{ id: '11111111-1111-4111-8111-111111111111', name: 'Crest Cert 1790000000000-abc' }],
      () => Response.json(HAS_CUSTODY, { status: 500 })
    );
    const run = stale(model.fetchImpl);

    await expect(run.run()).rejects.toThrow(/55000/);
    expect(model.retireCallCount()).toBe(1);
    expect(run.wait).not.toHaveBeenCalled();
  });

  it.each([
    'WELCOME_CERTIFICATION_HAS_NONPACKAGE_GAMES',
    'WELCOME_CERTIFICATION_TOURNAMENT_LINEAGE_REFUSED',
  ])('prints only the reserved fixture graph when %s refuses cleanup', async (message) => {
    const clubId = '11111111-1111-4111-8111-111111111111';
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-graph-diagnostic-'));
    const env = environment(directory);
    writeFileSync(
      join(directory, 'club-arena-production-e2e-account.json'),
      JSON.stringify({ id: USER_ID, email: STALE_EMAIL })
    );
    const errorBody = {
      code: '55000',
      message,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/clubs?')) {
        return Response.json([
          { id: clubId, name: 'Crest Cert 1790000000000-abc', owner_id: USER_ID },
        ]);
      }
      if (url.includes('/rpc/fn_ca_retire_welcome_certification_club')) {
        return Response.json(errorBody, { status: 500 });
      }
      if (url.includes('/club_welcome_package_items?')) {
        return Response.json([
          { slot_key: 'nlh6', entity_kind: 'cash_game', entity_id: 'cash-1' },
          {
            slot_key: 'daily',
            entity_kind: 'tournament_schedule',
            entity_id: 'schedule-1',
          },
        ]);
      }
      if (url.includes('/cash_games?')) return Response.json([{ id: 'cash-1' }]);
      if (url.includes('/tournament_schedules?')) return Response.json([{ id: 'schedule-1' }]);
      if (url.includes('/tables?club_id=')) {
        return Response.json([{ id: 'table-1', role: 'unexpected' }]);
      }
      if (url.includes('/tables?cluster_id=')) {
        return Response.json([{ id: 'table-foreign', club_id: 'foreign-club' }]);
      }
      if (url.includes('/tournaments?club_id=')) {
        return Response.json([{ id: 'tournament-club', schedule_id: null }]);
      }
      if (url.includes('/tournaments?schedule_id=')) {
        return Response.json([{ id: 'tournament-schedule', schedule_id: 'schedule-1' }]);
      }
      if (url.includes('/tournament_schedule_spawns?')) {
        return Response.json([
          { id: 1, schedule_id: 'schedule-1', tournament_id: 'tournament-foreign' },
        ]);
      }
      if (url.includes('/tournaments?id=')) {
        return Response.json([
          {
            id: 'tournament-foreign',
            club_id: 'foreign-club',
            schedule_id: 'foreign-schedule',
          },
        ]);
      }
      return new Response('unexpected request', { status: 500 });
    });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      retireProductionCreateClubFixtures({ environment: env, fetchImpl: fetchMock })
    ).rejects.toThrow(new RegExp(message));

    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining('reserved fixture graph diagnostic')
    );
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('"role":"unexpected"'));
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('"id":"table-foreign"'));
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('"id":"tournament-club"'));
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining('"id":"tournament-foreign","club_id":"foreign-club"')
    );
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/rpc/fn_ca_retire_welcome_certification_club')
      )
    ).toHaveLength(1);
  });

  it('treats a replayed retirement as success (the door answers already_gone)', async () => {
    const model = world(
      [{ id: '11111111-1111-4111-8111-111111111111', name: 'Crest Cert 1790000000000-abc' }],
      (call) =>
        call === 1
          ? Response.json(STATEMENT_TIMEOUT, { status: 500 })
          : Response.json({ success: true, already_gone: true })
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(stale(model.fetchImpl).run()).resolves.toBe(1);
    expect(model.retireCallCount()).toBe(2);
  });

  it('retries a statement timeout in the per-run retirement too, keeping its own reason', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-e2e-run-retire-'));
    const env = environment(directory);
    writeFileSync(
      join(directory, 'club-arena-production-e2e-account.json'),
      JSON.stringify({ id: USER_ID, email: STALE_EMAIL })
    );
    const model = world(
      [{ id: '11111111-1111-4111-8111-111111111111', name: 'Crest Cert 1790000000000-abc' }],
      (call) =>
        call === 1
          ? Response.json(STATEMENT_TIMEOUT, { status: 500 })
          : Response.json({ success: true })
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      retireProductionCreateClubFixtures({ environment: env, fetchImpl: model.fetchImpl, wait })
    ).resolves.toBe(1);
    expect(model.retireBodies).toEqual([
      { p_club_id: '11111111-1111-4111-8111-111111111111', p_reason: 'ui-cert-cleanup' },
      { p_club_id: '11111111-1111-4111-8111-111111111111', p_reason: 'ui-cert-cleanup' },
    ]);
  });

  it('refuses an explicit record outside the reserved namespace without a request', async () => {
    const fetchMock = vi.fn();
    await expect(
      retireProductionCreateClubFixtures({
        environment: environment(mkdtempSync(join(tmpdir(), 'production-e2e-outside-'))),
        fetchImpl: fetchMock,
        record: { id: USER_ID, email: 'real-player@example.com' },
      })
    ).rejects.toThrow('outside the reserved post-deploy namespace');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails when the owned-club readback is unreadable instead of reading it as empty', async () => {
    let reads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/clubs?')) {
        reads += 1;
        return reads === 1
          ? Response.json([
              {
                id: '11111111-1111-4111-8111-111111111111',
                name: 'Crest Cert 1',
                owner_id: USER_ID,
              },
            ])
          : Response.json({ message: 'unreadable' });
      }
      return Response.json({ success: true });
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(
      retireProductionCreateClubFixtures({
        environment: environment(mkdtempSync(join(tmpdir(), 'production-e2e-unreadable-'))),
        fetchImpl: fetchMock,
        record: { id: USER_ID, email: STALE_EMAIL },
      })
    ).rejects.toThrow('unreadable number of owned club fixture');
  });
});

describe('one refused stale identity no longer strands the others (2026-10-26)', () => {
  afterEach(() => vi.restoreAllMocks());

  const NOW = Date.parse('2026-10-26T14:00:00.000Z');
  const account = (n: number) => ({
    id: `00000000-0000-4000-8000-00000000010${n}`,
    email: `ca-customization-cert-postdeploy-179277923823${n}-stale@example.invalid`,
    created_at: `2026-10-2${n}T18:14:22.000Z`,
  });
  type Club = { id: string; name: string; owner_id: string; lifecycle_status: string };

  /**
   * Production as it stood on 2026-10-26: several stale identities, each
   * owning Crest Cert clubs. The retire door answers per club, the account
   * door refuses any identity that still owns a club, and every request is
   * recorded so the order of work can be read back.
   */
  function world(
    accounts: Array<ReturnType<typeof account>>,
    clubs: Club[],
    door: (clubId: string) => Response
  ) {
    const owned = new Map(clubs.map((club) => [club.id, club]));
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = decodeURIComponent(String(input));
      if (url.includes('/rpc/fn_ca_stale_certification_accounts')) return Response.json(accounts);
      if (url.includes('/rest/v1/clubs?')) {
        const owner = /owner_id=eq\.([0-9a-f-]+)/.exec(url)?.[1];
        return Response.json([...owned.values()].filter((club) => club.owner_id === owner));
      }
      if (url.includes('/rpc/fn_ca_retire_welcome_certification_club')) {
        const clubId = JSON.parse(String(init?.body)).p_club_id;
        calls.push(`retire ${clubId}`);
        const response = door(clubId);
        const parsed = await response.clone().json();
        if (response.ok && parsed?.success === true) owned.delete(clubId);
        return response;
      }
      if (url.includes('/rpc/cleanup_reserved_certification_account')) {
        const userId = JSON.parse(String(init?.body)).p_user_id;
        calls.push(`account ${userId}`);
        return [...owned.values()].some((club) => club.owner_id === userId)
          ? Response.json(
              { code: '55000', message: 'CERTIFICATION_RETIREMENT_HAS_AUTHORITY_OR_CUSTODY' },
              { status: 500 }
            )
          : Response.json({ success: true });
      }
      if (url.includes('/auth/v1/admin/users/')) return new Response(null, { status: 404 });
      return new Response('unexpected request ' + url, { status: 500 });
    });
    return { fetchImpl, calls, owned };
  }

  const run = (fetchImpl: unknown) =>
    cleanupStaleProductionE2EAccounts({
      environment: environment(mkdtempSync(join(tmpdir(), 'production-e2e-stranded-'))),
      fetchImpl: fetchImpl as typeof fetch,
      now: NOW,
      wait: vi.fn().mockResolvedValue(undefined),
    });

  const LOBBY = '11111111-1111-4111-8111-111111111111';
  const TEMPLATE_A = '22222222-2222-4222-8222-222222222222';
  const TEMPLATE_B = '33333333-3333-4333-8333-333333333333';
  const history = () =>
    Response.json({ success: false, error: RETIREMENT_REFUSAL_CLUB_HAS_HISTORY });
  const retired = () => Response.json({ success: true, chips_retired: 100000 });

  it('keeps a retired fixture that holds history as owned, names it, and still recovers the identities behind it', async () => {
    const [lobbyOwner, ownerA, ownerB] = [account(3), account(4), account(5)];
    const model = world(
      [lobbyOwner, ownerA, ownerB],
      [
        {
          id: LOBBY,
          name: 'Crest Cert Lobby 01a16659',
          owner_id: lobbyOwner.id,
          lifecycle_status: 'retired',
        },
        {
          id: TEMPLATE_A,
          name: 'Crest Cert Template 2793e75d',
          owner_id: ownerA.id,
          lifecycle_status: 'active',
        },
        {
          id: TEMPLATE_B,
          name: 'Crest Cert Template 095896f4',
          owner_id: ownerB.id,
          lifecycle_status: 'active',
        },
      ],
      (clubId) => (clubId === LOBBY ? history() : retired())
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(run(model.fetchImpl)).resolves.toBe(2);

    expect(model.calls).toEqual([
      `retire ${LOBBY}`,
      `retire ${TEMPLATE_A}`,
      `account ${ownerA.id}`,
      `retire ${TEMPLATE_B}`,
      `account ${ownerB.id}`,
    ]);
    // The identity that owns the retired history is never sent to the account door.
    expect(model.calls).not.toContain(`account ${lobbyOwner.id}`);
    expect([...model.owned.keys()]).toEqual([LOBBY]);
    expect(log.mock.calls.flat().join('\n')).toContain(
      `kept stale identity ${lobbyOwner.id} as the owner of record of retired fixture(s) ${LOBBY}`
    );
  });

  it('still fails the run for a club with history that has NOT left the live board', async () => {
    const owner = account(3);
    const model = world(
      [owner],
      [
        {
          id: LOBBY,
          name: 'Crest Cert Lobby 01a16659',
          owner_id: owner.id,
          lifecycle_status: 'active',
        },
      ],
      history
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(run(model.fetchImpl)).rejects.toThrow(
      `Certification club ${LOBBY} retirement was refused: ${RETIREMENT_REFUSAL_CLUB_HAS_HISTORY}`
    );
    expect(model.calls).toEqual([`retire ${LOBBY}`]);
  });

  it('tries every identity after one fails, then fails the run naming the failure', async () => {
    const [stuck, behind] = [account(3), account(4)];
    const model = world(
      [stuck, behind],
      [
        {
          id: LOBBY,
          name: 'Crest Cert Template aaaaaaaa',
          owner_id: stuck.id,
          lifecycle_status: 'active',
        },
        {
          id: TEMPLATE_A,
          name: 'Crest Cert Template 2793e75d',
          owner_id: behind.id,
          lifecycle_status: 'active',
        },
      ],
      (clubId) =>
        clubId === LOBBY
          ? Response.json({ success: false, error: 'some other refusal' })
          : retired()
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const outcome = run(model.fetchImpl);
    await expect(outcome).rejects.toBeInstanceOf(AggregateError);
    await expect(outcome).rejects.toThrow(
      `Stale recovery left 1 of 2 stale account(s) unrecovered (1 recovered, 0 kept as owners of retired history): ` +
        `Certification club ${LOBBY} retirement was refused: some other refusal`
    );
    // The identity behind the refusal was still recovered in the same run.
    expect(model.calls).toEqual([
      `retire ${LOBBY}`,
      `retire ${TEMPLATE_A}`,
      `account ${behind.id}`,
    ]);
  });

  it('validates the whole inventory before touching any identity', async () => {
    const good = account(3);
    const model = world(
      [good, { ...account(4), email: 'someone@example.com' }],
      [
        {
          id: LOBBY,
          name: 'Crest Cert Template aaaaaaaa',
          owner_id: good.id,
          lifecycle_status: 'active',
        },
      ],
      retired
    );
    await expect(run(model.fetchImpl)).rejects.toThrow(
      'Refusing an invalid stale post-deploy account candidate.'
    );
    expect(model.calls).toEqual([]);
  });
});
