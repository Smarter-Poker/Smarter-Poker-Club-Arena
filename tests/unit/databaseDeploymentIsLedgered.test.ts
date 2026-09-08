import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');

describe('production database changes are named and ledgered', () => {
  it('exposes only the official migration-aware CLI path', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['db:plan']).toBe('supabase db push --dry-run');
    expect(pkg.scripts?.['db:push']).toBe('supabase db push');
    expect(pkg.scripts?.migrate).toBeUndefined();
    expect(pkg.scripts?.['migrate:all']).toBeUndefined();
  });

  it('does not retain retry-forever or arbitrary-SQL deploy clients', () => {
    expect(existsSync(join(root, 'deploy_db.sh'))).toBe(false);
    expect(existsSync(join(root, 'scripts', 'orb-sql-deploy.cjs'))).toBe(false);
  });

  it('retires the public arbitrary SQL endpoint in one transaction', () => {
    const migration = readFileSync(
      join(
        root,
        'supabase',
        'migrations',
        '20260908042700_retire_public_arbitrary_sql_executor.sql'
      ),
      'utf8'
    );

    expect(migration).toContain('DROP FUNCTION IF EXISTS public.exec_sql(text);');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
