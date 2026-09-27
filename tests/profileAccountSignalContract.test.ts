import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const migration = read(
  'supabase/migrations/20260926221700_own_account_changes_send_bounded_private_signals.sql'
);
describe('private own-account invalidations stay bounded', () => {
  it('carries only identity and domains, never row values or broad publication', () => {
    expect(migration).toContain("jsonb_build_object('user_id', NEW.id, 'domains', v_domains)");
    expect(migration).not.toMatch(
      /ALTER PUBLICATION|to_jsonb\(NEW\)|jsonb_build_object\([^;]+NEW\.diamonds/i
    );
    expect(migration).toContain("'account_changed', 'profile-account:' || NEW.id::text, true");
    expect(migration).toContain('FOR EACH ROW WHEN');
    expect(migration).not.toMatch(/OLD\.(last_seen|total_hands|horse|updated_at)/);
    expect(migration).not.toMatch(/OLD\.settings\s+IS DISTINCT/);
  });
  it('grants only owner receive access and no client producer', () => {
    expect(migration).toContain('ON realtime.messages FOR SELECT TO authenticated');
    expect(migration).toContain("'profile-account:' || (SELECT auth.uid())::text");
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).not.toMatch(/FOR (INSERT|ALL)|DISABLE ROW LEVEL|GRANT.*TO authenticated/i);
  });
  it('mounts once and removes the unreachable row subscription', () => {
    expect(read('src/App.tsx').match(/<ProfileAccountSync \/>/g)).toHaveLength(1);
    expect(read('src/services/PostgresSyncHooks.ts')).not.toContain("table: 'profiles'");
    expect(read('src/hooks/useProfileAccountSync.ts')).not.toContain('setInterval');
  });
  it('runs the actual migration and role/rollback/concurrency fixture in required CI', () => {
    expect(read('.github/workflows/ci.yml')).toMatch(
      /name: Private account signals preserve source and owner isolation\n\s+if: matrix.shard == 1\n\s+env:\n\s+PG_BIN: \/usr\/lib\/postgresql\/17\/bin\n\s+run: python3 scripts\/ci\/test-profile-account-postgres.py/
    );
    const runner = read('scripts/ci/test-profile-account-postgres.py');
    expect(runner).toContain('MIGRATION.read_text()');
    expect(runner).toContain('profile-account-concurrent-source-and-signal-passed');
    expect(runner).toContain("listen_addresses = ''");
    expect(runner).not.toContain('SUPABASE_DB_URL');
  });
});
