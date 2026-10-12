import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const migration = readSource(
  'supabase/migrations/20261006024259_drift_consoles_show_only_their_registered_reviewers.sql'
);
const gate = readSource('src/components/auth/FinancialAdminGate.tsx');
const service = readSource('src/services/DriftIncidentService.ts');
const page = readSource('src/pages/DriftIncidentsPage.tsx');
const app = readSource('src/App.tsx');

function functionBody(name: string): string {
  const declaration = new RegExp(
    `CREATE(?: OR REPLACE)? FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`
  );
  const body = migration.match(declaration)?.[1];
  expect(body, `${name} must have one readable migration body`).toBeDefined();
  return body as string;
}

const md5 = (value: string) => createHash('md5').update(value).digest('hex');

const postimageBodyHashes = {
  fn_ca_can_view_drift_console: 'f5da9d3b8fae7b840878498b67c6fc82',
  fn_ca_incident_dashboard: 'eba4e72a10c4667ca8e09d17c3a20868',
  fn_ca_drift_metrics: '68eaf86fa89d48255ab75e2503f645d5',
  fn_ca_gate_panel: '1fd06b5d4526e8e15cabfa823da329c2',
  fn_ca_balance_asof_admin: '2bb316de9ab7e8051c39f943477bbfd3',
} as const;

const postimageDefinitionHashes = {
  fn_ca_can_view_drift_console: '8e8acf21077ffb728c4fd461cc1d723a',
  fn_ca_incident_dashboard: '2a7efba776e3845b9391e2934d1c642c',
  fn_ca_drift_metrics: 'ce915eaeb1a22626afa9962800e2a904',
  fn_ca_gate_panel: 'afb1a845a440e4851daf85433859bf7e',
  fn_ca_balance_asof_admin: 'a2be83ba8bd5487154ab0fc74e08471f',
} as const;

describe('Drift console database authority', () => {
  it('refuses a stale production preimage before replacing any reader', () => {
    for (const [signature, prosrcHash, definitionHash] of [
      [
        'public.fn_ca_incident_dashboard(text,integer)',
        'd1115881f25c20a16ef0582aa437ef28',
        'f99151acc42a8d6f788779a1ae285a2c',
      ],
      [
        'public.fn_ca_drift_metrics()',
        'aa4e90713542be9b9799f1f554eee171',
        '1c56814b0183603d34e3b868ea0e4d7b',
      ],
      [
        'public.fn_ca_gate_panel()',
        '54c610e78e619d692b52723dea10cb8b',
        '0db0b5d0a7be50219e9b0d75004cffa3',
      ],
      [
        'public.fn_ca_balance_asof_admin(text,uuid,timestamp with time zone)',
        '1929a7587da75dd32e86c66c2640edac',
        'c491fa6a53e967e1bde3b9163b916380',
      ],
    ]) {
      expect(migration).toContain(`'${signature}'::regprocedure`);
      expect(migration).toContain(`'${prosrcHash}'::text`);
      expect(migration).toContain(`'${definitionHash}'::text`);
    }

    expect(migration).toContain("md5(p.prosrc) = '1c2ea9c78ca402a49de131740cd0ed91'");
    expect(migration).toContain(
      "md5(pg_get_functiondef(p.oid)) = 'c4db682ce0dea4c63265dab3d97b83ff'"
    );
    expect(migration).toContain("md5(p.prosrc) = 'a8d8672e0201c8036e326989ea82d05c'");
    expect(migration).toContain(
      "md5(pg_get_functiondef(p.oid)) = 'ed89787c7b832e76a886734e16a27c3d'"
    );
    expect(migration).toContain('DRIFT_CONSOLE_READER_PREIMAGE_CHANGED');
    expect(migration).toContain('DRIFT_CONSOLE_AUTHORITY_DEPENDENCY_CHANGED');
  });

  it('pins the unchanged incident action door that can_act mirrors', () => {
    const actionStart = migration.indexOf(
      "'public.fn_ca_incident_action(uuid,text,text,uuid,text,text)'::regprocedure"
    );
    const actionEnd = migration.indexOf(
      "'public.fn_is_platform_admin()'::regprocedure",
      actionStart
    );
    const actionPreimage = migration.slice(actionStart, actionEnd);

    expect(actionStart).toBeGreaterThan(-1);
    expect(actionEnd).toBeGreaterThan(actionStart);
    expect(actionPreimage).toContain("pg_get_userbyid(p.proowner) = 'postgres'");
    expect(actionPreimage).toContain('AND p.prosecdef');
    expect(actionPreimage).toContain("AND p.provolatile = 'v'");
    expect(actionPreimage).toContain("AND p.prokind = 'f'");
    expect(actionPreimage).toContain("AND p.prorettype = 'jsonb'::regtype");
    expect(actionPreimage).toContain('AND NOT p.proretset');
    expect(actionPreimage).toContain(
      "p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[]"
    );
    expect(actionPreimage).toContain(
      "'{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'"
    );
    expect(actionPreimage).toContain("md5(p.prosrc) = 'e6eb7478051ee1c23500e85b6c14d01e'");
    expect(actionPreimage).toContain(
      "md5(pg_get_functiondef(p.oid)) = '1017987e76a8327b7d379d795a317401'"
    );
  });

  it('pins the exact postimage bodies as well as owner, security, search path and ACL', () => {
    const post = migration.slice(migration.indexOf('DO $post$'));
    for (const [name, expectedHash] of Object.entries(postimageBodyHashes)) {
      expect(md5(functionBody(name))).toBe(expectedHash);
      expect(post, `${name} postimage must pin its exact body hash`).toContain(expectedHash);
      expect(post, `${name} postimage must pin its exact definition hash`).toContain(
        postimageDefinitionHashes[name as keyof typeof postimageDefinitionHashes]
      );
    }

    expect(migration.match(/\nSECURITY DEFINER\n/g)).toHaveLength(5);
    expect(migration.match(/SET search_path TO 'public', 'pg_temp'/g)).toHaveLength(5);
    expect(post.match(/pg_get_userbyid\(p\.proowner\) = 'postgres'/g)).toHaveLength(5);
    expect(post.match(/AND p\.prosecdef/g)).toHaveLength(5);
    expect(post.match(/AND p\.provolatile = 's'/g)).toHaveLength(5);
    expect(post.match(/search_path=public, pg_temp/g)).toHaveLength(5);
    expect(
      post.match(/postgres=X\/postgres,authenticated=X\/postgres,service_role=X\/postgres/g)
    ).toHaveLength(5);
  });

  it('admits only service, platform staff or an active registry row', () => {
    const body = functionBody('fn_ca_can_view_drift_console');
    expect(body).toContain("COALESCE(auth.role(), '') = 'service_role'");
    expect(body).toContain('COALESCE(public.fn_is_platform_admin(), false)');
    expect(body).toContain('FROM public.ca_incident_recipients r');
    expect(body).toContain('r.user_id = auth.uid()');
    expect(body).toContain('r.active');
    expect(body).not.toContain('club_members');
    expect(body).not.toMatch(/FROM public\.unions/);
  });

  it('row-scopes non-platform readers and does not turn platform read access into action access', () => {
    const body = functionBody('fn_ca_incident_dashboard');
    expect(body).toContain('IF NOT public.fn_ca_can_view_drift_console() THEN');
    expect(body).toContain("ERRCODE = '42501'");
    expect(body).toMatch(
      /AND \(\s*v_platform\s*OR \(v_uid IS NOT NULL\s*AND v_uid = ANY \(public\.fn_ca_incident_recipient_ids\(i, false\)\)\)\s*\)/
    );

    const canAct = body.slice(body.indexOf("'can_act'"), body.indexOf("'events'"));
    expect(canAct).toContain('v_service OR');
    expect(canAct).toContain('fn_ca_incident_recipient_ids(i, false)');
    expect(canAct).not.toContain('v_platform');
  });

  it('scopes incident metrics and withholds every global ledger and supply read from scoped recipients', () => {
    const body = functionBody('fn_ca_drift_metrics');
    expect(body).toContain('WITH visible AS MATERIALIZED');
    expect(body).toContain('fn_ca_incident_recipient_ids(i, false)');
    expect(body).toContain("r.scope IN ('platform', 'financial_ops', 'technical')");

    const globalBlock = body.slice(body.indexOf('IF v_global THEN'), body.indexOf('RETURN v;'));
    for (const relation of [
      'public.chip_ledger',
      'public.ca_ledger_write_failures',
      'public.ca_supply_snapshots',
    ]) {
      expect(globalBlock).toContain(relation);
      expect(body.indexOf(relation)).toBeGreaterThan(body.indexOf('IF v_global THEN'));
    }
  });

  it('keeps the burn-in and balance tools global-only and refuses unknown callers loudly', () => {
    for (const name of ['fn_ca_gate_panel', 'fn_ca_balance_asof_admin']) {
      const body = functionBody(name);
      expect(body).toContain('IF NOT public.fn_ca_can_view_drift_console() THEN');
      expect(body).toContain("ERRCODE = '42501'");
      expect(body).toContain("r.scope IN ('platform', 'financial_ops', 'technical')");
      expect(body).toContain('IF NOT v_global THEN RETURN NULL; END IF;');
    }

    expect(migration.match(/ERRCODE = '42501'/g)).toHaveLength(4);
    expect(migration).toContain('UNKNOWN_CALLER_WAS_ADMITTED_TO_DRIFT_CONSOLE');
    expect(migration).toContain('DRIFT_CONSOLE_REFUSAL_PROBE_FAILED');
  });

  it('retains locked table ownership, RLS and service-only direct table access', () => {
    for (const relation of [
      'public.ca_drift_incidents',
      'public.ca_incident_events',
      'public.ca_incident_recipients',
    ]) {
      expect(migration).toContain(`'${relation}'::regclass`);
    }
    expect(migration).toContain("pg_get_userbyid(c.relowner) <> 'postgres'");
    expect(migration).toContain('OR NOT c.relrowsecurity');
    expect(migration).toContain('OR c.relforcerowsecurity');
    expect(migration).toContain("'{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}'");
  });
});

describe('Drift console browser authority', () => {
  it('asks the server capability, accepts literal true only and fails closed', () => {
    expect(gate).toContain("supabase.rpc('fn_ca_can_view_drift_console')");
    expect(gate).toContain('allowed: data === true');
    expect(gate).toContain("reportError(error, 'FinancialAdminGate.drift_console_authority')");
    expect(gate).toMatch(/catch \(error\)[\s\S]*allowed: false/);
    expect(gate).toContain('decision?.userId === activeUserId');
    expect(gate).toContain('if (allowed === null)');
    expect(gate).toContain('<Navigate to="/financial-admin" replace />');
  });

  it('requires a boolean action receipt and renders no unusable action controls', () => {
    expect(service).toContain('can_act: boolean;');
    expect(service).toContain(
      "can_act: booleanValue(row.can_act, 'Drift incident action authority')"
    );
    expect(page).toContain('if (!i.can_act) return [];');
    expect(page).toContain('{incident.can_act ? (');
    expect(page).toContain('Read Only For This Operator');
  });

  it('mounts the incidents page only behind both authentication and the server-backed gate', () => {
    const route = app.slice(
      app.indexOf('path="financial-incidents"'),
      app.indexOf('path="disputes"')
    );
    expect(route).toContain('<AuthGuard>');
    expect(route).toContain('<FinancialAdminGate>');
    expect(route).toContain('<DriftIncidentsPage />');
    expect(route.indexOf('<AuthGuard>')).toBeLessThan(route.indexOf('<FinancialAdminGate>'));
    expect(route.indexOf('<FinancialAdminGate>')).toBeLessThan(
      route.indexOf('<DriftIncidentsPage />')
    );
  });
});
