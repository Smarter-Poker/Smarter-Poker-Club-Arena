import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const home = 'scripts/ci/probes/f06-shared-hand-lane/interrupted-postflop/';
const sql = read(
  'supabase/migrations/20261029011340_legacy_postflop_void_preserves_original_principal.sql'
);
const emergency = read(home + 'installed-emergency-preimage.sql');
const floor = read(home + 'floor-prerequisite.sql');
const tagged = (text: string, tag: string) => text.split('$' + tag + '$')[1];
const previous = floor;
const candidate = previous
  .replace(tagged(sql, 'old_locals'), tagged(sql, 'new_locals'))
  .replace(tagged(sql, 'old_admission'), tagged(sql, 'new_admission'));
const digest = (text: string) => createHash('md5').update(text).digest('hex');

describe('an interrupted postflop hand preserves original principal', () => {
  it('requires the exact chronologically preceding recorded emergency and played-clock floor', () => {
    expect(digest(emergency)).toBe('8fb3869ea1cac37357e482a0bb0f661c');
    expect(digest(previous)).toBe('52e7b71547751e500fa10b59185bd456');
    expect(digest(candidate)).toBe('e416f1fa850c85d656ec55ddfae3386d');
    expect(sql).toContain("md5(p.definition) IS DISTINCT FROM '52e7b71547751e500fa10b59185bd456'");
    expect(sql).toContain("md5(candidate)<>'e416f1fa850c85d656ec55ddfae3386d'");
    expect(sql).toContain(
      "p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'"
    );
    expect('20261029011340' > '20261029004521').toBe(true);
  });
  it('requires the actual private capsule assertion and both enabled original consumers before mutation', () => {
    for (const digest of [
      'f2e3f2fafc943a88344a328fb98c0d69',
      'fa19e52c7125723d01af8f5cf5244d68',
      '9fa0857dd8cbfb3b27bc0e1951bdb1c7',
    ])
      expect(sql).toContain("md5(prosrc)='" + digest + "'");
    expect(sql).toContain(
      "to_regprocedure('smarter_private.assert_hand_continuation_disposition(uuid,bigint)')"
    );
    expect(sql).toContain(
      "tgname='f06_retained_submission_guard' AND NOT tgisinternal AND tgenabled='O'"
    );
    expect(sql).toContain(
      "tgname='hand_submission_snapshot_guard' AND NOT tgisinternal AND tgenabled='O'"
    );
    expect(sql).toContain(
      "tgfoid=to_regprocedure('smarter_private.f06_retained_submission_guard()')"
    );
    expect(sql).toContain(
      "tgfoid=to_regprocedure('smarter_private.hand_submission_snapshot_guard()')"
    );
    expect(sql.indexOf('INTERRUPTED_POSTFLOP_CONTINUATION_CONTRACT_UNPROVEN')).toBeLessThan(
      sql.indexOf('EXECUTE candidate;')
    );
    const proof = read(home + 'qualify.py');
    for (const name of [
      'postflop-unhardened-floor-alone-baseline-installs',
      'postflop-floor-alone-cannot-install',
      'missing-capsule-assertion',
      'missing-permit-guard',
      'disabled-permit-guard',
      'disabled-snapshot-guard',
      'noop-capsule-assertion',
    ])
      expect(proof).toContain(name);
  });
  it('preserves both previous owners complete body outside the two exact insertions', () => {
    const restored = candidate
      .replace(tagged(sql, 'new_locals'), tagged(sql, 'old_locals'))
      .replace(tagged(sql, 'new_admission'), tagged(sql, 'old_admission'));
    expect(restored).toBe(previous);
    expect(candidate).toContain('h.hand_number = 51229078');
    expect(candidate).toContain('A RECOVERED OLDER HAND DOES NOT REWIND A PLAYED LATER LEVEL.');
    expect(sql).toContain('restored IS DISTINCT FROM prior');
  });
  it('runs native causality, modern-capsule refusal and floor composition in the existing required runner', () => {
    const runner = read('scripts/ci/test-f06-shared-hand-lane.py');
    expect(runner).toContain('interrupted-postflop/qualify.py');
    expect(runner).toContain(
      "interrupted['qualify'](ROOT, out, cmd, command, run, probe, require, results)"
    );
    expect(runner).toContain("results.get('interruptedPostflop', {}).get('passed') is True");
    const proof = read(home + 'qualify.py');
    for (const name of [
      'postflop-fails-before',
      'postflop-floor-required',
      'postflop-bad-sibling-atomic-rollback',
      'postflop-no-partial-disposition',
      'postflop-concurrent-same-receipt-replays',
      'postflop-late-commit-fenced',
      'postflop-retained-modern-original-refuses',
      'postflop-capsule-refusal-is-atomic',
      'postflop-preserves-higher-played-clock-floor',
    ]) {
      expect(proof).toContain(name);
    }
    const contract = read(home + 'capsule-disposition-contract.sql');
    expect(contract).toContain('PRIMARY KEY (table_id, hand_number)');
    expect(contract).toContain(
      "IF d <> 'disposed' THEN RAISE EXCEPTION 'HAND_CONTINUATION_UNSETTLED'"
    );
    expect(contract).toContain(
      'PERFORM smarter_private.assert_hand_continuation_disposition(NEW.table_id, NEW.hand_number)'
    );
  });
});
