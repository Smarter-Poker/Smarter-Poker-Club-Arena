/**
 * Deployment receipts remain append-only audit evidence, but the database is
 * no longer allowed to dispatch, poll, reconcile, or infer release state.
 * Live identity is proved synchronously by the Hetzner release workflow.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadColumnsManifest, loadSchemaManifest } from '../../scripts/ci/schema-manifest.mjs';

const root = resolve(__dirname, '..', '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const WORKFLOW = '.github/workflows/auto-deploy-hetzner.yml';
const RECORDER = 'scripts/ci/record-engine-deploy-attempt.mjs';
const RETIREMENT =
  'supabase/migrations/20260910153400_retire_legacy_autofix_and_db_deploy_dispatch.sql';

const retiredFunctions = [
  'fn_ca_deploy_dispatch_tick',
  'fn_ca_deploy_run_exists_this_hour',
  'fn_ca_record_engine_deploy_start',
  'fn_ca_prune_deploy_run_markers',
  'fn_ca_engine_deploy_truth_watch',
];

describe('the deploy pipeline leaves an append-only audit receipt', () => {
  it('records every run against the exact resolved target sha', () => {
    const workflow = read(WORKFLOW);
    const step = workflow.slice(workflow.indexOf('Record append-only deployment receipt'));
    const guard = step.slice(0, step.indexOf('run: |'));

    expect(step).toContain('node scripts/ci/record-engine-deploy-attempt.mjs');
    expect(step).toContain('TARGET_SHA: ${{ needs.preflight.outputs.target_sha }}');
    expect(step).toContain("STRICT_RECEIPT: '1'");
    expect(guard).toContain('if: always()');
  });

  it('writes through the receipt function and is strict only in the release lane', () => {
    const recorder = read(RECORDER);

    expect(recorder).toContain('fn_ca_record_engine_deploy_attempt');
    expect(recorder).not.toContain('fn_ca_engine_deploy_truth_watch');
    expect(recorder).toContain("const strictReceipt = process.env.STRICT_RECEIPT === '1'");
    expect(recorder).toMatch(/if \(strictReceipt\)[\s\S]{0,180}?process\.exit\(1\)/);
    expect(recorder).toContain('process.exit(0)');
  });
});

describe('the legacy database deployment control plane is retired at the root', () => {
  const sql = read(RETIREMENT);

  it('unschedules every known job name and any renamed job invoking a retired function', () => {
    for (const jobName of [
      'ca-deploy-dispatch',
      'ca-deploy-run-marker-prune',
      'ca-engine-deploy-truth-10m',
      'ca-engine-deploy-truth-1m',
    ]) {
      expect(sql).toContain(`'${jobName}'`);
    }

    expect(sql).toContain('lower(command) ~');
    for (const functionName of retiredFunctions) {
      expect(sql).toContain(functionName);
    }
    expect(sql).toContain('PERFORM cron.unschedule(v_job_id)');
  });

  it('drops every overload of each retired function, but not the receipt writer', () => {
    const dropBlock = sql.slice(
      sql.indexOf('-- Drop every overload'),
      sql.indexOf('-- This secret existed solely')
    );

    expect(dropBlock).toContain('pg_get_function_identity_arguments');
    expect(dropBlock).toContain("'DROP FUNCTION %I.%I(%s)'");
    for (const functionName of retiredFunctions) {
      expect(dropBlock).toContain(`'${functionName}'`);
    }
    expect(dropBlock).not.toContain('fn_ca_record_engine_deploy_attempt');
  });

  it('deletes only the named dispatcher secret without ever reading its value', () => {
    const secretBlock = sql.slice(
      sql.indexOf('-- This secret existed solely'),
      sql.indexOf('CREATE SCHEMA IF NOT EXISTS ca_archive')
    );

    expect(secretBlock).toContain('DELETE FROM vault.secrets WHERE name = $1');
    expect(secretBlock).toContain("USING 'ca_deploy_dispatch_token'");
    expect(secretBlock).not.toContain('decrypted_secret');
    expect(secretBlock).not.toMatch(/DELETE FROM vault\.secrets\s*;/);
  });

  it('locks the historical dispatcher and watcher state outside public runtime access', () => {
    for (const table of [
      'ca_deploy_dispatch_config',
      'ca_deploy_dispatch_log',
      'ca_engine_deploy_runs_started',
      'ca_engine_deploy_watch_state',
    ]) {
      expect(sql).toContain(`ALTER TABLE public.${table} SET SCHEMA ca_archive`);
    }
    expect(sql).toContain(
      'REVOKE ALL ON ALL TABLES IN SCHEMA ca_archive FROM PUBLIC, anon, authenticated, service_role'
    );
  });

  it('fails closed if a cron, function, secret, or public watcher state survives', () => {
    const assertions = sql.slice(sql.indexOf('-- Fail closed'));

    expect(assertions).toContain('FROM cron.job');
    expect(assertions).toContain('FROM pg_proc p');
    expect(assertions).toContain('SELECT count(*) FROM vault.secrets WHERE name = $1');
    expect(assertions).toContain("to_regclass('public.ca_engine_deploy_watch_state')");
    expect(assertions.match(/RAISE EXCEPTION/g) ?? []).toHaveLength(5);
  });

  it('explicitly proves the append-only receipt table and function survived', () => {
    expect(sql).toContain("to_regclass('public.ca_engine_deploy_attempts')");
    expect(sql).toContain('public.fn_ca_record_engine_deploy_attempt(text,boolean,text,text,text)');
    expect(sql).toContain('append-only Club Arena deployment receipt was removed');
  });
});

describe('the active schema contract contains receipts, not legacy controls', () => {
  const manifest = loadSchemaManifest(root);
  const columns = loadColumnsManifest(root);

  it('keeps the append-only receipt surfaces', () => {
    expect(manifest.tables).toContain('ca_engine_deploy_attempts');
    expect(manifest.functions).toContain('fn_ca_record_engine_deploy_attempt');
  });

  it('excludes the retired watcher and dispatcher surfaces', () => {
    for (const relation of [
      'ca_deploy_dispatch_config',
      'ca_deploy_dispatch_log',
      'ca_engine_deploy_runs_started',
      'ca_engine_deploy_watch_state',
    ]) {
      expect(manifest.tables).not.toContain(relation);
    }
    expect(columns.columns).not.toHaveProperty('ca_engine_deploy_watch_state');
    for (const functionName of retiredFunctions) {
      expect(manifest.functions).not.toContain(functionName);
    }
  });
});
