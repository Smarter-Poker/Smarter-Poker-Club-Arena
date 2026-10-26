/**
 * LAW: A MERGED MIGRATION IS DISPATCHED BY ITS MERGER (2026-10-25).
 *
 * apply-merged-migration.yml is dispatch-only: "THE READER is the person who
 * dispatches it". The autopilot App merges pull requests itself, so for an
 * automatically merged PR there was no person and nothing dispatched it. PR
 * #7971 merged at 01:48 UTC on 2026-10-25 with
 * 20261024231549_lightning_voided_hand_returns_its_blind_stamps.sql, and the
 * file sat uninstalled until a hand dispatch at 02:30 UTC.
 *
 * What this pins:
 *   1. The dispatch lives in agent-autopilot.yml, the workflow that merges,
 *      on the native `closed` event of a merged same-repository PR; no timer,
 *      no workflow_run watcher, no repository_dispatch trigger of its own.
 *   2. It uses the same freshly minted App token and only acts on a merge the
 *      App itself performed.
 *   3. One repository_dispatch per added migration file, filename order,
 *      client_payload {migration, dry_run: false}, never retried.
 *   4. "-- @install-window: daily-maintenance" files are skipped by the
 *      applier's own classifier and named in the summary.
 *   5. Inside the :50-:03 UTC window (and the daily 04:00 Chicago break) it
 *      waits once, bounded, BEFORE sending anything; beyond the bound it sends
 *      nothing, names the files and fails, so no file is silently left behind.
 *   6. apply-merged-migration.yml is still dispatch-only and unchanged in its
 *      triggers.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  WAIT_BUDGET_MINUTES,
  admissibleAt,
  earliestDispatch,
  planDispatch,
} from '../scripts/ci/merged-migration-dispatch.mjs';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const autopilotRaw = read('.github/workflows/agent-autopilot.yml');
const autopilot = parse(autopilotRaw) as Record<string, any>;
const script = read('.github/scripts/dispatch-merged-migrations.sh');
const scriptCode = script
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');
const applier = parse(read('.github/workflows/apply-merged-migration.yml')) as Record<string, any>;

const at = (iso: string) => Date.parse(iso);
const ORDINARY = 'BEGIN;\nSELECT 1;\nCOMMIT;\n';
const WINDOWED = '-- @install-window: daily-maintenance\nBEGIN;\nSELECT 1;\nCOMMIT;\n';
const PREAMBLE =
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_a ON public.hand_history (id);\nBEGIN;\nSELECT 1;\nCOMMIT;\n';

describe('the merger dispatches the migrations its merge added', () => {
  const job = autopilot.jobs['dispatch-merged-migrations'];

  it('lives in the workflow that merges, on its own native closed event', () => {
    expect(autopilot.on.pull_request_target.types).toContain('closed');
    expect(autopilot.on.schedule).toBeUndefined();
    expect(autopilot.on.repository_dispatch).toBeUndefined();
    expect(job).toBeDefined();
    expect(job.if).toContain("github.event.action == 'closed'");
    expect(job.if).toContain('github.event.pull_request.merged == true');
    expect(job.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(job.if).toContain(
      'github.event.pull_request.base.ref == github.event.repository.default_branch'
    );
  });

  it('the merged event cannot cancel the merge run, and is never cancelled itself', () => {
    expect(autopilot.concurrency.group).toContain("github.event.action == 'closed' && '-merged'");
    expect(autopilot.concurrency['cancel-in-progress']).toBe("${{ github.event.action != 'closed' }}");
  });

  it('a closed event never re-enters the queue job', () => {
    expect(autopilot.jobs['queue-pr'].if).toContain("github.event.action != 'closed'");
  });

  it('uses the merge job token, and only for a merge the App performed', () => {
    const step = job.steps.find((s: any) => s.name === 'Dispatch each added migration to the applier');
    expect(step.env.GH_TOKEN).toBe('${{ steps.app-token.outputs.token }}');
    expect(step.env.MERGED_BY).toBe('${{ github.event.pull_request.merged_by.login }}');
    expect(step.env.APP_SLUG).toBe('${{ steps.app-token.outputs.app-slug }}');
    expect(job.steps[0].with.ref).toBe('${{ github.event.repository.default_branch }}');
    expect(scriptCode).toContain('if [ "$MERGED_BY" != "${APP_SLUG}[bot]" ]; then');
    expect(autopilotRaw).not.toMatch(/GH_PAT|AUTOFIX_GITHUB_TOKEN|secrets\.GITHUB_TOKEN/);
  });

  it('sends one apply-merged-migration dispatch per file, dry_run false, never retried', () => {
    expect(scriptCode).toContain('repos/$REPO/dispatches');
    expect(scriptCode).toContain('-f event_type=apply-merged-migration');
    expect(scriptCode).toContain('-f "client_payload[migration]=$f"');
    expect(scriptCode).toContain('-F "client_payload[dry_run]=false"');
    expect(scriptCode.match(/repos\/\$REPO\/dispatches/g)).toHaveLength(1);
    expect(scriptCode).toMatch(/for f in "\$\{DISPATCH\[@\]\}"; do\n\s+if gh api --method POST/);
    expect(scriptCode).toMatch(/DISPATCH REFUSED[^\n]*not retried/);
    expect(scriptCode).not.toMatch(/--dry-run|dry_run\]=true|workflow run|actions\/workflows/);
  });

  it('reads only the files the PR added, in filename order, from the default branch', () => {
    expect(scriptCode).toContain('repos/$REPO/pulls/$PR/files?per_page=100');
    const plan = planDispatch(
      [
        'supabase/migrations/20261024231549_b.sql',
        'docs/x.md',
        'supabase/migrations/20261024220000_a.sql',
        'supabase/migrations/not_a_version.sql',
      ],
      () => ORDINARY,
      at('2026-10-25T02:10:00Z')
    );
    expect(plan.dispatch).toEqual(['20261024220000_a.sql', '20261024231549_b.sql']);
    expect(plan.waitSeconds).toBe(0);
  });

  it('skips a daily-maintenance window file and says so', () => {
    const plan = planDispatch(
      ['supabase/migrations/20261024220000_win.sql', 'supabase/migrations/20261024220001_ok.sql'],
      (n) => (n.includes('win') ? WINDOWED : ORDINARY),
      at('2026-10-25T02:10:00Z')
    );
    expect(plan.windowQueued).toEqual(['20261024220000_win.sql']);
    expect(plan.dispatch).toEqual(['20261024220001_ok.sql']);
    expect(scriptCode).toContain('-- @install-window: daily-maintenance');
    expect(read('scripts/ci/merged-migration-dispatch.mjs')).toContain(
      "import { windowDeclaration } from './maintenance-window-migrations.mjs'"
    );
  });

  it('waits out the :50-:03 window before sending, and PR #7971 would have gone at :04', () => {
    // The incident merge: 01:48:24 UTC is two minutes before the window; one
    // file needs three minutes of runway, so it waits to 02:04.
    const merged = at('2026-10-25T01:48:24Z');
    expect(admissibleAt(merged, 1, false)).toBe(false);
    const go = earliestDispatch(merged, 1, false)!;
    expect(new Date(go).toISOString()).toBe('2026-10-25T02:04:09.000Z');
    for (const iso of ['2026-10-25T01:50:00Z', '2026-10-25T02:00:00Z', '2026-10-25T02:03:59Z'])
      expect(admissibleAt(at(iso), 1, false), iso).toBe(false);
    expect(admissibleAt(at('2026-10-25T02:04:00Z'), 1, false)).toBe(true);
    // The send comes after the wait, and the clock is asked again after it.
    const sleep = scriptCode.indexOf('sleep "$WAIT"');
    const recheck = scriptCode.indexOf('node "$PLANNER" admitted');
    const send = scriptCode.indexOf('repos/$REPO/dispatches');
    expect(sleep).toBeGreaterThan(0);
    expect(recheck).toBeGreaterThan(sleep);
    expect(send).toBeGreaterThan(recheck);
  });

  it('stays clear of the daily 04:00 Chicago break and its release', () => {
    // 04:00 CDT is 09:00 UTC; 04:00 CST is 10:00 UTC.
    expect(admissibleAt(at('2026-10-25T09:05:00Z'), 1, false)).toBe(false);
    expect(admissibleAt(at('2026-10-25T09:10:00Z'), 1, false)).toBe(true);
    expect(admissibleAt(at('2026-12-01T10:06:00Z'), 1, false)).toBe(false);
    expect(admissibleAt(at('2026-12-01T09:06:00Z'), 1, false)).toBe(true);
  });

  it('every ordinary merge fits the bounded wait, whatever the minute', () => {
    let worst = 0;
    for (let t = at('2026-10-25T00:00:00Z'); t < at('2026-10-27T00:00:00Z'); t += 60_000) {
      const go = earliestDispatch(t, 1, false)!;
      worst = Math.max(worst, go - t);
    }
    expect(worst / 60_000).toBeLessThanOrEqual(WAIT_BUDGET_MINUTES);
    expect(WAIT_BUDGET_MINUTES * 60 + 5 * 60).toBeLessThanOrEqual(
      autopilot.jobs['dispatch-merged-migrations']['timeout-minutes'] * 60
    );
  });

  it('beyond the bound it sends nothing, names the files and fails', () => {
    // A CONCURRENTLY preamble needs 12 minutes before :50 (the applier's
    // PREAMBLE_MINUTES_NEEDED), so a merge at :36 cannot go until :04, past
    // the bound: nothing may be sent.
    const plan = planDispatch(
      ['supabase/migrations/20261024220000_ix.sql'],
      () => PREAMBLE,
      at('2026-10-25T01:36:00Z')
    );
    expect(plan.preamble).toBe(true);
    expect(plan.dispatch).toEqual(['20261024220000_ix.sql']);
    expect(plan.withinBudget).toBe(false);
    const block = scriptCode.slice(
      scriptCode.indexOf('if [ "$(jq -r \'.withinBudget\''),
      scriptCode.indexOf('WAIT=$(jq')
    );
    expect(block).toContain('NOT DISPATCHED (break window)');
    expect(block).toContain('Nothing was sent.');
    expect(block).toContain('::error::');
    expect(block).toContain('exit 1');
    expect(block).not.toContain('repos/$REPO/dispatches');
  });

  it('the applier itself is still dispatch-only', () => {
    const triggers = Object.keys(applier.on).sort();
    expect(triggers).toEqual(['repository_dispatch', 'workflow_dispatch']);
    expect(applier.on.repository_dispatch.types).toEqual(['apply-merged-migration']);
  });
});
