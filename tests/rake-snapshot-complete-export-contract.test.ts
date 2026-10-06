import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260921183648_club_data_exports_expire_at_the_door.sql'
  ),
  'utf8'
);
const baseExportMigration = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260831144500_club_data_complete_export_jobs.sql'),
  'utf8'
);

function functionBody(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) return '';
  const end = migration.indexOf('$function$;', start);
  return migration.slice(start, end < 0 ? undefined : end);
}

const startRpc = functionBody('ca_rake_export_start');
const pageRpc = functionBody('ca_club_data_export_page');
const agentGate = functionBody('ca_can_read_rake_agent');

describe('Rake Snapshot complete export contract', () => {
  it('keeps every DDL change and self-check in one transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration.lastIndexOf('$no_expiry_schedule$;')).toBeLessThan(
      migration.lastIndexOf('COMMIT;')
    );
  });

  it('extends the private job store with a checked immutable Rake context', () => {
    expect(migration).toContain("CHECK (kind IN ('games', 'players', 'rake'))");
    for (const column of [
      'scope_type text',
      'scope_id uuid',
      'union_id uuid',
      'agent_user_id uuid',
      'date_from date',
      'date_to date',
      'request_search text',
      'sort_key text',
      'total_amount numeric',
      "metadata jsonb NOT NULL DEFAULT '{}'::jsonb",
      'metadata_fingerprint text',
    ]) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain('ca_club_data_exports_rake_context_check');
    expect(migration).toContain("metadata ->> 'kind' = 'rake'");
    expect(migration).toContain('metadata_fingerprint = md5(metadata::text)');
    expect(migration).toContain('idx_ca_club_data_exports_one_per_user');
    expect(baseExportMigration).toContain('PRIMARY KEY (export_id, ordinal)');
  });

  it('has one public start door with bounded idempotent resource ownership', () => {
    expect(startRpc).toContain('p_scope_type text');
    expect(startRpc).toContain('p_scope_id uuid');
    expect(startRpc).toContain('p_request_id uuid DEFAULT gen_random_uuid()');
    expect(startRpc).toContain('pg_try_advisory_xact_lock');
    expect(startRpc).toContain('ca-club-data-export-user:');
    expect(startRpc).toContain('active_slot.user_id = v_user');
    expect(startRpc).toContain('v_max_rows constant integer := 20000');
    expect(startRpc).toContain('agent_capacity AS MATERIALIZED');
    expect(startRpc).toContain("USING ERRCODE = '54000'");
    expect(startRpc).toContain('v_inserted IS DISTINCT FROM v_reported');
    expect(startRpc).toContain('expires_at');
  });

  it('materializes through canonical Rake logic without a second financial query', () => {
    expect(startRpc).toContain('WITH first_snapshot AS MATERIALIZED');
    expect(startRpc).toContain('public.ca_rake_snapshot(');
    expect(startRpc).toContain('public.fn_ca_rake_by_agent(');
    expect(startRpc).toContain('public.fn_ca_rake_by_club(');
    expect(startRpc).toContain('public.fn_ca_rake_by_downline(');
    expect(startRpc).toContain('page_packs AS MATERIALIZED');
    expect(startRpc).toContain('inserted_rows AS (');
    for (const forbidden of [
      'FROM public.rake_records',
      'FROM public.agent_commissions',
      'FROM public.club_rake_daily_user',
      'FROM public.ca_club_rake_daily_user',
      'fn_rake_shares_for_record',
    ]) {
      expect(startRpc).not.toContain(forbidden);
    }
  });

  it('makes page boundaries identity-deterministic', () => {
    expect(migration).toContain('f.agent_user_id::text ASC NULLS LAST');
    expect(migration).toContain('f.club_id::text ASC');
    expect(migration).toContain('f.player_id::text ASC');
    expect(migration).toContain('NULL, 20001) d');
    expect(startRpc).toContain("collected.row_data ->> 'agent_user_id'");
    expect(startRpc).toContain("collected.row_data ->> 'club_id'");
    expect(startRpc).toContain("collected.row_data ->> 'player_id'");
    expect(startRpc).toContain('(SELECT count(*) FROM inserted_rows) = ready_metadata.total');
  });

  it('rechecks club, union, delegated-agent, and cost claims on every page', () => {
    expect(pageRpc).toContain('public.ca_can_read_club_production(v_job.club_id)');
    expect(pageRpc).toContain('public.ca_can_oversee_union(v_job.union_id)');
    expect(pageRpc).toContain('public.ca_can_read_rake_agent(');
    expect(agentGate).toContain('public.fn_is_agent_ancestor');
    expect(agentGate).toContain('public.fn_is_club_admin_uid');
    expect(agentGate).toContain('public.fn_is_union_overseer');
    expect(pageRpc).toContain('prepared_union_row.export_id = p_export_id');
    expect(pageRpc).toContain('WITH RECURSIVE current_tree AS');
    expect(pageRpc).toContain("prepared_agent_row.payload ->> 'player_id'");
    expect(pageRpc).toContain("v_job.metadata ->> 'contains_admin_commission'");
  });

  it('keeps expiry separate from access loss and echoes immutable metadata', () => {
    expect(pageRpc).toContain("RAISE EXCEPTION 'export is unavailable'");
    expect(pageRpc).toContain("RAISE EXCEPTION 'export expired; prepare a new export'");
    expect(pageRpc).toContain("RAISE EXCEPTION 'export is no longer authorized'");
    expect(pageRpc).toContain("USING ERRCODE = '42501'");
    for (const field of [
      'schema_version',
      'kind',
      'scope_type',
      'scope_id',
      'club_id',
      'union_id',
      'agent_user_id',
      'date_from',
      'date_to',
      'search',
      'sort',
      'generated_at',
      'breakdown_kind',
      'breakdown_total',
      'commission_total',
      'contains_admin_commission',
    ]) {
      expect(startRpc).toContain(`'${field}'`);
    }
    for (const body of [startRpc, pageRpc]) {
      expect(body).toContain("'metadata'");
      expect(body).toContain("'metadata_fingerprint'");
    }
    expect(startRpc).not.toContain("'is_horse'");
  });

  it('keeps prepared rows private and exposes only authenticated RPC doors', () => {
    expect(baseExportMigration).toContain(
      'REVOKE ALL ON TABLE public.ca_club_data_export_rows FROM PUBLIC, anon, authenticated'
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.ca_can_read_rake_agent\(uuid, uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated;/
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.ca_rake_export_start\([\s\S]*?\) TO authenticated, service_role;/
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.ca_club_data_export_page\(uuid, integer, integer\)[\s\S]*?TO authenticated, service_role;/
    );
  });
});
