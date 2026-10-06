import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const ONE_DOOR = '20261004195024_managed_game_browser_updates_use_command_gateway.sql';
const oneDoor = readFileSync(resolve(MIGRATIONS, ONE_DOOR), 'utf8');
const workflow = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
const classifier = readFileSync(resolve(ROOT, 'scripts/ci/classify-ci-changes.mjs'), 'utf8');
const migrations = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql') || name.endsWith('.sql.pending'))
  .sort()
  .map((name) => ({ name, source: readFileSync(resolve(MIGRATIONS, name), 'utf8') }));

function latestDefinition(functionName: string): { name: string; source: string } {
  const marker = `CREATE OR REPLACE FUNCTION public.${functionName}`;
  let latest: { name: string; source: string } | null = null;

  for (const migration of migrations) {
    const start = migration.source.lastIndexOf(marker);
    if (start < 0) continue;
    const tail = migration.source.slice(start);
    const opening = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(tail);
    if (!opening) throw new Error(`${functionName} in ${migration.name} has no delimiter`);
    const bodyStart = opening.index + opening[0].length;
    const bodyEnd = tail.indexOf(opening[1], bodyStart);
    if (bodyEnd < 0) throw new Error(`${functionName} in ${migration.name} is unterminated`);
    latest = { name: migration.name, source: tail.slice(0, bodyEnd + opening[1].length) };
  }

  if (!latest) throw new Error(`No migration defines ${functionName}`);
  return latest;
}

describe('managed games expose one browser mutation door', () => {
  it('removes row-policy and column-grant paths for direct browser updates', () => {
    expect(oneDoor).toContain('DROP POLICY IF EXISTS "Club admins can update tables"');
    expect(oneDoor).toContain('DROP POLICY IF EXISTS tables_update');
    expect(oneDoor).toMatch(
      /REVOKE UPDATE ON TABLE public\.tables, public\.tournaments\s+FROM PUBLIC, anon, authenticated/
    );
    expect(oneDoor).toContain('has_any_column_privilege');
    expect(oneDoor).toContain("'REVOKE UPDATE (%s) ON TABLE %s FROM PUBLIC, anon, authenticated'");
  });

  it('fails closed unless service_role and the SECURITY DEFINER gateway retain writes', () => {
    expect(oneDoor).toContain("has_table_privilege('service_role', 'public.tables', 'UPDATE')");
    expect(oneDoor).toContain(
      "has_table_privilege('service_role', 'public.tournaments', 'UPDATE')"
    );
    expect(oneDoor).toContain('v_gateway_security_definer');
    expect(oneDoor).toContain("'authenticated', v_gateway, 'EXECUTE'");
    expect(oneDoor).toContain("v_gateway_owner, 'public.tables', 'UPDATE'");
    expect(oneDoor).toContain("v_gateway_owner, 'public.tournaments', 'UPDATE'");
  });

  it('keeps the supported command, receipt, and occupied-table refusal current', () => {
    const gateway = latestDefinition('fn_execute_managed_game_command(');
    const close = latestDefinition('fn_close_managed_game(');

    expect(gateway.source).toContain('public.managed_game_command_receipts');
    expect(gateway.source).toContain('public.fn_close_managed_game(p_kind, p_game_id)');
    expect(gateway.source).toContain('contract_version_before');
    expect(close.source).toContain('FROM public.table_seats ts');
    expect(close.source).toContain('AND ts.left_at IS NULL');
    expect(close.source).toContain("'reason', 'players_seated'");
  });

  it('keeps registered tournament update and close refusals current', () => {
    const update = latestDefinition('fn_update_managed_game(');
    const close = latestDefinition('fn_close_managed_game(');

    for (const definition of [update.source, close.source]) {
      expect(definition).toContain('FROM public.tournament_players tp');
      expect(definition).toMatch(/'reason'\s*,\s*'players_registered'/);
    }
  });

  it('runs the native privilege fixture in hosted PostgreSQL for every input change', () => {
    expect(workflow).toContain('Managed games keep one receipted browser command door');
    expect(workflow).toContain('bash scripts/dev/test-managed-game-one-door-postgres.sh');
    expect(workflow).toContain('MANAGED_GAME_PG_SCRATCH_PARENT: ${{ runner.temp }}');
    expect(classifier).toContain('const managedGameOneDoor =');
    expect(classifier).toContain('tests\\/fixtures\\/managed-game-one-door\\/');
    expect(classifier).toContain('matches(managedGameOneDoor)');
  });
});
