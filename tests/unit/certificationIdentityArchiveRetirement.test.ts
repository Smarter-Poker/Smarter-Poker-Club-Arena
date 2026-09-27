import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260927045612_archive_and_retire_prearchive_certification_identity.sql'
  ),
  'utf8'
);

const identityId = 'a28421ff-9f27-4a99-81dd-2e18884d616c';
const exactHashes = [
  '0de97dc17503cdd1e1b4cd97cb03bd74',
  '974f2f79005e7df290bf2ed4e1f364d5',
  '03f600358c345cb9bcce9a39e6581cc4',
  '774df5bcc15c39b338c42597c8fd544e',
  '01fd90e79a651f8651e5b6ceed916e2b',
  '5884303966cf2c055b16e5b39f1926a2',
];

describe('pre-archive certification identity retirement', () => {
  it('uses one serializable forward transaction and refuses a freeze or changed delete graph', () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]*\nBEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    expect(migration).toContain("SET LOCAL statement_timeout = '15min'");
    expect(migration).toContain('IF public.fn_platform_frozen() THEN');
    expect(migration).toContain(
      'PREARCHIVE_CERTIFICATION_IDENTITY_ARCHIVE_REFUSES_PLATFORM_FREEZE'
    );
    expect(migration).toContain("t.tgrelid = 'public.users'::regclass");
    expect(migration).toContain("fk.confrelid = 'public.users'::regclass");
    expect(migration).toContain('PREARCHIVE_CERTIFICATION_IDENTITY_DELETE_GRAPH_CHANGED');
  });

  it('pins the exact identity, signup diagnostic, profile deletion, and six diamond rows', () => {
    expect(migration).toContain(identityId);
    expect(migration).toContain(
      'ca-customization-cert-postdeploy-1788659737460-da18c019-9c82-45d6-9fa1-d5e5a98f2a10@example.invalid'
    );
    expect(migration).toContain("u.username = 'PostDeploya98f2'");
    expect(migration).toContain('u.avatar_url IS NULL');
    expect(migration).toContain('e.id = 9105');
    expect(migration).toContain('p.id = 1627');
    expect(migration).toContain(
      '(SELECT count(*) FROM public.ca_diamond_balance_audit d WHERE d.user_id = v_id) <> 1'
    );
    expect(migration).toContain(
      '(SELECT count(*) FROM public.ca_diamond_incidents d WHERE d.user_id = v_id) <> 4'
    );
    expect(migration).toContain(
      '(SELECT count(*) FROM public.ca_diamond_journal_archive d WHERE d.user_id = v_id) <> 1'
    );
    for (const hash of exactHashes) expect(migration).toContain(hash);
  });

  it('creates a private immutable whole-row archive with no hot-table foreign key', () => {
    expect(migration).toContain('CREATE TABLE public.ca_test_account_identity_archive');
    expect(migration).toContain('public_user_row jsonb NOT NULL');
    expect(migration).toContain('signup_error_row jsonb NOT NULL');
    expect(migration).toContain('profile_deletion_row jsonb NOT NULL');
    expect(migration).toContain('diamond_balance_audit_rows jsonb NOT NULL');
    expect(migration).toContain('diamond_incident_rows jsonb NOT NULL');
    expect(migration).toContain('diamond_journal_archive_rows jsonb NOT NULL');
    expect(migration).not.toMatch(
      /CREATE TABLE public\.ca_test_account_identity_archive[\s\S]*?REFERENCES/
    );
    expect(migration).toContain(
      'ALTER TABLE public.ca_test_account_identity_archive ENABLE ROW LEVEL SECURITY'
    );
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role');
    expect(migration).toContain(
      'GRANT SELECT ON TABLE public.ca_test_account_identity_archive TO service_role'
    );
    expect(migration).toContain('CREATE TRIGGER trg_ca_test_account_identity_archive_immutable');
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON public.ca_test_account_identity_archive'
    );
    expect(migration).toContain('Test-account identity archive is append-only');
  });

  it('archives and verifies before deleting only the exact signup/public-user residue', () => {
    const insert = migration.indexOf('INSERT INTO public.ca_test_account_identity_archive');
    const archiveVerify = migration.indexOf(
      'PREARCHIVE_CERTIFICATION_IDENTITY_ARCHIVE_COPY_CHANGED'
    );
    const signupDelete = migration.indexOf('DELETE FROM public.signup_errors e');
    const userDelete = migration.indexOf('DELETE FROM public.users u');
    expect(insert).toBeGreaterThan(-1);
    expect(insert).toBeLessThan(archiveVerify);
    expect(archiveVerify).toBeLessThan(signupDelete);
    expect(signupDelete).toBeLessThan(userDelete);
    expect(migration.match(/DELETE FROM public\./g)).toHaveLength(2);
    expect(migration).not.toMatch(
      /(?:DELETE FROM|UPDATE) public\.(?:ca_diamond_balance_audit|ca_diamond_incidents|ca_diamond_journal_archive|ca_profile_deletions)/
    );
    expect(migration).toContain('PREARCHIVE_CERTIFICATION_IDENTITY_RETIREMENT_VERIFICATION_FAILED');
  });

  it('catalog-refuses every unexpected extant no-FK UUID user surface', () => {
    expect(migration).toContain('FROM pg_catalog.pg_class c');
    expect(migration).toContain("a.attname LIKE '%\\_user\\_id' ESCAPE '\\'");
    expect(migration).toContain("a.attname LIKE '%\\_by' ESCAPE '\\'");
    expect(migration).toContain('a.attnum = ANY (fk.conkey)');
    expect(migration).toContain("('ca_diamond_incidents', 'user_id')");
    expect(migration).toContain("('ca_diamond_journal_archive', 'user_id')");
    expect(migration).toContain('PREARCHIVE_CERTIFICATION_IDENTITY_UNEXPECTED_SURFACE');
  });
});
