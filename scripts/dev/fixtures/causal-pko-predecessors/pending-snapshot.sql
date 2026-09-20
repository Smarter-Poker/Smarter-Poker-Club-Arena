BEGIN;
DO $$
DECLARE x jsonb;r jsonb;t uuid;a uuid;b uuid;c uuid;old_debt uuid;ancestor uuid;k record;before_state jsonb;
BEGIN
 x:=fixture_chain(true);t:=(x->>'t')::uuid;a:=(x->>'a')::uuid;b:=(x->>'b')::uuid;c:=(x->>'c')::uuid;
 SELECT * INTO k FROM tournament_knockout_candidates WHERE tournament_id=t AND eliminated_user_id=b;
 r:=fixture_claim_pre_r37(t,b,3,0,k.table_id,k.hand_id,k.hand_number,k.seat_joined_at,c,NULL,0,false);
 old_debt:=(r->>'obligation_id')::uuid;
 PERFORM fixture_assert(r->>'ok'='true' AND old_debt IS NOT NULL,'actual old claim creates stale pending snapshot');
 before_state:=fixture_causal_snapshot(t);
 r:=fn_collect_bounty_obligation(old_debt);
 PERFORM fixture_assert(r->>'ok'='false' AND r->>'reason'='pko_predecessor_not_ready','new collector blocks preexisting stale snapshot before payment');
 PERFORM fixture_assert(before_state IS NOT DISTINCT FROM fixture_causal_snapshot(t),'blocked pending snapshot and money remain unchanged');
 r:=fixture_claim(t,a,b,4);ancestor:=(r->>'obligation_id')::uuid;
 PERFORM fixture_assert(r->>'ok'='true' AND ancestor IS NOT NULL,'exact prior ancestor remains claimable beside later pending head');
 r:=fn_collect_bounty_obligation(ancestor);
 PERFORM fixture_assert(r->>'ok'='true' AND (r->>'paid_cash')::numeric=2.50,'causal ancestor collects despite later snapshot with lower reserved number');
 before_state:=fixture_causal_snapshot(t);
 r:=fn_collect_bounty_obligation(old_debt);
 PERFORM fixture_assert(r->>'ok'='false' AND r->>'reason'='head_snapshot_changed','old immutable snapshot requires explicit correction after incoming carry');
 PERFORM fixture_assert(before_state IS NOT DISTINCT FROM fixture_causal_snapshot(t)
  AND (SELECT head_amount=5 FROM tournament_bounty_obligations WHERE id=old_debt),
  'no automatic resnapshot or speculative downstream payment');
END $$;
ROLLBACK;
