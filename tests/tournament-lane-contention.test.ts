import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = '20261011185301_busy_tournament_lanes_return_lock_contention_to_their_caller.sql';
const migration = readFileSync(`supabase/migrations/${file}`, 'utf8');
const fixtures = JSON.parse(
  readFileSync('scripts/dev/fixtures/tournament-lane-contention-preimages.json', 'utf8')
);
const driver = readFileSync('scripts/dev/test-tournament-lane-contention.py', 'utf8');
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

describe('Tournament contention qualification', () => {
  it('changes exactly nine error codes on seven complete captured definitions', () => {
    expect(fixtures).toHaveLength(7);
    let changes = 0;
    for (const row of fixtures) {
      expect(md5(row.definition)).toBe(row.definition_hash);
      const ticket = row.signature.includes('with_ticket_for');
      const pattern = ticket
        ? /(RAISE EXCEPTION '(?:ticket admission tournament cache changed|tournament-entry ticket changed during admission)'\s+USING ERRCODE=)'40001'/g
        : /(RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE'\s+USING ERRCODE=)'40001'/g;
      const count = [...row.definition.matchAll(pattern)].length;
      expect(count).toBe(ticket || row.signature.includes('source_guard') ? 2 : 1);
      const post = row.definition.replace(pattern, `$1'${ticket ? '55000' : '55P03'}'`);
      expect(migration).toContain(`'${row.definition_hash}','${md5(post)}'`);
      expect(migration).toContain(`= '${md5(post)}'`);
      changes += count;
    }
    expect(changes).toBe(9);
  });

  it('pins exact qualified bytes and executes native checks in the required accounting lane', () => {
    const hash = createHash('sha256').update(migration).digest('hex');
    expect(driver).toContain(`require_hash = '${hash}'`);
    expect(workflow).toMatch(
      /if: matrix.shard == 1\n {8}env:\n {10}PG_BIN: \/usr\/lib\/postgresql\/17\/bin\n {8}run: python3 scripts\/dev\/test-tournament-lane-contention.py --output/
    );
    for (const witness of [
      'before-',
      'after-',
      'cancelled-hand-still-fenced',
      'aborted-hand-still-fenced',
      'all-probes-rolled-back',
      'preimage-drift-refused',
      'metadata-preserved',
    ]) {
      expect(driver).toContain(witness);
    }
  });

  it('keeps installation atomic and rejects unknown definitions or altered metadata', () => {
    expect(migration).toMatch(/BEGIN;[\s\S]*COMMIT;\s*$/);
    expect(migration).toContain("SET LOCAL lock_timeout='2s'");
    expect(migration).toContain('back IS DISTINCT FROM d');
    expect(migration).toContain('md5(d)<>r.preimage');
    expect(migration).toContain('proacl IS NOT DISTINCT FROM acl_before');
    expect(migration.match(/@live-proof:/g)).toHaveLength(7);
    expect(migration).not.toMatch(/\b(?:GRANT|REVOKE|INSERT INTO|DELETE FROM|UPDATE public\.)\b/);
  });
});
