// Source contracts only. These do not execute or qualify PostgreSQL payouts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  baselineFixture,
  buildCapturePayoutFixture,
} from './leaderboard-capture-payout-fixture-candidate.mjs';

const baseline = readFileSync(baselineFixture, 'utf8');
const sql = buildCapturePayoutFixture(baseline);
test('extended fixture preserves baseline identity, original six cases and single rollback boundary', () => {
  assert.equal(
    createHash('sha256').update(baseline).digest('hex'),
    'a0b05846b457dd22cd2db7200f1f192f1ded1d0a501a901f499c9ab7d057d9f1'
  );
  for (const name of [
    'new_player_zero_baseline_pays',
    'positive_awards_only_for_cent_tie',
    'genuine_empty_close_is_distinct',
    'affiliate_union_promo_pays_once',
    'canonical_monthly_pays_once',
    'affiliate_union_underfunded_refuses',
    'settlement_sql_roles_refuse',
    'insufficient_promo_bank_available_refuses',
    'recipient_failure_rolls_back_then_retries',
  ])
    assert.ok(sql.includes(name));
  assert.equal(sql.match(/^ROLLBACK;$/gm)?.length, 1);
  assert.doesNotMatch(sql, /^COMMIT;|DISABLE TRIGGER|DELETE FROM public\.leaderboard_/m);
  assert.match(sql, /count\(\*\) FROM lb_extended_payout_verdicts\)<>6/);
  assert.match(sql, /session_user<>'leaderboard_qualification_bootstrap'/);
  assert.throws(() => buildCapturePayoutFixture(baseline + '\n'));
});
test('real affiliated funding and monthly canonical branches reconcile both banks and exact journal legs', () => {
  assert.match(sql, /fn_ca_mint\('chips','union',union_id,100/);
  assert.match(sql, /fn_diamond_game_fund_promo\(club,20,'lb_extended_union_fund'\)/);
  assert.match(sql, /fn_leaderboard_period_window\(period_name,-1\)/);
  assert.match(sql, /period_name='monthly' THEN '\[\{"rank":1,"amount":10\}\]'/);
  assert.match(sql, /chip_treasury FROM public\.clubs WHERE id=club\) IS DISTINCT FROM club_bank/);
  assert.match(
    sql,
    /chip_balance FROM public\.union_wallets WHERE union_wallets\.union_id=extended_cases\.union_id\) IS DISTINCT FROM union_bank/
  );
  assert.match(sql, /promo_balance FROM public\.clubs WHERE id=club\) IS DISTINCT FROM club_promo/);
  assert.match(
    sql,
    /from_type=CASE WHEN funding_union IS NULL THEN 'promo_wallet' ELSE 'union_wallet' END/
  );
  assert.match(sql, /pre_from_balance=20 AND post_from_balance=10/);
  assert.match(sql, /to_type='player_wallet'.*post_to_balance-pre_to_balance=10/);
  assert.match(sql, /key=format\('leaderboard:%s:%s:%s:%s',club,period_name,starts,player\)/);
});
test('actual shortage and downstream receipt fault prove whole-statement rollback before same-round retry', () => {
  assert.match(sql, /fn_promo_disburse\('club',club,'player',player,20/);
  assert.match(sql, /chip_treasury>10/);
  assert.match(sql, /failure_state IS DISTINCT FROM 'P0001'/);
  assert.match(
    sql,
    /LEADERBOARD_PROMO_UNDERFUNDED\|Leaderboard Requires 10\.00 Promo Chips But The Recorded Promo Wallet Holds 0\.00/
  );
  assert.match(
    sql,
    /CREATE TRIGGER lb_isolated_recipient_failure BEFORE INSERT ON public\.wallet_transactions/
  );
  assert.match(sql, /count\(\*\) FROM public\.leaderboard_payout_batches\)<>1/);
  assert.match(sql, /count\(\*\) FROM public\.leaderboard_round_basis_receipts\)<>1/);
  assert.match(sql, /sum\(chip_balance\),0\).*IS DISTINCT FROM 10/);
  assert.match(sql, /failure_state IS DISTINCT FROM 'ZLF01'.*ISOLATED_RECIPIENT_RECEIPT_FAILURE/);
  const drop = sql.indexOf('DROP TRIGGER lb_isolated_recipient_failure');
  assert.ok(
    sql.indexOf("RAISE EXCEPTION 'Expected exact refusal did not roll back money and basis'") < drop
  );
  assert.ok(sql.indexOf('response:=public.fn_payout_leaderboard', drop) > drop);
  assert.match(sql, /IS DISTINCT FROM basis_before THEN/);
  assert.match(sql, /replay->>'batch_id' IS DISTINCT FROM response->>'batch_id'/);
});

test('union shortage conserves funds and SQL role refusals precede service settlement', () => {
  assert.match(sql, /fn_union_promo_send\(funding_union,20,'club',club,shortage_op,owner/);
  assert.match(sql, /from_label='union_wallets.promo_wallet'/);
  assert.match(sql, /to_label='clubs.promo_balance' AND amount=20/);
  assert.match(sql, /balance_after=0 AND tx_type='promo_to_club'/);
  assert.match(sql, /IS DISTINCT FROM players_before/);
  assert.match(sql, /failure_state IS DISTINCT FROM '42501'/);
  assert.match(
    sql,
    /ARRAY\[owner::text,player::text,'90000000-0000-4000-8000-000000000005','anon'\]/
  );
  assert.ok(
    sql.indexOf("stage:='sql_role_refusal'") <
      sql.indexOf("stage:='actual_settlement'", sql.indexOf("stage:='sql_role_refusal'"))
  );
  assert.match(sql, /SQL role refusal changed money or basis/);
});
