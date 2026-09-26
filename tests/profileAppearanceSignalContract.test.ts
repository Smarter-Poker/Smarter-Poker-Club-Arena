import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const migration = read(
  'supabase/migrations/20260926150415_profile_appearance_changes_have_a_private_bounded_signal.sql'
);

describe('appearance invalidation stays separate from high-write profile data', () => {
  it('does not republish profiles or copy private/financial fields into a signal', () => {
    const body = migration.slice(
      migration.indexOf('AS $function$'),
      migration.indexOf('$function$;')
    );
    expect(body).not.toMatch(/diamonds|chip_balance|private_email|is_horse|to_jsonb\(NEW\)/i);
    expect(body).toContain("jsonb_build_object('user_id', NEW.id)");
    expect(migration).not.toMatch(/ALTER PUBLICATION/i);
    expect(migration).toContain('IS DISTINCT FROM');
  });
  it('uses private reads, preserves existing table RLS, and grants no client producer', () => {
    expect(migration).toContain('ON realtime.messages FOR SELECT TO authenticated');
    expect(migration).toContain('SELECT 1 FROM public.tables t');
    expect(migration).not.toMatch(/FOR (INSERT|ALL)|DISABLE ROW LEVEL|GRANT.*TO authenticated/i);
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
  });
  it('mounts one account signal outside route-specific header copies', () => {
    const app = read('src/App.tsx');
    expect(app.match(/<HeaderAppearanceSync \/>/g)).toHaveLength(1);
    const owner = read('src/hooks/useHeaderAppearanceSync.ts');
    expect(owner).toContain('`profile-appearance:${userId}`');
    expect(owner).toContain("event: 'appearance_changed'");
    expect(owner).toContain('store.refreshAppearance()');
    expect(read('src/stores/useHeaderDataStore.ts')).not.toContain("table: 'profiles'");
    expect(read('src/components/navigation/GlobalHeader.tsx')).not.toContain('profile-appearance:');
  });
  it('executes the native PostgreSQL behavior and access cases in the existing required check', () => {
    const workflow = read('.github/workflows/ci.yml');
    expect(workflow).toMatch(
      /name: Profile appearance signals preserve scoped access\n\s+if: matrix.shard == 1\n\s+env:\n\s+PG_BIN: \/usr\/lib\/postgresql\/17\/bin\n\s+run: python3 scripts\/ci\/test-profile-appearance-postgres.py/
    );
    const runner = read('scripts/ci/test-profile-appearance-postgres.py');
    expect(runner).toContain('MIGRATION.read_text()');
    expect(runner).toContain('profile-appearance-acceptance-passed');
    expect(runner).toContain("listen_addresses = ''");
    expect(runner).not.toContain('SUPABASE_DB_URL');
  });
});
