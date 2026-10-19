import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { retireReservedCertificationAccount } from '../../scripts/ci/retire-reserved-certification-account.mjs';

const read = (path: string) => readFileSync(path, 'utf8');
const directory = 'supabase/migrations';
const migration = read(
  `${directory}/${readdirSync(directory).find((name) =>
    name.endsWith('_reserved_protected_ledger_actors_reach_auth_retirement.sql')
  )}`
);
const after = read(
  'scripts/ci/fixtures/certification-retirement/protected-ledger-cleanup-after.sql'
);
const id = '00000000-0000-4000-8000-000000000095';
const email = 'ca-customization-cert-postdeploy-owned@example.invalid';
// An identity older than the longest certificate that may own it (112 minutes).
const finished = '2026-10-19T12:00:00.000Z';

describe('reserved protected ledger actors reach supported Auth retirement', () => {
  it('qualifies immutable source, authority and protected triggers before installation', () => {
    expect(migration).toContain('f99b95d79a0e9bf05715ed5279e705ac');
    expect(migration).toContain('07419c2062fbff02d3ee7d3c24cd8ea9');
    expect(migration).toContain('CERTIFICATION_PROTECTED_LEDGER_PREIMAGE_CHANGED');
    expect(migration).toContain('CERTIFICATION_PROTECTED_LEDGER_READBACK_CHANGED');
    expect(migration).toContain("has_function_privilege('authenticated',v_target,'EXECUTE')");
    expect(migration).toContain('trg_deep_stack_members_are_protected');
  });
  it('admits only historical actors and keeps directly linked custody refused', () => {
    const gate = after.split('CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY')[0];
    expect(gate).not.toContain('WHERE performed_by = p_user_id');
    expect(gate).toContain('WHERE from_entity_id = p_user_id');
    expect(gate).toContain('WHERE to_entity_id = p_user_id');
    expect(gate).toContain('accounting_cash_rake_sources WHERE player_id = p_user_id');
    for (const column of ['held_chips', 'locked_chips', 'credit_used', 'credit_limit']) {
      expect(gate).toContain(`${column} IS DISTINCT FROM 0`);
    }
    expect(gate).toContain('agent_id IS NOT NULL OR parent_agent_id IS NOT NULL');
    expect(after.indexOf('fn_club_membership_lock(p_user_id)')).toBeLessThan(
      after.indexOf('SELECT email INTO v_email')
    );
    expect(after.indexOf('public.wallets WHERE user_id = p_user_id ORDER BY id')).toBeLessThan(
      after.indexOf('public.club_members WHERE user_id = p_user_id ORDER BY club_id')
    );
    expect(after).toContain("'auth_soft_delete_required'");
    expect(after).toContain("'retained_ledger_actor'");
  });
  it('executes native fail-before/pass-after through the maintained required workflow', () => {
    expect(read('.github/workflows/ci.yml')).toContain(
      'run: python3 scripts/ci/test-certification-retirement-postgres.py'
    );
    expect(read('scripts/ci/test-certification-retirement-postgres.py')).toContain(
      "FIXTURE/'qualify-protected-ledger.py'"
    );
    const native = read('scripts/ci/fixtures/certification-retirement/qualify-protected-ledger.py');
    expect(native).toContain('protected-ledger-fail-before-reproduced');
    expect(native).toContain(
      'protected-ledger-pass-after-immutable-auth-retirement-acceptance-passed'
    );
    expect(native).toContain('assert ledger() == immutable and catalog() == meta');
  });
  it('uses one explicit default-branch cleanup job without creating fixtures', () => {
    const workflow = read('.github/workflows/club-create-certification.yml');
    const job = workflow.split('  retire-reserved-account:')[1].split('  certify:')[0];
    expect(job).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(job).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(job).toContain('RESERVED_CERTIFICATION_ACCOUNT_ID: ${{ inputs.reserved_account_id }}');
    expect(job).toContain(
      'RESERVED_CERTIFICATION_ACCOUNT_EMAIL: ${{ inputs.reserved_account_email }}'
    );
    expect(job).toContain('node scripts/ci/retire-reserved-certification-account.mjs');
    expect(job).not.toMatch(/playwright|production-e2e-account\.mjs create|stale/);
    expect(job).toContain(
      "if: inputs.reserved_template_request_id != '' || inputs.reserved_template_club_id != ''"
    );
    expect(job).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    expect(workflow).toContain('cancel-in-progress: false');
  });
  it.each([
    ['', email],
    [id, 'person@example.com'],
    [id, 'club-create-cert-x@smarter-poker.invalid'],
    [`${id};injection`, email],
    [`${id}\n`, email],
    [id, `${email}\nsecond`],
    [id, `${email}\n`],
  ])('refuses invalid exact identity without any cleanup call', async (accountId, accountEmail) => {
    const cleanup = vi.fn();
    await expect(
      retireReservedCertificationAccount({
        environment: {
          RESERVED_CERTIFICATION_ACCOUNT_ID: accountId,
          RESERVED_CERTIFICATION_ACCOUNT_EMAIL: accountEmail,
        },
        cleanup,
      })
    ).rejects.toThrow('Exactly One Reserved');
    expect(cleanup).not.toHaveBeenCalled();
  });
  it('delegates the exact account and requires verified completion', async () => {
    const environment = {
      RESERVED_CERTIFICATION_ACCOUNT_ID: id,
      RESERVED_CERTIFICATION_ACCOUNT_EMAIL: email,
      SUPABASE_URL: 'https://isolated.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ status: 200, json: async () => ({ id, email, created_at: finished }) });
    const cleanup = vi.fn().mockResolvedValue(true);
    await expect(
      retireReservedCertificationAccount({ environment, fetchImpl, cleanup })
    ).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith({
      environment,
      fetchImpl,
      record: { id, email },
    });
    cleanup.mockResolvedValue(false);
    await expect(
      retireReservedCertificationAccount({ environment, fetchImpl, cleanup })
    ).rejects.toThrow('Was Not Retired');
    cleanup.mockClear();
    fetchImpl.mockResolvedValue({
      status: 200,
      json: async () => ({ id, email: 'different@example.invalid' }),
    });
    await expect(
      retireReservedCertificationAccount({ environment, fetchImpl, cleanup })
    ).rejects.toThrow('Do Not Match Auth');
    expect(cleanup).not.toHaveBeenCalled();
  });
  it('verifies a selected template receipt before passing its durable record to cleanup', async () => {
    const requestId = '11111111-1111-4111-8111-111111111111';
    const clubId = '22222222-2222-4222-8222-222222222222';
    const environment = {
      RESERVED_CERTIFICATION_ACCOUNT_ID: id,
      RESERVED_CERTIFICATION_ACCOUNT_EMAIL: email,
      RESERVED_CERTIFICATION_TEMPLATE_REQUEST_ID: requestId,
      RESERVED_CERTIFICATION_TEMPLATE_CLUB_ID: clubId,
      SUPABASE_URL: 'https://isolated.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
      DATABASE_URL: 'configured-runtime-only',
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ id, email, created_at: finished }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => [{ user_id: id, request_id: requestId, club_id: clubId }],
      });
    const cleanup = vi.fn().mockResolvedValue(true);
    await expect(
      retireReservedCertificationAccount({ environment, fetchImpl, cleanup })
    ).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledWith({
      environment,
      fetchImpl,
      record: { id, email, templateFixtureRequest: { requestId, clubId } },
    });
    expect(String(fetchImpl.mock.calls[1][0])).toContain('club_creation_requests?');
  });

  it.each(['missing', 'wrong', 'unreadable'])(
    'refuses a %s template receipt before any retirement',
    async (kind) => {
      const environment = {
        RESERVED_CERTIFICATION_ACCOUNT_ID: id,
        RESERVED_CERTIFICATION_ACCOUNT_EMAIL: email,
        RESERVED_CERTIFICATION_TEMPLATE_REQUEST_ID: '11111111-1111-4111-8111-111111111111',
        RESERVED_CERTIFICATION_TEMPLATE_CLUB_ID: '22222222-2222-4222-8222-222222222222',
        SUPABASE_URL: 'https://isolated.invalid',
        SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
        DATABASE_URL: 'configured-runtime-only',
      };
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce({ status: 200, json: async () => ({ id, email }) })
        .mockResolvedValueOnce({
          status: kind === 'unreadable' ? 503 : 200,
          json: async () =>
            kind === 'missing'
              ? []
              : [
                  {
                    user_id: id,
                    request_id: environment.RESERVED_CERTIFICATION_TEMPLATE_REQUEST_ID,
                    club_id: 'wrong',
                  },
                ],
        });
      const cleanup = vi.fn();
      await expect(
        retireReservedCertificationAccount({ environment, fetchImpl, cleanup })
      ).rejects.toThrow('Template Creation Receipt');
      expect(cleanup).not.toHaveBeenCalled();
    }
  );
  it.each(['', 'configured-runtime-only'])(
    'replays retired template identity through actual guarded terminal readback with DB %s',
    async (databaseUrl) => {
      const environment = {
        RESERVED_CERTIFICATION_ACCOUNT_ID: id,
        RESERVED_CERTIFICATION_ACCOUNT_EMAIL: email,
        RESERVED_CERTIFICATION_TEMPLATE_REQUEST_ID: '11111111-1111-4111-8111-111111111111',
        RESERVED_CERTIFICATION_TEMPLATE_CLUB_ID: '22222222-2222-4222-8222-222222222222',
        SUPABASE_URL: 'https://isolated.invalid',
        SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
        DATABASE_URL: databaseUrl,
      };
      const calls: Array<{ url: string; method: string }> = [];
      const fetchImpl = vi.fn(async (url: string, options: any = {}) => {
        calls.push({ url, method: options.method || 'GET' });
        if (url.includes('/auth/v1/admin/users/'))
          return new Response(JSON.stringify({ id, deleted_at: '2026-10-13T21:02:06Z' }), {
            status: 200,
          });
        if (url.endsWith('/rpc/cleanup_reserved_certification_account'))
          return new Response(
            JSON.stringify({ success: true, disposition: 'retained_ledger_actor', user_id: id }),
            { status: 200 }
          );
        if (url.includes('club_creation_requests')) return new Response('[]', { status: 200 });
        throw new Error('Obsolete receipt or fixture request attempted');
      });
      await expect(retireReservedCertificationAccount({ environment, fetchImpl })).resolves.toBe(
        true
      );
      expect(calls).toHaveLength(3);
      expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET']);
      expect(calls[1].url).toContain('cleanup_reserved_certification_account');
      expect(
        calls.some((call) =>
          /club_creation_requests|rest\/v1\/clubs|DELETE/.test(call.url + call.method)
        )
      ).toBe(false);
    }
  );
  it('still refuses malformed optional template IDs for an already retired identity', async () => {
    const cleanup = vi.fn();
    await expect(
      retireReservedCertificationAccount({
        environment: {
          RESERVED_CERTIFICATION_ACCOUNT_ID: id,
          RESERVED_CERTIFICATION_ACCOUNT_EMAIL: email,
          RESERVED_CERTIFICATION_TEMPLATE_REQUEST_ID: 'invalid',
          RESERVED_CERTIFICATION_TEMPLATE_CLUB_ID: '22222222-2222-4222-8222-222222222222',
          SUPABASE_URL: 'https://isolated.invalid',
          SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
        },
        fetchImpl: vi.fn().mockResolvedValue({
          status: 200,
          json: async () => ({ id, deleted_at: '2026-10-13T21:02:06Z' }),
        }),
        cleanup,
      })
    ).rejects.toThrow('Exact Template Creation Receipt IDs');
    expect(cleanup).not.toHaveBeenCalled();
  });
  it('refuses a live template actor without database access before receipt lookup or cleanup', async () => {
    const cleanup = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ id, email }) });
    await expect(
      retireReservedCertificationAccount({
        environment: {
          RESERVED_CERTIFICATION_ACCOUNT_ID: id,
          RESERVED_CERTIFICATION_ACCOUNT_EMAIL: email,
          RESERVED_CERTIFICATION_TEMPLATE_REQUEST_ID: '11111111-1111-4111-8111-111111111111',
          RESERVED_CERTIFICATION_TEMPLATE_CLUB_ID: '22222222-2222-4222-8222-222222222222',
          SUPABASE_URL: 'https://isolated.invalid',
          SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
        },
        fetchImpl,
        cleanup,
      })
    ).rejects.toThrow('Configured Database Access');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });
  it.each([
    ['created half an hour ago, while its sweep is still running', '2026-10-19T15:14:07.500Z'],
    ['with no readable creation time', undefined],
  ])('refuses an identity a running certificate may still own: %s', async (_label, createdAt) => {
    // Client browser verification 118134919713 lost its identity at 15:44:06,
    // thirty minutes into a run that may own it for up to 112.
    const cleanup = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ status: 200, json: async () => ({ id, email, created_at: createdAt }) });
    await expect(
      retireReservedCertificationAccount({
        environment: {
          RESERVED_CERTIFICATION_ACCOUNT_ID: id,
          RESERVED_CERTIFICATION_ACCOUNT_EMAIL: email,
          SUPABASE_URL: 'https://isolated.invalid',
          SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
        },
        fetchImpl,
        cleanup,
        now: () => Date.parse('2026-10-19T15:44:06.000Z'),
      })
    ).rejects.toThrow(/Running Certificate May Own It|Longest Certificate That May Own It/);
    expect(cleanup).not.toHaveBeenCalled();
  });
});
