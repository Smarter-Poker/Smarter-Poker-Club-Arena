import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const read = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const sql = read(
  'supabase/migrations/20261018152437_a_documented_addon_does_not_strand_an_abandoned_misdeal.sql'
);
const prior = read('scripts/ci/probes/f06-shared-hand-lane/abandoned-addon/preimage.sql');
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

describe('a purchased add-on preserves event-owned abandoned-hand recovery', () => {
  it.each(['qualify.py', 'fixture.sql', 'preimage.sql'])(
    'qualifies changed native input %s',
    (name) => {
      expect(
        classifyChangedPaths(['scripts/ci/probes/f06-shared-hand-lane/abandoned-addon/' + name])
      ).toMatchObject({ server: true, tests: true });
    }
  );
  it('changes exactly one reviewed clause of the installed full function', () => {
    const before = prior.split('$function$')[1];
    const oldClause = sql.split('$old$')[1];
    const newClause = sql.split('$new$')[1];
    expect(md5(before)).toBe('e7629cf22c6ef6c52ba3490298979d23');
    expect(before.split(oldClause)).toHaveLength(2);
    const after = before.replace(oldClause, newClause);
    expect(md5(after)).toBe('0753a506f9ef7ac48588c7e8ec3f4721');
    expect(after.replace(newClause, oldClause)).toBe(before);
    expect(sql).toContain("AND md5(prosrc)='0753a506f9ef7ac48588c7e8ec3f4721'");
    expect(newClause).toContain("tp.id = (r->>'registration_id')::uuid");
    expect(newClause).toContain('tp.add_on IS TRUE');
    expect(newClause).toContain('COALESCE(event.addon_chips, 0) > 0');
    expect(newClause).toContain("= (x->>'stack')::numeric + event.addon_chips");
  });

  it('preserves owner, privileges, security, search path and migration drift refusal', () => {
    expect(sql).toContain("p.proowner IS DISTINCT FROM 'postgres'::regrole");
    expect(sql).toContain("'{postgres=X/postgres,service_role=X/postgres}'");
    expect(sql).toContain("ARRAY['search_path=pg_catalog, public, smarter_private']");
    expect(sql).toContain('p.prosecdef IS DISTINCT FROM true');
    expect(sql).toContain('ABANDONED_ADDON_PREIMAGE_DRIFT');
    expect(sql).toContain('ABANDONED_ADDON_CLAUSE_DRIFT');
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).not.toMatch(/UPDATE public\.(table_seats|tournament_players|club_members)/);
  });

  it('runs the full native door in the existing required F06 accounting shard', () => {
    const gate = read('scripts/ci/test-f06-shared-hand-lane.py');
    expect(gate).toContain(
      "addon['qualify'](ROOT, out, cmd, command, run, probe, require, results)"
    );
    expect(gate).toContain("require(results.get('abandonedAddon', {}).get('passed') is True");
    const fixture = read('scripts/ci/probes/f06-shared-hand-lane/abandoned-addon/qualify.py');
    expect(fixture).toContain("error='F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT'");
    expect(fixture).toContain("probe('addon-exact-purchase-passes', success, '1')");
    expect(fixture).toContain("run('addon-player-state-after', money) == before");
    expect(fixture).toContain('addon-identical-receipt-replays');
  });
});
