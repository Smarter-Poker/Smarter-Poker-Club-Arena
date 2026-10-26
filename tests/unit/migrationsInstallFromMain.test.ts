/**
 * A MIGRATION REACHES PRODUCTION ONLY FROM PROTECTED MAIN (owner instruction,
 * 2026-10-25: "do what ever you feel needs to be done for phase 2").
 *
 * On 2026-10-24/25 three migrations were applied to production from pull
 * requests that were still open (#7968, #7983, #8019), so production ran SQL
 * that main had never seen until #8109 recorded it by hand. The route agents
 * reached for was the one the repo itself pointed at: the Supabase MCP
 * apply_migration, named as the remedy in check-migrations-are-live's own
 * output. The automatic route now exists (dispatch-merged-migrations.sh on the
 * autopilot's merge, #8012), so the rule, and every message that tells an agent
 * what to do, names it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

describe('a migration reaches production only from protected main', () => {
  it('PUBLISHING.md states the rule and its one exception', () => {
    const doc = read('PUBLISHING.md');
    expect(doc).toContain('A migration reaches production only from protected main');
    expect(doc).toContain('Never apply a migration from an unmerged branch');
    expect(doc).toContain('dispatch-merged-migrations.sh');
    expect(doc).toContain('active production outage');
    expect(doc).toContain('scripts/ci/recorded-migrations.manifest.json');
  });

  it('CLAUDE.md carries the rule where every agent loads it', () => {
    const doc = read('CLAUDE.md');
    expect(doc).toContain('A MIGRATION REACHES PRODUCTION ONLY FROM PROTECTED MAIN');
    expect(doc).toContain('tests/unit/migrationsInstallFromMain.test.ts');
  });

  it('the merged-but-not-live remedy names the applier, not the MCP', () => {
    const src = read('scripts/ci/check-migrations-are-live.mjs');
    // The remedy paragraph, bounded by its own first and last sentences.
    const remedy = sliceBetween(
      src,
      'These are in the repository and not in the database.',
      'History is never deleted.'
    );
    expect(remedy).toContain('apply-merged-migration');
    expect(remedy).not.toMatch(/Apply each one with the[\s\S]{0,40}Supabase MCP apply_migration/);
  });

  it('the automatic route the rule relies on is still wired to the merge', () => {
    const wf = read('.github/workflows/agent-autopilot.yml');
    expect(wf).toContain('dispatch-merged-migrations.sh');
    expect(wf).toMatch(/github\.event\.pull_request\.merged == true/);
    const script = read('.github/scripts/dispatch-merged-migrations.sh');
    expect(script).toContain('apply-merged-migration');
  });
});
