import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260927035803_certification_cleanup_removes_archived_public_user_residue.sql'
  ),
  'utf8'
);

const exactIds = [
  '01bafbb6-012d-42c5-9dc1-9c643c90537e',
  '3bf778ad-31ff-45f4-bdf9-d267450386bc',
  'afea7b11-593d-43c4-8438-91705b9260dd',
  'c17e8d8b-1e81-4d91-b07c-6dec5a4e4548',
  'db395d65-6180-4a18-8738-83e5d9a776e0',
];

describe('archived certification public-user residue cleanup', () => {
  it('is one transaction, refuses a platform freeze, and never widens the cleanup RPC', () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]*\nBEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain('IF public.fn_platform_frozen() THEN');
    expect(migration).toContain('CERTIFICATION_PUBLIC_USER_RESIDUE_REFUSES_PLATFORM_FREEZE');
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION');
  });

  it('pins the correction to the exact five byte-identified legacy shadows', () => {
    for (const id of exactIds) expect(migration).toContain(id);
    expect(migration).toContain('u.email = v_row.email');
    expect(migration).toContain('u.created_at = v_row.created_at');
    expect(migration).toContain('u.updated_at = v_row.updated_at');
    expect(migration).toContain('v_deleted <> 5');
  });

  it('requires exact immutable archive testimony with no contradiction', () => {
    expect(migration).toContain('public.ca_test_account_audit_archive');
    expect(migration).toContain("a.archive_reason = 'guarded_test_account_deletion'");
    expect(migration).toContain("a.audit_row ->> 'actor_id' = v_row.id::text");
    expect(migration).toContain("a.audit_row ->> 'id' IS DISTINCT FROM a.audit_id::text");
    expect(migration).toContain('a.actor_email IS DISTINCT FROM v_row.email');
    expect(migration).toContain('a.archived_at IS DISTINCT FROM v_row.archived_at');
    expect(migration).toContain('v_archive_count <> v_row.archive_count');
  });

  it('refuses live ownership, custody, journal, and asset surfaces before deletion', () => {
    for (const refusal of [
      'auth.users WHERE id = v_row.id',
      'public.profiles WHERE id = v_row.id',
      'public.club_members WHERE user_id = v_row.id',
      'public.clubs WHERE owner_id = v_row.id',
      'public.unions WHERE owner_id = v_row.id',
      'public.agents WHERE user_id = v_row.id',
      'public.table_seats WHERE user_id = v_row.id',
      'public.tournament_players WHERE user_id = v_row.id',
      'public.wallets WHERE user_id = v_row.id',
      'public.wallet_transactions WHERE user_id = v_row.id',
      'public.wallet_credit_idempotency WHERE user_id = v_row.id',
      'public.diamond_wallets WHERE user_id = v_row.id',
      'public.diamond_transactions WHERE user_id = v_row.id',
      'public.chip_ledger WHERE performed_by = v_row.id',
      'public.audit_trail WHERE actor_id = v_row.id',
      'public.push_outbox WHERE recipient_user_id = v_row.id',
      "o.bucket_id = 'club-assets'",
      "o.name LIKE 'club-logos/' || v_row.id::text || '%'",
    ]) {
      expect(migration).toContain(refusal);
    }
    expect(migration.indexOf('CERTIFICATION_PUBLIC_USER_RESIDUE_IS_NOT_EMPTY')).toBeLessThan(
      migration.indexOf('DELETE FROM public.users')
    );
  });

  it('deletes only public.users shadows and no Auth, profile, club, wallet, or journal row', () => {
    expect(migration).toContain('DELETE FROM public.users u');
    expect(migration).toContain('DELETE FROM public.signup_errors e');
    expect(migration).toContain('e.id = 9106');
    expect(migration).toContain("md5(e.error_msg) = '7d0f88ba3a6d0777977b4dce80dc072a'");
    expect(migration).toContain('v_signup_deleted <> 1');
    expect(migration).not.toMatch(
      /DELETE FROM (?:auth\.users|public\.profiles|public\.clubs|public\.wallets|public\.chip_ledger)/
    );
  });
});
