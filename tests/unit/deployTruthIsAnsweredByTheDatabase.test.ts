/**
 * PHASE 4 OF 6 - DEPLOY TRUTH.
 *
 * auto-deploy-hetzner reports success whether it ships or skips, and skipping
 * is usually correct: the restart windows exist so a restart never voids a
 * live hand. The cost is that a green tick has never meant "the engine is
 * running this commit", and for a long time nothing said when it stopped
 * being true. On 2026-08-31 the engine sat 3h50m behind main with the window
 * standing open; later the same night GitHub Actions stopped starting jobs for
 * this repo at all, which is why the answer cannot live in Actions.
 *
 * It lives in the database. The pipeline reports every run into
 * ca_engine_deploy_attempts, and fn_ca_engine_deploy_truth_watch compares that
 * against engine_table_leases.engine_version from pg_cron. Each pin below is a
 * way that arrangement has already been broken or could silently become a
 * decoration.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const WORKFLOW = '.github/workflows/auto-deploy-hetzner.yml';
const RECORDER = 'scripts/ci/record-engine-deploy-attempt.mjs';
const MIGRATION = 'supabase/migrations/20260901123315_deploy_truth_lives_in_the_database.sql';
const ZERO_ENGINE_FIX =
  'supabase/migrations/20260902103000_deploy_truth_cannot_mistake_zero_for_healthy.sql';
const CONTINUOUS_BEHIND_FIX =
  'supabase/migrations/20260906005000_deploy_truth_keeps_the_continuous_behind_clock.sql';

describe('the deploy pipeline reports what it actually did', () => {
  it('records deploy truth on every run, including the runs that ship nothing', () => {
    const wf = read(WORKFLOW);

    // The step must exist and must call the recorder.
    expect(wf).toContain('Record deploy truth in the database');
    expect(wf).toContain('node scripts/ci/record-engine-deploy-attempt.mjs');

    // And it must be unconditional. A skipped run is the case the watchdog
    // exists for; gating this step on a successful deploy would report only
    // the runs that never needed watching.
    const step = wf.slice(wf.indexOf('Record deploy truth in the database'));
    const guard = step.slice(0, step.indexOf('run: |'));
    expect(guard).toContain('if: always()');
  });

  it('never fails a deploy to report on one', () => {
    const js = read(RECORDER);
    // Every failure path warns and exits 0. A watchdog that can break the
    // thing it watches is worse than no watchdog.
    expect(js).not.toMatch(/process\.exit\(\s*[1-9]/);
    expect(js).toContain('process.exit(0)');
  });

  it('reports the sha the run was FOR, not whatever the host happens to hold', () => {
    const wf = read(WORKFLOW);
    const step = wf.slice(wf.indexOf('Record deploy truth in the database'));
    expect(step).toMatch(
      /TARGET_SHA:\s*\$\{\{\s*github\.event\.inputs\.ref_sha\s*\|\|\s*github\.sha\s*\}\}/
    );
  });
});

describe('the watchdog can actually raise', () => {
  const sql = read(MIGRATION);

  it('raises through the systems path, because pg_cron has no authenticated caller', () => {
    // fn_raise_financial_alert throws 'Authentication required to raise a
    // financial alert'. The first version of this function used it and would
    // have detected every incident and reported none of them.
    expect(sql).toContain('fn_raise_server_financial_alert');
    expect(sql).not.toMatch(/PERFORM\s+public\.fn_raise_financial_alert\(/);
  });

  it('watches all four ways a deploy can be a lie', () => {
    for (const source of [
      'deploy_truth.engine_heartbeat_stopped',
      'deploy_truth.engine_split_brain',
      'deploy_truth.pipeline_silent',
      'deploy_truth.engine_behind_target',
    ]) {
      expect(sql).toContain(source);
    }
  });

  it('treats the pipeline going quiet as its own alarm', () => {
    // The reason this is in the database and not in Actions.
    expect(sql).toContain('ca_engine_deploy_attempts');
    expect(sql).toMatch(
      /v_ever_reported\s+AND\s+v_last_attempt\s*<\s*now\(\)\s*-\s*c_silent_after/
    );
  });

  it('resolves each alarm when its condition clears, and raises once per episode', () => {
    // An alarm that re-raises every tick is a mute button; one that never
    // resolves is a permanent red light nobody looks at.
    expect(sql.match(/SET resolved = true, resolved_at = now\(\)/g) ?? []).toHaveLength(4);
    expect(sql.match(/AND NOT a\.resolved\) THEN/g) ?? []).toHaveLength(4);
  });

  it('keeps both definer functions away from the browser', () => {
    for (const fn of ['fn_ca_record_engine_deploy_attempt', 'fn_ca_engine_deploy_truth_watch']) {
      const revoke = new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*FROM PUBLIC, anon, authenticated;`
      );
      expect(sql).toMatch(revoke);
    }
  });
});

describe('zero engine rows are an outage, not an all-clear', () => {
  const sql = read(ZERO_ENGINE_FIX);

  it('uses the engine leader heartbeat as well as per-table leases', () => {
    expect(sql).toContain('public.engine_leader');
    expect(sql).toContain('public.engine_table_leases');
    expect(sql).toContain('v_engine_signal_live');
  });

  it('debounces a missing engine across the three-minute restart grace', () => {
    expect(sql).toContain('ca_engine_deploy_watch_state');
    expect(sql).toMatch(/v_engine_missing_since\s*<\s*now\(\)\s*-\s*c_heartbeat_dead/);
    expect(sql).not.toMatch(/IF\s+v_leases\s*>\s*0\s+AND\s+v_last_heartbeat/);
  });

  it('checks each minute so a three-minute grace is measurable', () => {
    expect(sql).toContain("'ca-engine-deploy-truth-1m'");
    expect(sql).toContain("'* * * * *'");
    expect(sql).toContain('pg_try_advisory_xact_lock');
  });

  it('keeps the new state private and the watcher service-only', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON TABLE public\.ca_engine_deploy_watch_state\s+FROM PUBLIC, anon, authenticated;/
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_engine_deploy_truth_watch\(\)\s+FROM PUBLIC, anon, authenticated;/
    );
  });
});

describe('later watchdog repairs cannot reset the engine-behind clock', () => {
  const sql = read(CONTINUOUS_BEHIND_FIX);

  it('measures one continuous mismatch episode across changing target shas', () => {
    expect(sql).toMatch(/left\(a\.target_sha, 8\) <> left\(v_running, 8\)/);
    expect(sql).toMatch(
      /SELECT max\(b\.at\)[\s\S]*left\(b\.target_sha, 8\) = left\(v_running, 8\)/
    );
    expect(sql).toContain('EXECUTE replace(v_definition, v_vulnerable, v_continuous)');
  });

  it('runs after every full watchdog definition in migration order', () => {
    const migrationDir = resolve(root, 'supabase', 'migrations');
    const migrations = readdirSync(migrationDir)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    const fullDefinitions = migrations.filter((name) =>
      readFileSync(resolve(migrationDir, name), 'utf8').includes(
        'CREATE OR REPLACE FUNCTION public.fn_ca_engine_deploy_truth_watch()'
      )
    );

    expect(fullDefinitions.length).toBeGreaterThan(0);
    expect(migrations.indexOf(CONTINUOUS_BEHIND_FIX.split('/').at(-1)!)).toBeGreaterThan(
      migrations.indexOf(fullDefinitions.at(-1)!)
    );
  });
});
