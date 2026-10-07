import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildPromoOpeningCandidate,
  openingPredecessor,
} from './leaderboard-promo-opening-candidate.mjs';
const source = readFileSync(openingPredecessor, 'utf8');
test('new allocation funds actual Promo with unchanged Bank budget and zero new seed', () => {
  const sql = buildPromoOpeningCandidate(source);
  assert.match(sql, /v_other_allocation := v_bbj_seed \+ v_promo_budget \+ v_leaderboard_budget/);
  assert.match(sql, /chip_treasury = COALESCE\(chip_treasury, 0\) - v_other_allocation/);
  assert.match(
    sql,
    /promo_balance = COALESCE\(promo_balance, 0\) \+ v_promo_budget \+ v_leaderboard_budget/
  );
  assert.match(sql, /v_leaderboard_budget,\n    0,\n    p_operation_id/);
  assert.match(sql, /v_leaderboard_budget, v_promo_after, v_actor/);
  assert.match(sql, /'club_opening_allocation'/);
  assert.equal(sql.match(/CREATE OR REPLACE FUNCTION/g).length, 1);
  assert.ok(
    sql.indexOf('IF v_club.owner_id IS DISTINCT FROM v_actor') <
      sql.indexOf('LEADERBOARD_PROMO_ONLY')
  );
  assert.ok(sql.indexOf('RETURN v_result;') < sql.indexOf('LEADERBOARD_PROMO_ONLY'));
  assert.ok(sql.indexOf('LEADERBOARD_PROMO_ONLY') < sql.indexOf('public.fn_spin_activate('));
  assert.doesNotMatch(
    sql,
    /UPDATE public.club_opening_setups|SET leaderboard_seed_remaining|DISABLE TRIGGER/
  );
});
test('historical replay and other allocation owners remain exact; drift refuses', () => {
  const sql = buildPromoOpeningCandidate(source);
  for (const section of [
    '  IF FOUND THEN',
    '  IF p_spins_enabled THEN',
    '  IF p_bbj_enabled THEN',
    '  IF p_promo_enabled THEN',
  ]) {
    const start = source.indexOf(
      section,
      source.indexOf('CREATE FUNCTION public.fn_complete_club_opening_setup(')
    );
    const end = source.indexOf('\n  END IF;', start) + '\n  END IF;'.length;
    assert.ok(sql.includes(source.slice(start, end)));
  }
  assert.throws(() => buildPromoOpeningCandidate(source + '\n'));
});
