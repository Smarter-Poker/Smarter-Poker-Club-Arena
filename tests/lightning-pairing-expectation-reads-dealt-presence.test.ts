import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const MIGRATION =
  'supabase/migrations/20261019174213_lightning_pairing_expectation_reads_dealt_presence.sql';
const PROOF = 'scripts/ci/test-lightning-pairing-expectation-reads-dealt-presence.py';

describe('the Lightning pairing expectation reads dealt presence, not open sessions', () => {
  it('runs the native RED/GREEN proof inside a required accounting step', () => {
    expect(read('.github/workflows/ci.yml')).toContain(
      'run: python3 -B scripts/ci/test-settlement-suspense-restatement.py'
    );
    expect(read('scripts/ci/test-settlement-suspense-restatement.py')).toContain(
      "scripts/ci/test-lightning-pairing-expectation-reads-dealt-presence.py')], check=True)"
    );
    const proof = read(PROOF);
    expect(proof).toContain("LIVE = '342b9ff5021fe5e0df25c18dc5641149'");
    expect(proof).toContain('RED should flag all 28 stall pairs high');
    expect(proof).toContain('assert pairing(env, STALL) == []');
    expect(proof).toContain("found[0]['severity'] == 'high' and ev['expectation'] == LABEL");
    expect(proof).toContain('lightning_pairing_expectation_preimage_refused');
  });

  it('replaces only the session-sized pool with ten-minute dealt strata', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("'342b9ff5021fe5e0df25c18dc5641149','5454a3674ac80ebd920507464d224de5'");
    expect(sql).toContain(
      "@live-proof: (SELECT md5(pg_get_functiondef('public.fn_lightning_integrity_scan(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='5454a3674ac80ebd920507464d224de5')"
    );
    const replacement = sql.slice(sql.lastIndexOf('ARRAY['));
    expect(replacement).toContain("c_pair_stratum   constant interval := interval '10 minutes'");
    expect(replacement).toContain('sum(x.k::numeric * y.k / st.n) AS expected');
    expect(replacement).toContain("'pairing_expectation', 'dealt_presence_10m'");
    expect(replacement).not.toContain('lightning_pool_session');
    expect(sql).toContain('lightning_pairing_expectation_postimage_or_security_refused');
    expect(sql).not.toMatch(/is_horse|horse_id/);
    expect(sql).not.toMatch(/^\s*(UPDATE\s+\S+\s+SET|DELETE\s+FROM|INSERT\s+INTO)\b/im);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
