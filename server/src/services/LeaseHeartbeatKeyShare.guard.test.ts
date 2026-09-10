import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(process.cwd(), '..');
const migrations = join(repo, 'supabase', 'migrations');

const migrationPath = (suffix: string): string => {
  const matches = readdirSync(migrations)
    .filter((name) => name.endsWith(`_${suffix}`) || name.endsWith(`_${suffix}.pending`))
    .map((name) => join(migrations, name));
  expect(matches, `expected exactly one staged-or-promoted ${suffix}`).toHaveLength(1);
  return matches[0] ?? '';
};

const currentPostimagePath = migrationPath('stage_b_current_postimage_contraction.sql');
const keySharePath = migrationPath('stage_b_lease_keyshare_once.sql');
const SQL = readFileSync(keySharePath, 'utf8');
const RUNNER = readFileSync(
  join(repo, 'scripts', 'dev', 'probe-lease-heartbeat-keyshare-pg17.sh'),
  'utf8'
);
const FIXTURE = readFileSync(
  join(repo, 'scripts', 'dev', 'fixtures', 'lease-heartbeat-keyshare-pg17-bootstrap.sql'),
  'utf8'
);

describe('lease heartbeat locks remain live without weakening exact ownership', () => {
  it('is a fail-closed post-Stage-B stopped-engine cutover', () => {
    expect(currentPostimagePath < keySharePath).toBe(true);
    expect(keySharePath.endsWith('20260910060008_stage_b_lease_keyshare_once.sql')).toBe(true);
    expect(SQL).toContain('-- 20260910042137_stage_b_lease_keyshare_once');
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toContain("SET LOCAL lock_timeout = '5s';");
    expect(SQL).toContain("SET LOCAL statement_timeout = '30s';");
    expect(SQL).toContain('LOCK TABLE public.engine_table_leases IN ACCESS EXCLUSIVE MODE NOWAIT;');
    expect(SQL).toContain(
      'LOCK TABLE public.engine_tournament_leases IN ACCESS EXCLUSIVE MODE NOWAIT;'
    );
    const stoppedEngineBoundary = [
      'SELECT pg_advisory_xact_lock_shared(530090,1);',
      'DO $authenticate_stage_b_stopped_engine_authority$',
      'LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;',
      'LOCK TABLE public.engine_maintenance_break IN SHARE MODE NOWAIT;',
      'LOCK TABLE public.engine_leader IN EXCLUSIVE MODE NOWAIT;',
      'LOCK TABLE public.engine_table_leases IN ACCESS EXCLUSIVE MODE NOWAIT;',
      'LOCK TABLE public.engine_tournament_leases IN ACCESS EXCLUSIVE MODE NOWAIT;',
      'DO $require_stage_b_stopped_engine_authority$',
      'DO $require_strict_stage_b_topology$',
      'CREATE TEMP TABLE pg_temp.lease_keyshare_cutover_mode',
    ].map((marker) => SQL.indexOf(marker));

    for (const position of stoppedEngineBoundary) {
      expect(position).toBeGreaterThan(-1);
    }
    for (let index = 1; index < stoppedEngineBoundary.length; index += 1) {
      expect(stoppedEngineBoundary[index - 1]).toBeLessThan(stoppedEngineBoundary[index]);
    }
    expect(SQL).toContain('LEASE_KEYSHARE_REQUIRES_STRICT_STAGE_B');
    expect(SQL).toContain('public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)');
    expect(SQL).toContain(
      'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
    );
    expect(SQL).toContain(
      'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
    );
    expect(SQL).not.toMatch(/cron\.schedule|pg_cron|CREATE\s+(?:MATERIALIZED\s+)?VIEW/i);
  });

  it('makes owner and generation real PostgreSQL key columns before weakening a fence', () => {
    const tableKey = SQL.indexOf('ADD CONSTRAINT engine_table_leases_owner_generation_key');
    const tournamentKey = SQL.indexOf(
      'ADD CONSTRAINT engine_tournament_leases_owner_generation_key'
    );
    const patch = SQL.indexOf('DO $patch_effective_lease_fences$');

    expect(tableKey).toBeGreaterThan(-1);
    expect(tournamentKey).toBeGreaterThan(tableKey);
    expect(patch).toBeGreaterThan(tournamentKey);
    expect(SQL).toContain('UNIQUE (table_id, instance_id, lease_generation);');
    expect(SQL).toContain('UNIQUE (tournament_id, instance_id, lease_generation);');
    expect(SQL).not.toContain('CREATE UNIQUE INDEX CONCURRENTLY');
    expect(SQL).not.toMatch(/UNIQUE[\s\S]{0,120}\bWHERE\b/);
    expect(SQL).toContain("con.contype = 'u'");
    expect(SQL).toContain('AND con.convalidated');
    expect(SQL).toContain('AND NOT con.condeferrable');
    expect(SQL).toContain('AND idx.indisunique');
    expect(SQL).toContain('AND idx.indisvalid');
    expect(SQL).toContain('AND idx.indisready');
    expect(SQL).toContain('AND idx.indimmediate');
    expect(SQL).toContain('AND idx.indpred IS NULL');
    expect(SQL).toContain('AND idx.indexprs IS NULL');
    expect(SQL).toContain('AND idx.indnkeyatts = 3');
    expect(SQL).toContain('AND idx.indnatts = 3');
    expect(SQL).toContain('array_agg(att.attname ORDER BY key_column.ordinality)');
    expect(SQL).toContain('DO $refuse_heartbeat_key_columns$');
    expect(SQL).toContain("AND att.attname = 'heartbeat_at'");
    expect(SQL).toContain('LEASE_HEARTBEAT_KEY_COLUMN_INVALID');
  });

  it('authenticates the live repairs and patches only the two residual table-lease fences', () => {
    for (const identity of [
      'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)',
      'public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)',
      'public.fn_close_empty_tournament_table(uuid,uuid,uuid)',
      'smarter_private.fn_smarter_data_api_pre_request()',
    ]) {
      expect(SQL).toContain(identity);
    }

    expect(SQL.match(/EXECUTE replace\(v_source, v_before, v_after\);/g)).toHaveLength(2);
    expect(SQL.match(/v_count <> 1/g)).toHaveLength(2);
    expect(SQL).toContain('LEASE_FENCE_SOURCE_DRIFT: exact hand table fence');
    expect(SQL).toContain('LEASE_FENCE_SOURCE_DRIFT: pending add-on fence');
    expect(SQL).not.toContain('LEASE_FENCE_SOURCE_DRIFT: exact hand tournament fence');
    expect(SQL).not.toContain('LEASE_FENCE_SOURCE_DRIFT: empty-table close fence');
    expect(SQL).not.toContain('LEASE_FENCE_SOURCE_DRIFT: manager request fence');
    expect(SQL).toContain('20260910063559');
    expect(SQL).toContain('20260910064701');
    expect(SQL).toContain('73abfc4523de42cb4b8bca5443602cbd');
    expect(SQL).toContain('d1b5100c2b9f92bec5fd1680b0b4f230');
    expect(SQL).toContain('4a41b0124e75e46ed8121e6a56014758');
    expect(SQL).toContain('5e6c99545e07c21efcb50e5cb3441c14');
    expect(SQL).toContain('LEASE_KEYSHARE_UNKNOWN_PREIMAGE');
    expect(SQL).toContain('source preimage %, source postimage %');
    expect(SQL).toContain('FOR KEY SHARE;');
    expect(SQL).toContain(
      'FROM public.tournaments t\\n     WHERE t.id = v_tournament_id\\n     FOR SHARE;'
    );
    expect(SQL).toContain('pg_temp.lease_fence_metadata_before');
    expect(SQL).toContain('current_fn.proowner IS DISTINCT FROM snap.proowner');
    expect(SQL).toContain('current_fn.proacl IS DISTINCT FROM snap.proacl');
    expect(SQL).toContain('current_fn.prosecdef IS DISTINCT FROM snap.prosecdef');
    expect(SQL).toContain('current_fn.proconfig IS DISTINCT FROM snap.proconfig');
    expect(SQL).toContain('current_fn.provolatile IS DISTINCT FROM snap.provolatile');
    expect(SQL).toContain('current_fn.proparallel IS DISTINCT FROM snap.proparallel');
    expect(SQL).toContain('current_fn.prorettype IS DISTINCT FROM snap.prorettype');
    expect(SQL).toContain('LEASE_FENCE_METADATA_CHANGED');
    expect(SQL).toContain('residual lease-row FOR SHARE');
    expect(SQL).toContain('claim takeover is not FOR UPDATE before upsert');
    expect(SQL).toContain('FOR NO KEY UPDATE OF l SKIP LOCKED');
    expect(SQL).toContain('authenticated function sources drifted');
  });

  it('has a PostgreSQL 17 two-session proof for both tables and every effective function', () => {
    expect(RUNNER).toContain('postgresql@17');
    expect(RUNNER).toContain('LEASE_KEYSHARE_REQUIRES_STRICT_STAGE_B');
    expect(RUNNER).toContain('LEASE_HEARTBEAT_KEY_COLUMN_INVALID');
    expect(RUNNER).toContain('lease_probe_bad_table_heartbeat_key');
    expect(RUNNER).toContain('lease_probe_bad_tournament_heartbeat_key');
    expect(RUNNER).toContain("SET statement_timeout = '800ms'");
    expect(RUNNER).toContain('heartbeat_table_leases_v4');
    expect(RUNNER).toContain('heartbeat_tournament_leases_v4');
    expect(RUNNER).toContain("heartbeat_result\" != 'kept'");
    expect(RUNNER.match(/SET lock_timeout = '300ms'/g)).toHaveLength(2);
    expect(RUNNER.match(/grep -Fq '55P03'/g)).toHaveLength(2);
    expect(RUNNER).toContain("'exact-hand-cash'");
    expect(RUNNER).toContain("'pending-addon'");
    expect(RUNNER).toContain("'exact-hand-tournament'");
    expect(RUNNER).toContain("'empty-table-close'");
    expect(RUNNER).toContain("'manager-request-hook'");
    expect(RUNNER).toContain('LEASE_HEARTBEAT_KEYSHARE_PG17_OK');
    for (const migrationName of [
      '20260908042900_tournament_leases_have_fencing_generations.sql',
      '20260908043100_table_leases_and_hand_commits_have_generations.sql',
      '20260908043300_tournament_table_break_close_is_atomic.sql',
      '20260908125958_tournament_manager_requests_carry_lease_authority.sql',
      '20260908130009_post_commit_obligations_are_atomic_and_resumable.sql',
      '20260910063559_a_busy_manager_keeps_its_lease.sql',
      '20260910064701_a_hand_commit_does_not_hold_the_lease_against_its_own_heartb.sql',
      '20260910055955_stage_b_current_postimage_contraction.sql',
    ]) {
      expect(RUNNER).toContain(migrationName);
    }
    expect(RUNNER).toContain('extract_function_with_marker');
    expect(RUNNER).toContain("'p_lease_generation uuid'");
    expect(RUNNER.indexOf('-f "$busy_manager_migration"')).toBeLessThan(
      RUNNER.indexOf('-f "$hand_heartbeat_migration"')
    );
    expect(RUNNER.indexOf('-f "$hand_heartbeat_migration"')).toBeLessThan(
      RUNNER.indexOf('-f "$stage_b_hook_sql"')
    );
    expect(RUNNER.indexOf('-f "$stage_b_hook_sql"')).toBeLessThan(
      RUNNER.indexOf('-f "$migration"')
    );
    expect(FIXTURE).toContain('tournament_mutator_scheduler_retirement_receipts');
    expect(FIXTURE).toContain('20260910042112_stage_b_current_postimage_contraction');
    expect(FIXTURE).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_ca_commit_hand_settlement_exact_before_obligations\s*\(/
    );
    expect(FIXTURE).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_ca_resolve_unbound_pending_addons\s*\(/
    );
    expect(FIXTURE).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_close_empty_tournament_table\s*\(/
    );
    expect(FIXTURE).not.toMatch(
      /CREATE OR REPLACE FUNCTION smarter_private\.fn_smarter_data_api_pre_request\s*\(/
    );
    for (const exactPreimageHash of [
      'e3a2120fc6db33ad84fc4967126fe9b8',
      '276314a02cecc35607cde1afdc2fdf21',
      '0af954ab1264dc12ebce7741b7845343',
      'f85b1aa5d752c9ca90a50cefc7e2dbf7',
      '73abfc4523de42cb4b8bca5443602cbd',
      '4a41b0124e75e46ed8121e6a56014758',
    ]) {
      expect(SQL).toContain(exactPreimageHash);
    }
  });
});
