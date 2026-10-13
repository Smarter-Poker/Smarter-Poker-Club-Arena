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
    expect(job).toContain('npm ci --ignore-scripts');
    expect(job).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    expect(job).not.toMatch(/playwright|production-e2e-account\.mjs create|stale/);
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
    const retireFixtures = vi.fn();
    await expect(
      retireReservedCertificationAccount({
        environment: {
          RESERVED_CERTIFICATION_ACCOUNT_ID: accountId,
          RESERVED_CERTIFICATION_ACCOUNT_EMAIL: accountEmail,
        },
        cleanup,
        retireFixtures,
      })
    ).rejects.toThrow('Exactly One Reserved');
    expect(cleanup).not.toHaveBeenCalled();
    expect(retireFixtures).not.toHaveBeenCalled();
  });
  it('delegates the exact account and requires verified completion', async () => {
    const environment = {
      RESERVED_CERTIFICATION_ACCOUNT_ID: id,
      RESERVED_CERTIFICATION_ACCOUNT_EMAIL: email,
      SUPABASE_URL: 'https://isolated.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
    };
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ id, email }) });
    const order: string[] = [];
    const retireFixtures = vi.fn().mockImplementation(async () => {
      order.push('fixtures');
    });
    const cleanup = vi.fn().mockImplementation(async () => {
      order.push('account');
      return true;
    });
    await expect(
      retireReservedCertificationAccount({ environment, fetchImpl, cleanup, retireFixtures })
    ).resolves.toBe(true);
    expect(order).toEqual(['fixtures', 'account']);
    expect(retireFixtures).toHaveBeenCalledExactlyOnceWith({
      environment,
      fetchImpl,
      record: { id, email },
    });
    expect(cleanup).toHaveBeenCalledExactlyOnceWith({
      environment,
      fetchImpl,
      record: { id, email },
    });
    retireFixtures.mockRejectedValueOnce(new Error('Fixture Has Custody'));
    cleanup.mockClear();
    await expect(
      retireReservedCertificationAccount({ environment, fetchImpl, cleanup, retireFixtures })
    ).rejects.toThrow('Fixture Has Custody');
    expect(cleanup).not.toHaveBeenCalled();
    cleanup.mockResolvedValue(false);
    await expect(
      retireReservedCertificationAccount({ environment, fetchImpl, cleanup, retireFixtures })
    ).rejects.toThrow('Was Not Retired');
    cleanup.mockClear();
    retireFixtures.mockClear();
    fetchImpl.mockResolvedValue({
      status: 200,
      json: async () => ({ id, email: 'different@example.invalid' }),
    });
    await expect(
      retireReservedCertificationAccount({ environment, fetchImpl, cleanup, retireFixtures })
    ).rejects.toThrow('Do Not Match Auth');
    expect(cleanup).not.toHaveBeenCalled();
    expect(retireFixtures).not.toHaveBeenCalled();
    cleanup.mockResolvedValue(true);
    fetchImpl.mockResolvedValue({
      status: 200,
      json: async () => ({ id, deleted_at: '2026-10-13T00:00:00Z' }),
    });
    await expect(
      retireReservedCertificationAccount({ environment, fetchImpl, cleanup, retireFixtures })
    ).resolves.toBe(true);
    expect(retireFixtures).not.toHaveBeenCalled();
  });
});
