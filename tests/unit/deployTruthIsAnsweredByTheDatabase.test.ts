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

const deployControlFunctions = [
  'fn_ca_deploy_dispatch_tick',
  'fn_ca_deploy_run_exists_this_hour',
  'fn_ca_record_engine_deploy_start',
  'fn_ca_prune_deploy_run_markers',
  'fn_ca_engine_deploy_truth_watch',
];

const retiredFunctions = [
  'autofix_attempts_touch_updated_at',
  'autofix_budget_exhausted',
  'autofix_daily_spend_usd',
  'autofix_is_paused',
  ...deployControlFunctions,
];

const retiredRelations = [
  'autofix_attempts',
  'autofix_attempts_summary',
  'autofix_budget',
  'autofix_config',
  'autofix_projects',
  'ca_deploy_dispatch_config',
  'ca_deploy_dispatch_log',
  'ca_engine_deploy_runs_started',
  'ca_engine_deploy_watch_state',
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

    expect(recorder).toContain(
      'SELECT public.fn_ca_record_engine_deploy_attempt($1, $2, $3, $4, $5) AS id'
    );
    expect(recorder).not.toContain('fn_ca_engine_deploy_truth_watch');
    expect(recorder).not.toMatch(/['"`]\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
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
    for (const functionName of deployControlFunctions) {
      expect(sql).toContain(functionName);
    }
    expect(sql).toContain('sentry.?autofix|autofix_');
    expect(sql).toContain('PERFORM cron.unschedule(v_job_id)');
  });

  it('drops every Sentry autofix helper and every overload of each deploy control function', () => {
    const dropBlock = sql.slice(
      sql.indexOf('-- Drop every overload of every retired function'),
      sql.indexOf('-- This secret existed solely')
    );

    expect(dropBlock).toContain('pg_get_function_identity_arguments');
    expect(dropBlock).toContain("'DROP FUNCTION %I.%I(%s)'");
    expect(dropBlock).toContain("p.proname ~ '^autofix_'");
    for (const functionName of deployControlFunctions) {
      expect(dropBlock).toContain(`'${functionName}'`);
    }
    expect(dropBlock).not.toContain('fn_ca_record_engine_deploy_attempt');
  });

  it('removes every Sentry autofix view and trigger without an unreviewed cascade', () => {
    const viewBlock = sql.slice(
      sql.indexOf('-- Remove every retired autofix view'),
      sql.indexOf('-- Detach every retired autofix trigger')
    );
    const triggerBlock = sql.slice(
      sql.indexOf('-- Detach every retired autofix trigger'),
      sql.indexOf('-- Drop every overload of every retired function')
    );

    expect(viewBlock).toContain("c.relname ~ '^autofix_'");
    expect(viewBlock).toContain("'DROP MATERIALIZED VIEW public.%I'");
    expect(viewBlock).toContain("'DROP VIEW public.%I'");
    expect(viewBlock).not.toMatch(/DROP\s+(?:MATERIALIZED\s+)?VIEW[^;\n]*\sCASCADE/i);
    expect(triggerBlock).toContain("p.proname ~ '^autofix_'");
    expect(triggerBlock).toContain("'DROP TRIGGER %I ON public.%I'");
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

  it('moves every historical table by identifier and proves its OID and row count survived', () => {
    expect(sql).toContain('CREATE TEMP TABLE ca_retirement_relation_snapshot');
    expect(sql).toContain("c.relname ~ '^autofix_'");
    for (const table of retiredRelations.filter((name) => name.startsWith('ca_'))) {
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain("'ALTER TABLE public.%I SET SCHEMA ca_archive'");
    expect(sql).toContain('v_relation.relation_oid');
    expect(sql).toContain('v_row_count <> v_relation.row_count');
    expect(sql).toContain('retired relation % changed row count');
  });

  it('locks every archived table and sequence away from every runtime role', () => {
    expect(sql).toContain(
      'REVOKE ALL ON ALL TABLES IN SCHEMA ca_archive FROM PUBLIC, anon, authenticated, service_role'
    );
    expect(sql).toContain(
      'REVOKE ALL ON ALL SEQUENCES IN SCHEMA ca_archive FROM PUBLIC, anon, authenticated, service_role'
    );
    expect(sql).toContain("ARRAY['anon', 'authenticated', 'service_role']");
    expect(sql).toContain("has_schema_privilege(v_role, 'ca_archive', 'USAGE')");
    expect(sql).toContain('has_table_privilege(v_role, v_relation.oid');
    expect(sql).toContain('has_sequence_privilege(v_role, v_relation.oid');
  });

  it('fails closed if any cron, function, relation, secret, or public watcher state survives', () => {
    const assertions = sql.slice(sql.indexOf('-- Fail closed'));

    expect(assertions).toContain('FROM cron.job');
    expect(assertions).toContain('FROM pg_proc p');
    expect(assertions).toContain('FROM pg_class c');
    expect(assertions).toContain('FROM vault.secrets');
    expect(assertions).toContain("c.relname ~ '^autofix_'");
    expect(assertions).toContain("p.proname ~ '^autofix_'");
    expect(assertions).toContain('retired Club Arena relations remain public');
    expect(assertions).toContain('retired Club Arena deployment functions remain');
  });

  it('preserves receipt history and makes the recorder its only runtime append path', () => {
    expect(sql).toContain('CREATE TEMP TABLE ca_retirement_receipt_snapshot');
    expect(sql).toContain("to_regclass('public.ca_engine_deploy_attempts')");
    expect(sql).toContain('public.fn_ca_record_engine_deploy_attempt(text,boolean,text,text,text)');
    expect(sql).toContain('append-only Club Arena deployment receipt history changed');
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public.ca_engine_deploy_attempts\n  FROM PUBLIC, anon, authenticated, service_role'
    );
    expect(sql).toContain('GRANT SELECT ON TABLE public.ca_engine_deploy_attempts TO service_role');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.fn_ca_record_engine_deploy_attempt');
    expect(sql).toContain("NOT has_table_privilege('service_role'");
    expect(sql).toContain("NOT has_function_privilege(\n       'service_role'");
    expect(sql).toContain('AND p.prosecdef');
    expect(sql).toContain("'search_path=public, pg_temp'");
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
    for (const relation of retiredRelations) {
      expect(manifest.tables).not.toContain(relation);
      expect(columns.columns).not.toHaveProperty(relation);
    }
    for (const functionName of retiredFunctions) {
      expect(manifest.functions).not.toContain(functionName);
    }
  });
});
