import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260906020000_test_accounts_leave_their_audit_testimony.sql'
  ),
  'utf8'
);
const rateLimitMigration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260906021000_rate_limits_expire_with_the_identity.sql'
  ),
  'utf8'
);
const currentCleanupMigration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260906022000_reserved_cleanup_archives_audit_testimony.sql'
  ),
  'utf8'
);

describe('guarded test-account audit archive', () => {
  it('copies the complete audit row and verifies the copy before deletion', () => {
    expect(migration).toContain('to_jsonb(a)');
    expect(migration).toContain('v_archived_count <> v_audit_count');
    expect(migration.indexOf('INSERT INTO public.ca_test_account_audit_archive')).toBeLessThan(
      migration.indexOf('DELETE FROM public.audit_trail')
    );
  });

  it('keeps every original destructive-account safety refusal in front of the archive', () => {
    for (const refusal of [
      'address_is_not_a_test_pattern',
      'is_a_horse',
      'holds_club_chips',
      'is_seated',
      'owns_a_club',
      'bought_something_with_a_card',
      'acted_on_the_chip_ledger',
    ]) {
      expect(migration.indexOf(`'${refusal}'`)).toBeGreaterThan(0);
      expect(migration.indexOf(`'${refusal}'`)).toBeLessThan(
        migration.indexOf('INSERT INTO public.ca_test_account_audit_archive')
      );
    }
  });

  it('makes archived testimony immutable and leaves the inner deletion body unreachable', () => {
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(migration).toContain('Test-account audit testimony is append-only');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_sweep_test_account_after_audit_archive(uuid)'
    );
  });

  it('lets the transient club-join throttle expire with a deleted identity', () => {
    expect(rateLimitMigration).toContain('FOREIGN KEY (user_id) REFERENCES auth.users(id)');
    expect(rateLimitMigration).toContain('ON DELETE CASCADE');
  });

  it('preserves testimony through the current reserved-account cleanup RPC too', () => {
    expect(currentCleanupMigration).toContain(
      "v_email NOT LIKE 'ca-customization-cert-%@example.invalid'"
    );
    expect(currentCleanupMigration).toContain('INSERT INTO public.ca_test_account_audit_archive');
    expect(currentCleanupMigration.indexOf('v_archived_count <> v_audit_count')).toBeLessThan(
      currentCleanupMigration.indexOf('DELETE FROM public.audit_trail')
    );
    expect(currentCleanupMigration).toContain("'audit_rows_archived', v_audit_count");
  });
});
