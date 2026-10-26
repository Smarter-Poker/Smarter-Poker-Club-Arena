import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
const sql = readFileSync(
  'supabase/migrations/20261026144155_weekly_close_uses_the_actual_maintenance_freeze.sql',
  'utf8'
);
describe('the weekly close follows the actual freeze', () => {
  it('removes only seven retired hourly guards from exact owners', () => {
    expect(sql).toContain("'e5065fedd05b476e16bf9a0393f8bc05',6");
    expect(sql).toContain("'d7fd54f6876c3b9316cfaafeb10f7761',1");
    expect(sql).toContain('before_meta IS DISTINCT FROM after_meta');
    expect(sql).toContain('public.fn_platform_frozen() IS DISTINCT FROM false');
    expect(sql).toContain("position('fn_platform_frozen' in candidate)=0");
    expect(sql).not.toMatch(/cron\.schedule|UPDATE public\.|INSERT INTO public\./);
  });
  it('executes real old and new entry paths under the pull request workflow', () => {
    const native = readFileSync('scripts/ci/test-weekly-close-hour-guard-postgres.py', 'utf8');
    expect(native).toContain('for minute in [0,44,45,50,59]');
    expect(native).toContain("old[0]['reason']=='maintenance_window'");
    expect(native).toContain("new[0]['split_advance']['advanced'] is True");
    expect(native).toContain("frozen[0]['reason']=='maintenance_window'");
    expect(readFileSync('.github/workflows/weekly-close-hour-guard.yml', 'utf8')).toContain(
      'python3 -B scripts/ci/test-weekly-close-hour-guard-postgres.py'
    );
  });
  it('parses a runnable pull request workflow', () => {
    const workflow = parse(readFileSync('.github/workflows/weekly-close-hour-guard.yml', 'utf8'));
    expect(workflow.on.pull_request.paths).toContain('supabase/migrations/**');
    expect(workflow.jobs['weekly-close-hour-guard'].steps.length).toBeGreaterThan(2);
  });
});
