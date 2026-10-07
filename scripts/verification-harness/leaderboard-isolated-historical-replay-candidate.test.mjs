import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const sql = readFileSync(
  new URL('./leaderboard-isolated-historical-replay-candidate.sql', import.meta.url),
  'utf8'
);
const source = readFileSync(
  new URL(
    '../../supabase/migrations/20260923143157_the_opening_seed_funds_round_one_and_an_owner_may_allow_a_cl.sql',
    import.meta.url
  ),
  'utf8'
);
test('two-stage historical recovery uses the pinned original real opening and durable evidence', () => {
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    '2cdd4a18c315290da99012c98dc244996db4de4799ffa738d11a5c82a3b88840'
  );
  assert.match(sql, /\\if :historical_before/);
  assert.equal(sql.match(/^COMMIT;$/gm).length, 1);
  assert.equal(sql.match(/^ROLLBACK;$/gm).length, 1);
  assert.match(sql, /session_user<>'leaderboard_qualification_bootstrap'/);
  assert.match(sql, /inet_server_addr\(\) IS NOT NULL/);
  assert.match(sql, /leaderboard_seed_remaining[^\n]*IS DISTINCT FROM 100/);
  assert.match(sql, /chip_treasury[^\n]*IS DISTINCT FROM 99900/);
  assert.match(sql, /promo_balance[^\n]*IS DISTINCT FROM 0/);
  assert.doesNotMatch(
    sql,
    /INSERT INTO public\.|UPDATE public\.|DELETE FROM public\.|DISABLE TRIGGER/
  );
  assert.match(sql, /opening_replay IS DISTINCT FROM proof.opening_replay/);
  assert.match(sql, /publication_replay IS DISTINCT FROM proof.publication_replay/);
  assert.match(sql, /digest\(\) IS DISTINCT FROM proof.image/);
});
test('candidate identities and exact new-overlay refusal cannot silently reuse predecessor', () => {
  for (const pin of ['578960fee3c325b9c724e976bed968f4', 'ef4ab9935eb3681ba4f1ab068a8b65fd'])
    assert.ok(sql.includes(`='${pin}'`) && sql.includes(`       <>'${pin}'`));
  for (const argument of ['candidate_opening_body_md5', 'candidate_publish_body_md5'])
    assert.ok(sql.includes(`:'${argument}'`));
  assert.match(sql, /EXCEPTION WHEN SQLSTATE '22023'/);
  assert.match(sql, /IF NOT rejected OR/);
  assert.match(sql, /SET CONSTRAINTS ALL IMMEDIATE/);
  assert.match(source, /IF FOUND THEN[\s\S]*?'already_completed', true/);
  assert.ok(
    sql.includes('LEADERBOARD_PROMO_ONLY|Club Bank Overlay Is Not Allowed For Leaderboard Prizes')
  );
});
