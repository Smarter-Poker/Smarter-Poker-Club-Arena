import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const migration = read(
  'supabase/migrations/20260926214908_public_discovery_reads_current_privacy_before_cached_locatio.sql'
);
const fixture = JSON.parse(read('scripts/ci/fixtures/discovery-privacy/baseline.json'));

describe('discovery privacy native regression qualification', () => {
  it('runs the native permission and transition cases in the required accounting job', () => {
    const workflow = read('.github/workflows/ci.yml');
    const accounting = workflow.split('\n  accounting_postgres:')[1].split('\n  server:')[0];
    expect(accounting).toContain('run: python3 scripts/ci/test-discovery-privacy-postgres.py');
    expect(accounting).not.toContain('test-discovery-privacy-postgres.py --baseline');
    const runner = read('scripts/ci/test-discovery-privacy-postgres.py');
    expect(runner).toContain('MIGRATION.read_text()');
    expect(runner).toContain("(FIXTURE/'cases.sql').read_text()");
  });

  it('refuses drift against the exact captured read and refresh functions', () => {
    for (const fn of fixture.functions) {
      const hash = createHash('md5').update(fn.definition).digest('hex');
      expect(migration).toContain(hash);
    }
    for (const view of fixture.views) {
      expect(migration).toContain(createHash('md5').update(view.definition).digest('hex'));
    }
  });

  it('ships only the two refresh replacements and keeps the four caller-rights readers intact', () => {
    const replacements = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)]
      .map((match) => match[1])
      .sort();
    expect(replacements).toEqual([
      'fn_refresh_active_poker_locations',
      'fn_refresh_trending_home_groups',
    ]);
    expect(migration).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(migration).not.toMatch(/cron\.(?:schedule|alter_job|unschedule)\s*\(/i);
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
