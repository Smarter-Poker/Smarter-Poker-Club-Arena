import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const migrationsDirectory = resolve(root, 'supabase/migrations');
const contractionFiles = readdirSync(migrationsDirectory).filter(
  (file) =>
    file.endsWith('_stage_b_current_postimage_contraction.sql') ||
    file.endsWith('_stage_b_current_postimage_contraction.sql.pending')
);
if (contractionFiles.length !== 1) {
  throw new Error(`expected exactly one staged contraction migration, found ${contractionFiles.length}`);
}
const migration = readFileSync(resolve(migrationsDirectory, contractionFiles[0]), 'utf8');
const probe = readFileSync(
  resolve(root, 'scripts/dev/probe-tournament-manager-stage-b.sql'),
  'utf8'
);

function taggedBody(source: string, tag: string): string {
  const delimiter = `$${tag}$`;
  const start = source.indexOf(delimiter);
  const end = source.indexOf(delimiter, start + delimiter.length);
  expect(start, `opening ${delimiter}`).toBeGreaterThanOrEqual(0);
  expect(end, `closing ${delimiter}`).toBeGreaterThan(start);
  return source.slice(start + delimiter.length, end);
}

const verifiers = [
  {
    name: 'Stage-B migration postcondition',
    body: taggedBody(migration, 'assert_strict_manager_request_fence'),
  },
  {
    name: 'Stage-B executable probe',
    body: taggedBody(probe, 'service_hook_execution_and_private_surface'),
  },
] as const;

const canonicalHook = 'pgrst.db_pre_request=smarter_private.fn_smarter_data_api_pre_request';

describe('Stage-B verifies the PostgREST settings that apply to this API login', () => {
  it.each(verifiers)(
    '$name requires one role-wide canonical hook and no applicable override',
    ({ body }) => {
      expect(body).toContain("WHERE r.rolname = 'authenticator'");
      expect(body).toContain('WHERE d.datname = current_database()');
      expect(body).toContain('s.setdatabase = 0');
      expect(body).toContain('s.setrole = v_authenticator_oid');
      expect(body).toContain(`'${canonicalHook}'`);
      expect(body).toContain('s.setdatabase IN (0, v_current_database_oid)');
      expect(body).toContain('s.setrole IN (0, v_authenticator_oid)');
      expect(body).toContain("setting.value LIKE 'pgrst.db_pre_request=%'");
      expect(body).toMatch(
        /IF\s+v_canonical_global_hook_settings\s*<>\s*1\s+OR\s+v_applicable_hook_settings\s*<>\s*1\s+THEN/i
      );
    }
  );

  it.each(verifiers)(
    '$name scopes private-schema exposure to this database and login',
    ({ body }) => {
      const schemaScanStart = body.indexOf("setting.value LIKE 'pgrst.db_schemas=%'");
      expect(schemaScanStart).toBeGreaterThanOrEqual(0);
      const schemaScan = body.slice(Math.max(0, schemaScanStart - 600), schemaScanStart + 300);
      expect(schemaScan).toContain('s.setdatabase IN (0, v_current_database_oid)');
      expect(schemaScan).toContain('s.setrole IN (0, v_authenticator_oid)');
      expect(schemaScan).toContain("exposed.schema_name = 'smarter_private'");
    }
  );

  it('the exact cardinality gate refuses competing applicable settings but ignores unrelated rows', () => {
    const authenticator = 10;
    const currentDatabase = 20;
    const otherRole = 30;
    const otherDatabase = 40;

    type Row = { database: number; role: number; setting: string };
    const canonical: Row = { database: 0, role: authenticator, setting: canonicalHook };
    const gateAccepts = (rows: Row[]): boolean => {
      const applicable = rows.filter(
        (row) =>
          [0, currentDatabase].includes(row.database) &&
          [0, authenticator].includes(row.role) &&
          row.setting.startsWith('pgrst.db_pre_request=')
      );
      const canonicalGlobal = applicable.filter(
        (row) => row.database === 0 && row.role === authenticator && row.setting === canonicalHook
      );
      return canonicalGlobal.length === 1 && applicable.length === 1;
    };

    expect(gateAccepts([canonical])).toBe(true);
    expect(
      gateAccepts([
        canonical,
        {
          database: currentDatabase,
          role: authenticator,
          setting: 'pgrst.db_pre_request=public.competing_hook',
        },
      ])
    ).toBe(false);
    expect(
      gateAccepts([
        canonical,
        {
          database: currentDatabase,
          role: 0,
          setting: 'pgrst.db_pre_request=public.database_wide_hook',
        },
      ])
    ).toBe(false);
    expect(
      gateAccepts([
        canonical,
        {
          database: currentDatabase,
          role: authenticator,
          setting: canonicalHook,
        },
      ])
    ).toBe(false);
    expect(
      gateAccepts([
        canonical,
        {
          database: otherDatabase,
          role: authenticator,
          setting: 'pgrst.db_pre_request=public.other_database_hook',
        },
        {
          database: currentDatabase,
          role: otherRole,
          setting: 'pgrst.db_pre_request=public.other_login_hook',
        },
      ])
    ).toBe(true);
  });
});
