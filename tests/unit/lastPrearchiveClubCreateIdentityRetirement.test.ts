import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260927053730_retire_last_prearchive_club_create_identity.sql'
  ),
  'utf8'
);

describe('last pre-archive Club Create identity retirement', () => {
  it('pins the complete one-row preimage and one bounded transaction', () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]*\nBEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    expect(migration).toContain("SET LOCAL statement_timeout = '15min'");
    for (const value of [
      'f488216c-2323-4f5e-857c-597339b00f75',
      'club-create-cert-1788193929851-i6onsb@smarter-poker.invalid',
      'club-create-cer',
      '2026-08-31T16:32:10.388656Z',
      '8a140d14f3ae7b98d0da7d890717c84e',
      'length(to_jsonb(u)::text) = 269',
      'u.avatar_url IS NULL',
    ])
      expect(migration).toContain(value);
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toMatch(
      /AND NOT \(\s*n\.nspname = 'public' AND c\.relname = 'users' AND a\.attname = 'id'\s*\)/
    );
    expect(migration).not.toContain("c.relname <> 'users'");
  });

  it('refuses freeze, delete-graph drift, and every UUID or email-bearing surface first', () => {
    const deletion = migration.indexOf('DELETE FROM public.users u');
    for (const guard of [
      'public.fn_platform_frozen()',
      "t.tgrelid = 'public.users'::regclass",
      "fk.confrelid = 'public.users'::regclass",
      "n.nspname = 'public'",
      "n.nspname IN ('auth', 'storage')",
      "n.nspname IN ('auth', 'public')",
      "a.attname LIKE '%email%'",
      'LAST_PREARCHIVE_CLUB_CREATE_IDENTITY_UUID_SURFACE',
      'LAST_PREARCHIVE_CLUB_CREATE_IDENTITY_EMAIL_SURFACE',
    ]) {
      const position = migration.indexOf(guard);
      expect(position).toBeGreaterThan(-1);
      expect(position).toBeLessThan(deletion);
    }
  });

  it('deletes only one exact public-users row and verifies its absence', () => {
    const deletion = migration.slice(
      migration.indexOf('DELETE FROM public.users u'),
      migration.indexOf('GET DIAGNOSTICS v_deleted = ROW_COUNT')
    );
    expect(migration.match(/DELETE FROM public\.users u/g)).toHaveLength(1);
    expect(migration.match(/DELETE FROM /g)).toHaveLength(1);
    for (const predicate of [
      'u.id = v_id',
      'u.email = v_email',
      "u.username = 'club-create-cer'",
      'u.avatar_url IS NULL',
      "u.created_at = '2026-08-31T16:32:10.388656Z'::timestamptz",
      "u.updated_at = '2026-08-31T16:32:10.388656Z'::timestamptz",
      'length(to_jsonb(u)::text) = 269',
      "md5(to_jsonb(u)::text) = '8a140d14f3ae7b98d0da7d890717c84e'",
    ]) {
      expect(deletion).toContain(predicate);
    }
    expect(migration).toContain('GET DIAGNOSTICS v_deleted = ROW_COUNT');
    expect(migration).toContain('v_deleted <> 1');
    expect(migration).not.toMatch(/DELETE FROM (?:auth|storage)\./);
    expect(migration).not.toMatch(/DELETE FROM public\.(?:profiles|wallets|clubs|chip_ledger)/);
  });
});
