import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildPromoOpeningCandidate,
  openingPredecessor,
} from './leaderboard-promo-opening-candidate.mjs';
import { buildPromoConfigCandidate } from './leaderboard-promo-config-candidate.mjs';
const draft = readFileSync(
  new URL('./leaderboard-isolated-opening-policy-draft.sql', import.meta.url),
  'utf8'
);
const source = readFileSync(openingPredecessor, 'utf8');
test('eight independent opening cases retain real RPC, exact guards and rollback-only lifecycle', () => {
  const names = [
    ...draft.match(/FOREACH name IN ARRAY ARRAY\[([\s\S]*?)\] LOOP/)[1].matchAll(/'([^']+)'/g),
  ].map((m) => m[1]);
  assert.equal(names.length, 8);
  assert.equal(new Set(names).size, 8);
  assert.match(draft, /session_user<>'leaderboard_qualification_bootstrap'/);
  assert.match(draft, /inet_server_addr\(\) IS NOT NULL/);
  assert.match(draft, /public\.fn_complete_club_opening_setup\(club,operation/);
  assert.match(draft, /SET LOCAL ROLE authenticated/);
  assert.match(draft, /WHEN SQLSTATE 'ZLO01'/);
  assert.equal(draft.match(/^ROLLBACK;$/gm).length, 1);
  assert.doesNotMatch(draft, /^COMMIT;|DISABLE TRIGGER|UPDATE public\.|DELETE FROM public\./m);
  assert.match(draft, /pg_temp\.lb_opening_digest\(\) IS DISTINCT FROM before_image/);
  assert.match(draft, /bank-budget-promo-spin-bbj/);
  assert.match(
    draft,
    /destination='leaderboard_prizes' AND amount=budget AND balance_after=budget\+promo/
  );
  assert.match(draft, /kind='seed' AND amount=spin AND balance_after=spin_before\+spin/);
  assert.match(draft, /kind='activation' AND amount=0/);
  assert.match(draft, /required_seed_at_activation=public.fn_spin_required_seed\(1\)/);
  for (const account of ['club_treasury', 'promo_wallet', 'spin_reserve', 'bbj_pool'])
    assert.ok(draft.includes(`to_type='${account}'`) && draft.includes(`from_type='${account}'`));
  assert.match(draft, /correlation_id=correlation/);
});
test('candidate refusal text and nested publication error match authoritative source', () => {
  const opening = buildPromoOpeningCandidate(source),
    config = buildPromoConfigCandidate(source);
  const refusal = 'LEADERBOARD_PROMO_ONLY|Club Bank Overlay Is Not Allowed For Leaderboard Prizes';
  for (const text of [opening, config, draft]) assert.ok(text.includes(refusal));
  const nested = 'Leaderboard Publication Retry Key Was Reused For Different Prize Rules';
  assert.ok(source.includes(nested) && draft.includes(nested));
  assert.match(draft, /SQLSTATE='22023'/);
  assert.match(draft, /SET CONSTRAINTS ALL IMMEDIATE/);
  assert.match(draft, /count\(\*\) FROM lb_opening_results\)<>8/);
});
