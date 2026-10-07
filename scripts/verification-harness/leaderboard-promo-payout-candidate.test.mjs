import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildPromoPayoutCandidate, predecessor } from './leaderboard-promo-payout-candidate.mjs';
const source = readFileSync(predecessor, 'utf8');
test('candidate preserves historical receipt and serializes before replay while using only Promo', () => {
  const sql = buildPromoPayoutCandidate(source);
  assert.ok(sql.indexOf('pg_advisory_xact_lock') < sql.indexOf('SELECT batch.*'));
  assert.match(sql, /'seed_funded', v_existing.seed_funded/);
  assert.match(sql, /'overlay_funded', v_existing.overlay_funded/);
  assert.match(sql, /WHERE winners.amount > 0/);
  assert.match(sql, /v_total, 0, v_promo_debit, 0, jsonb_array_length/);
  assert.doesNotMatch(
    sql,
    /club_opening_setups|chip_treasury|DISABLE TRIGGER|REVOKE|GRANT EXECUTE/
  );
  assert.match(sql, /Exact payout predecessor security\/body drift/);
  assert.match(sql, /Disposable bootstrap socket required/);
  assert.equal(sql.match(/CREATE OR REPLACE FUNCTION/g).length, 1);
});
test('whole reviewed input and unique extraction fail closed', () => {
  for (const changed of [
    source + '\n',
    source.replace('FROM winners;', 'FROM winners LIMIT 1;'),
    source.replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION'),
  ]) {
    assert.throws(() => buildPromoPayoutCandidate(changed));
  }
});
test('complete basis ranking and immutable program receipt precede Promo row locks', () => {
  const sql = buildPromoPayoutCandidate(source);
  assert.match(sql, /fn_leaderboard_complete_round_basis\(p_club_id, p_period, v_start, v_end\)/);
  assert.match(sql, /basis_version' = 'legacy_v1'/);
  assert.match(sql, /v_basis -> 'complete' = 'true'::jsonb/);
  assert.match(
    sql,
    /FROM public.fn_club_leaderboard_by_dates\(p_club_id, p_metric, v_start, v_end, 1000000, 0\) ranked/
  );
  assert.equal(sql.match(/FROM public.fn_club_leaderboard_by_dates/g).length, 1);
  assert.doesNotMatch(sql, /WITH deltas AS|CASE p_metric|rank\(\) OVER/);
  assert.ok(
    sql.indexOf('FROM public.fn_club_leaderboard_by_dates') < sql.indexOf('WHERE ranked.qualified')
  );
  assert.match(sql, /INSERT INTO public.leaderboard_round_basis_receipts/);
  assert.ok(
    sql.indexOf('INSERT INTO public.leaderboard_round_basis_receipts') <
      sql.indexOf('FROM public.union_wallets wallet')
  );
  assert.match(
    sql,
    /v_basis, md5\(v_basis::text\), v_board, md5\(v_board::text\), v_winners, md5\(v_winners::text\)/
  );
  assert.doesNotMatch(sql, /ON CONFLICT|UPDATE public.leaderboard_round_basis_receipts/);
  assert.throws(() => buildPromoPayoutCandidate(source, 'unreviewed ranking'));
});
