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
  it('enforces the original four-AM all-game pause and financial phase through both native proofs', () => {
    const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const accounting = workflow.jobs.accounting_postgres;
    for (const [script, log] of [
      ['test-weekly-payout-owned-phase-postgres.py', 'protocol.log'],
      ['test-weekly-payout-financial-phase-postgres.py', 'financial.log'],
    ]) {
      const step = accounting.steps.find((candidate: { run?: string }) =>
        candidate.run?.includes('python3 -B scripts/ci/' + script)
      );
      expect(step).toBeDefined();
      expect(step.if).toBe('matrix.shard == 1');
      expect(step.run).toContain('set -o pipefail');
      expect(step.run).toContain('tee artifacts/weekly-payout-owned-pause/' + log);
    }
    const evidence = accounting.steps.find(
      (step: { with?: { path?: string } }) =>
        step.with?.path === 'artifacts/weekly-payout-owned-pause'
    );
    expect(evidence.if).toBe('always() && matrix.shard == 1');
    expect(evidence.uses).toBe('actions/upload-artifact@v4');
    expect(evidence.with['retention-days']).toBeGreaterThan(0);
    expect(workflow.jobs.server.needs).toContain('accounting_postgres');
    expect(
      workflow.jobs.server.steps.some(
        (step: { env?: { ACCOUNTING_RESULT?: string } }) =>
          step.env?.ACCOUNTING_RESULT === '${{ needs.accounting_postgres.result }}'
      )
    ).toBe(true);
  });
});
