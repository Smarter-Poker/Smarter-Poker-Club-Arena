import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20260902040000_certification_cleanup_respects_append_only_journals.sql'
  ),
  'utf8'
);

describe('reserved certification cleanup and append-only journals', () => {
  it('keeps the database change in one transaction', () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]*\nBEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it('authorizes maintenance only after the locked reserved-email check', () => {
    const lock = migration.indexOf('FOR UPDATE');
    const marker = migration.indexOf("v_email NOT LIKE 'ca-customization-cert-%@example.invalid'");
    const maintenance = migration.indexOf("'app.ledger_maintenance'");
    const journalDelete = migration.indexOf('DELETE FROM public.diamond_transactions');
    const auditDelete = migration.indexOf('DELETE FROM public.audit_trail');
    const authDelete = migration.indexOf('DELETE FROM auth.users');

    expect(lock).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(lock);
    expect(maintenance).toBeGreaterThan(marker);
    expect(journalDelete).toBeGreaterThan(maintenance);
    expect(auditDelete).toBeGreaterThan(journalDelete);
    expect(authDelete).toBeGreaterThan(auditDelete);
  });

  it('uses a transaction-local, user-specific maintenance reference', () => {
    expect(migration).toMatch(
      /PERFORM set_config\(\s*'app\.ledger_maintenance',\s*'certification-cleanup:' \|\| p_user_id::text,\s*true\s*\);/
    );
  });

  it('does not expose the cleanup to browser roles', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.cleanup_reserved_certification_account(uuid)'
    );
    expect(migration).toContain('FROM PUBLIC, anon, authenticated;');
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.cleanup_reserved_certification_account(uuid) TO service_role;'
    );
  });
});
