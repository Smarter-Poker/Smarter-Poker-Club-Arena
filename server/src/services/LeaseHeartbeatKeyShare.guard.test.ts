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
    expect(keySharePath.endsWith('20260910042137_stage_b_lease_keyshare_once.sql')).toBe(true);
    expect(SQL).toContain('-- 20260910042137_stage_b_lease_keyshare_once');
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toContain("SET LOCAL lock_timeout = '5s';");
    expect(SQL).toContain("SET LOCAL statement_timeout = '30s';");
    expect(SQL).toContain('LOCK TABLE public.engine_table_leases IN ACCESS EXCLUSIVE MODE NOWAIT;');
    expect(SQL).toContain(
      'LOCK TABLE public.engine_tournament_leases IN ACCESS EXCLUSIVE MODE NOWAIT;'
    );
    expect(SQL.indexOf('DO $require_strict_stage_b_topology$')).toBeLessThan(
      SQL.indexOf('LOCK TABLE public.engine_table_leases')
    );
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

  it('patches only the four surviving lease fences and preserves function metadata', () => {
    for (const identity of [
      'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)',
      'public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)',
      'public.fn_close_empty_tournament_table(uuid,uuid,uuid)',
      'smarter_private.fn_smarter_data_api_pre_request()',
    ]) {
      expect(SQL).toContain(identity);
    }

    expect(SQL.match(/EXECUTE replace\(v_source, v_before, v_after\);/g)).toHaveLength(4);
    expect(SQL.match(/v_count <> 1/g)).toHaveLength(5);
    expect(SQL).toContain('LEASE_FENCE_SOURCE_DRIFT: exact hand table fence');
    expect(SQL).toContain('LEASE_FENCE_SOURCE_DRIFT: exact hand tournament fence');
    expect(SQL).toContain('LEASE_FENCE_SOURCE_DRIFT: pending add-on fence');
    expect(SQL).toContain('LEASE_FENCE_SOURCE_DRIFT: empty-table close fence');
    expect(SQL).toContain('LEASE_FENCE_SOURCE_DRIFT: manager request fence');
    expect(SQL).toContain('FOR KEY SHARE;');
    expect(SQL).toContain(
      'FROM public.tournaments t\\n     WHERE t.id = v_tournament_id\\n     FOR SHARE;'
    );
    expect(SQL).toContain('pg_temp.lease_fence_metadata_before');
    expect(SQL).toContain('current_fn.proowner IS DISTINCT FROM snap.proowner');
    expect(SQL).toContain('current_fn.proacl IS DISTINCT FROM snap.proacl');
    expect(SQL).toContain('current_fn.prosecdef IS DISTINCT FROM snap.prosecdef');
    expect(SQL).toContain('current_fn.proconfig IS DISTINCT FROM snap.proconfig');
    expect(SQL).toContain('LEASE_FENCE_METADATA_CHANGED');
    expect(SQL).toContain('residual lease-row FOR SHARE');
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
    expect(FIXTURE).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations('
    );
    expect(FIXTURE).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_ca_resolve_unbound_pending_addons('
    );
    expect(FIXTURE).toContain('CREATE OR REPLACE FUNCTION public.fn_close_empty_tournament_table(');
    expect(FIXTURE).toContain(
      'CREATE OR REPLACE FUNCTION smarter_private.fn_smarter_data_api_pre_request()'
    );
  });
});
