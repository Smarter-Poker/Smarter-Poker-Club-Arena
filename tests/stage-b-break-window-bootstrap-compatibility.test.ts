import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const compatibility = readFileSync(
  resolve(
    root,
    'supabase/migrations/20260910164655_stage_b_break_window_bootstrap_compatibility.sql'
  ),
  'utf8'
);

describe('Stage-B break-window ledger-bootstrap compatibility is a closed exception', () => {
  it('binds the admission to the exact transport, guard receipt and canonical history catalog', () => {
    expect(compatibility).toContain("p_session_role IS DISTINCT FROM 'postgres'");
    expect(compatibility).toContain("p_application IS DISTINCT FROM 'mgmt-api'");
    expect(compatibility).toContain(
      'begin; create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations'
    );
    expect(compatibility).toContain("'-- source: POST /mcp' || pg_catalog.chr(10)");
    expect(compatibility).toContain(
      "v_suffix !~ '^-- source: POST /mcp\\n-- user: oauth:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\n-- date: [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'"
    );
    expect(compatibility).toContain('pg_catalog.substr(v_raw_query, 1, v_separator_at - 1)');
    expect(compatibility).toContain("sm.version = '20260910154446'");
    expect(compatibility).toContain(
      '772758b80f3a5f44296b84aabdb1def68278f541a1d49b8b58c49f33c5d9f082'
    );
    expect(compatibility).toContain('octet_length(sm.statements[1]) = 20519');
    expect(compatibility).toContain("sm.version = '20260910160841'");
    expect(compatibility).toContain(
      '7e018da306ab9d56e82fa603f84535174a2975793aa7a74c4a4e931fc83ef34d'
    );
    expect(compatibility).toContain("md5(p.prosrc) = '838c294990ba4e53743b5f3df0304b1c'");
    expect(compatibility).toContain(
      "md5(pg_catalog.pg_get_functiondef(p.oid)) = 'fe9c0a7069362892dbc40ac025e2294f'"
    );
    expect(compatibility.match(/pg_catalog\.aclexplode\(p\.proacl\)/g)).toHaveLength(4);
    expect(compatibility).toContain("grantee_role.rolname IN ('postgres', 'service_role')");
    expect(compatibility).toContain("acl.privilege_type = 'EXECUTE'");
    expect(compatibility).toContain('break-window guard compatibility changed its exact ACL');
    expect(compatibility).toContain("(6, 'rollback',       'text[]', false)");
    expect(compatibility).toContain("pg_get_constraintdef(c.oid, true) = 'PRIMARY KEY (version)'");
    expect(compatibility).toContain(
      "pg_get_constraintdef(c.oid, true) = 'UNIQUE (idempotency_key)'"
    );
  });

  it('requires the same serialized stopped-engine boundary before every admitted ALTER', () => {
    const predicate = compatibility.slice(
      compatibility.indexOf('CREATE FUNCTION public.fn_ca_stage_b_ledger_bootstrap_allowed'),
      compatibility.indexOf('REVOKE ALL ON FUNCTION public.fn_ca_stage_b_ledger_bootstrap_allowed')
    );
    expect(predicate).toContain('pg_try_advisory_xact_lock_shared(530090, 1)');
    expect(predicate).toContain('LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT');
    expect(predicate).toContain('LOCK TABLE public.engine_maintenance_break IN SHARE MODE NOWAIT');
    expect(predicate).toContain("b.phase = 'counting_down'");
    expect(predicate).toContain("b.break_ends_at >= clock_timestamp() + interval '3 minutes'");
    expect(predicate).toContain('public.fn_platform_frozen() IS DISTINCT FROM true');
    expect(predicate).toContain('public.fn_entry_purchases_frozen() IS DISTINCT FROM true');
    expect(
      predicate.match(/heartbeat_at >= clock_timestamp\(\) - interval '30 seconds'/g)
    ).toHaveLength(3);
    expect(predicate).toContain('EXCEPTION WHEN OTHERS THEN');
    expect(predicate).toContain('RETURN false;');
  });

  it('does not turn the compatibility marker into a general override', () => {
    expect(compatibility).toContain("v_what = 'ALTER TABLE supabase_migrations.schema_migrations'");
    expect(compatibility).toContain(
      'fn_ca_stage_b_ledger_bootstrap_allowed(\n             current_query(), v_app, session_user::text)'
    );
    expect(compatibility).toContain("current_setting('ca.stage_b_ledger_bootstrap_audited', true)");
    expect(compatibility).not.toContain(
      "set_config('ca.break_window_override_in_force', txid_current()::text, true);\n        INSERT INTO public.ca_break_window_migration_overrides"
    );

    // The original path remains after the narrow branch. Actual Stage-B DDL
    // therefore still needs its separately audited SET LOCAL reason.
    const narrowBranch = compatibility.indexOf('ca.stage_b_ledger_bootstrap_audited');
    const generalOverride = compatibility.indexOf(
      "IF current_setting('ca.break_window_override_in_force'",
      narrowBranch
    );
    const refusal = compatibility.lastIndexOf("MESSAGE = 'migration refused: '");
    expect(narrowBranch).toBeGreaterThan(0);
    expect(generalOverride).toBeGreaterThan(narrowBranch);
    expect(refusal).toBeGreaterThan(generalOverride);
    expect(compatibility).toContain('IF v_stage_b_bootstrap THEN\n      RAISE;');
    expect(compatibility).toContain('Production DDL policy, rule 8 (the break window).');
    expect(compatibility).toContain("WHEN v_schema = 'supabase_migrations' THEN");
  });

  it('keeps its predicate private from every API role', () => {
    expect(compatibility).toContain(
      'SECURITY DEFINER\nSET search_path = pg_catalog, public, pg_temp'
    );
    expect(compatibility).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_stage_b_ledger_bootstrap_allowed(text,text,text)\n  FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(compatibility).toContain(
      "NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')"
    );
    expect(compatibility).toContain(
      "NOT pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')"
    );
    expect(compatibility).toContain(
      "NOT pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')"
    );
  });
});
