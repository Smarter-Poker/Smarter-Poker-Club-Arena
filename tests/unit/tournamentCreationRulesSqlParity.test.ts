/**
 * TOURNAMENT CREATION RULES: THE MIGRATION SIDE OF THE PARITY (20260924033701)
 *
 * public.fn_tournament_config_refusal and the client's shared validator
 * (src/lib/tournamentCreationRules.ts) are held to one case table,
 * scripts/ci/fixtures/tournament-creation-rules/cases.json, which
 * scripts/ci/test-tournament-creation-rules.py runs against PostgreSQL and
 * tests/unit/tournamentCreationRules.test.ts runs against the validator. This
 * file holds the assertions that read the migration itself, so they ship with
 * the migration: every refusal the SQL rule can return is in the case table
 * (the client test then maps every case-table code to its sentence), and the
 * migration is pinned to the newest repo definitions of the RPCs it replaces.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const MIGRATION = readFileSync(
  join(
    ROOT,
    'supabase/migrations/20260924033701_tournament_creation_refuses_what_the_client_refuses.sql'
  ),
  'utf8'
);
const CASES = JSON.parse(
  readFileSync(join(ROOT, 'scripts/ci/fixtures/tournament-creation-rules/cases.json'), 'utf8')
).cases as Array<{ surface: 'create' | 'schedule'; expect: string | null }>;

describe('the case table covers every refusal the database can return', () => {
  it('holds every RETURN code of fn_tournament_config_refusal, on both surfaces', () => {
    const returned = new Set(CASES.map((c) => c.expect).filter(Boolean));
    const sqlCodes = [...MIGRATION.matchAll(/RETURN '([a-z_0-9]+)';/g)].map((m) => m[1]);
    expect(sqlCodes.length).toBeGreaterThan(0);
    for (const code of sqlCodes) expect(returned).toContain(code);
    for (const surface of ['create', 'schedule']) {
      expect(CASES.some((c) => c.surface === surface && c.expect === null)).toBe(true);
    }
  });
});

describe('the migration is pinned to the newest repo definitions', () => {
  it('pins the post-images 20260917204152 installed, and the later manifests still carry', () => {
    const base = readFileSync(
      join(
        ROOT,
        'supabase/migrations/20260917204152_mtt_authored_ladders_only_contain_playing_levels.sql'
      ),
      'utf8'
    );
    for (const md5 of ['4c5c8783d1f6f534fdaf5cefbb460d62', 'b8dd7cc8e0996889a936affdc732b664']) {
      expect(base).toContain(md5);
      expect(MIGRATION).toContain(md5);
    }
  });

  it('refuses in both authoring RPCs and nowhere else, and never touches a row', () => {
    expect(MIGRATION).toContain("public.fn_tournament_config_refusal(p_config,'create')");
    expect(MIGRATION).toContain("public.fn_tournament_config_refusal(v_config,'schedule')");
    expect(MIGRATION).toMatch(
      /IF v_config_changed THEN\s+v_refusal := public\.fn_tournament_config_refusal/
    );
    expect(MIGRATION).not.toMatch(/\b(UPDATE|DELETE FROM|INSERT INTO)\s+public\.tournament/);
    expect(MIGRATION).not.toMatch(
      /fn_create_tournament_governed_legacy\(uuid,jsonb\)'::regprocedure/
    );
  });
});
