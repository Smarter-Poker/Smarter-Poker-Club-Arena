import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261006012010_a_resolved_incident_never_predates_its_detection.sql'
  ),
  'utf8'
);
const md5 = (value: string) => createHash('md5').update(value).digest('hex');

describe('drift incident timeline law', () => {
  it('bounds only the known alert mirror and refuses every other impossible write', () => {
    expect(sql).toContain(
      'resolved_at = GREATEST(COALESCE(NEW.resolved_at, now()), i.detected_at)'
    );
    expect(sql).toContain("RAISE EXCEPTION 'drift incident deadline cannot precede detection'");
    expect(sql).toContain("RAISE EXCEPTION 'drift incident resolution cannot precede detection'");
    expect(sql).toContain(
      "RAISE EXCEPTION 'drift incident resolved status must match its resolution time'"
    );
    expect(sql).toContain("((status = 'resolved') IS DISTINCT FROM (resolved_at IS NOT NULL))");
    expect(sql).not.toContain('NEW.resolved_at := NEW.detected_at');
    expect(sql).toContain("WHERE id='e4766bae-5db1-4ed2-b2a1-a46dc3e908ed'::uuid");
    expect(sql).toContain('IF v_invalid <> 1');
    expect(sql).not.toContain('WHERE resolved_at < detected_at;');
  });

  it('pins the alert mirror preimage without baselining an unlisted trigger', () => {
    expect(sql).toContain("md5(p.prosrc)='40ab72a641e2ea070426866e36f626be'");
    expect(sql).toContain("md5(pg_get_functiondef(p.oid))='dbe622139f98faf98bca7bc30db0155c'");
    expect(sql).toContain("md5(p.prosrc)='0e11283b0fb32102007958c70d631773'");
    expect(sql).toContain("md5(pg_get_functiondef(p.oid))='e4a7c3e2099706adf19c4bd3885c6dbb'");
    expect(sql).toContain("md5(p.prosrc)='cbb93e769afe3ff462fb68e6d8f23e4a'");
    expect(sql).toContain("md5(pg_get_functiondef(p.oid))='86e3c04a77d99595901a1810b291ca3f'");
    expect(sql).toContain('ANY (public.fn_ca_guard_watchlist())');
    expect(sql).toContain("RAISE EXCEPTION 'DRIFT_INCIDENT_ALERT_MIRROR_REGISTRY_CHANGED'");
    expect(sql).toContain("WHERE d.proname='fn_ca_alert_resolution_reaches_the_incident'");
    expect(sql).not.toContain(
      "fn_ca_declare_guard_redefinition(\n  'fn_ca_alert_resolution_reaches_the_incident'"
    );
  });

  it('pins the exact timeline guard body and PostgreSQL function definition', () => {
    const signature = 'CREATE FUNCTION public.fn_ca_drift_incident_timeline_guard()';
    const functionStart = sql.indexOf(signature);
    const bodyStart = sql.indexOf('AS $function$', functionStart) + 'AS $function$'.length;
    const bodyEnd = sql.indexOf('$function$;', bodyStart);
    const body = sql.slice(bodyStart, bodyEnd);
    const definition =
      'CREATE OR REPLACE FUNCTION public.fn_ca_drift_incident_timeline_guard()\n' +
      ' RETURNS trigger\n' +
      ' LANGUAGE plpgsql\n' +
      ' SECURITY DEFINER\n' +
      " SET search_path TO 'pg_catalog'\n" +
      'AS $function$' +
      body +
      '$function$\n';

    expect(md5(body)).toBe('cbb93e769afe3ff462fb68e6d8f23e4a');
    expect(md5(definition)).toBe('86e3c04a77d99595901a1810b291ca3f');
  });

  it('probes both contradictions and reads back the exact durable catalog objects', () => {
    expect(sql).toContain("VALUES (3, 'resolved'");
    expect(sql).toContain("VALUES (4, 'open'");
    expect(sql).toContain("SET status='resolved'");
    expect(sql).toContain('IF v_refused <> 5');
    expect(sql).toContain(
      "CHECK (((deadline_at >= detected_at) AND ((resolved_at IS NULL) OR (resolved_at >= detected_at)) AND ((status = ''resolved''::text) = (resolved_at IS NOT NULL))))"
    );
    expect(sql).toContain(
      'CREATE TRIGGER trg_ca_drift_incident_timeline BEFORE INSERT OR UPDATE OF status, detected_at, deadline_at, resolved_at ON public.ca_drift_incidents FOR EACH ROW EXECUTE FUNCTION fn_ca_drift_incident_timeline_guard()'
    );
    expect(sql).toContain("(attname='status' AND atttypid='text'::regtype AND attnotnull)");
  });
});
